// ENG-105 M3 messaging-core golden path (TDD §12/§13 exit gate): the M3 feature
// surface driven end-to-end over the REAL PRODUCTION stack — a real msgd server
// (Postgres testcontainer + subprocess uvicorn) serving the built SPA, the /v1
// API, and the /v1/ws WebSocket from ONE origin, on uvicorn's DEFAULT `websockets`
// backend (ENG-92 — NO `--ws` override), exactly what a real self-host runs.
//
// The flow, as one owner + one invited second member (ENG-112 auto-joins the
// invitee to #general, so they are a live WS participant AND a resolvable
// @mention / DM target the moment the owner's browser pulls meta):
//
//   login → send → REACT (chip) → EDIT (edited marker) → DELETE (tombstone) →
//   REPLY IN THREAD (thread pane + reply renders) → @MENTION (resolves against the
//   directory projection) → CREATE A CHANNEL → START A DM →
//   and the SECOND browser context sees the live updates (message + reaction +
//   thread reply) via real WS fanout.
//
// Focused golden path, not an exhaustive UI suite. Uses the ENG-102/103/104
// data-testids. serverctl.py bootstraps the owner + #general + the invited second
// member before the browsers run.

import { expect, test, type Locator, type Page } from '@playwright/test'

// Matches serverctl.py's bootstrap identities.
const OWNER = { email: 'owner@example.com', password: 'correct-horse-battery-staple' }
const SECOND = { email: 'second@example.com', password: 'correct-horse-battery-staple-2' }

const WS_TIMEOUT = 20_000

/** Log in `who` and land on the authed shell (sidebar populated). */
async function login(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto('/login')
  await page.fill('[data-test="email"]', who.email)
  await page.fill('[data-test="password"]', who.password)
  await page.click('[data-test="submit"]')
  await expect(page.locator('[data-testid="sidebar-channel"]').first()).toBeVisible({
    timeout: 30_000,
  })
}

/** Open #general (the first channel) and wait for its message list. */
async function openGeneral(page: Page): Promise<void> {
  await page.locator('[data-testid="sidebar-channel"]').first().click()
  await expect(page.getByTestId('message-list')).toBeVisible()
}

/** The main-list message row carrying `text` (scoped OUT of the thread pane). */
function mainRow(page: Page, text: string): Locator {
  return page.getByTestId('message-list').getByTestId('message-row').filter({ hasText: text })
}

/** Type `text` into the main composer and send it. */
async function sendMain(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').click()
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-send').click()
}

/**
 * Reveal a message row's hover toolbar and click one of its buttons. The toolbar
 * is `hidden group-hover:flex`, so we hover the row first; the button lives inside
 * the same `group`, so moving the pointer onto it keeps the toolbar open.
 */
async function toolbarClick(row: Locator, testid: string): Promise<void> {
  await row.hover()
  await row.getByTestId(testid).first().click()
}

test('m3 messaging core: react · edit · delete · thread · mention · channel · dm + live fanout', async ({
  browser,
}) => {
  // --- ctx1: the owner; ctx2: the invited second member ----------------------
  const ctx1 = await browser.newContext()
  const page1 = await ctx1.newPage()
  await login(page1, OWNER)
  await openGeneral(page1)

  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  await login(page2, SECOND)
  await openGeneral(page2)

  const stamp = Date.now()

  // --- 1) Owner sends a message; ctx2 sees it LIVE (WS fanout: message) -------
  const rootText = `root message ${stamp}`
  await sendMain(page1, rootText)
  await expect(mainRow(page1, rootText).getByTestId('message-text')).toBeVisible({
    timeout: WS_TIMEOUT,
  })
  await expect(mainRow(page2, rootText)).toBeVisible({ timeout: WS_TIMEOUT })

  // --- 2) React to it → chip appears; ctx2 sees the chip LIVE (WS: reaction) --
  await toolbarClick(mainRow(page1, rootText), 'reaction-quick') // 👍 quick reaction
  await expect(mainRow(page1, rootText).getByTestId('reaction-chip')).toBeVisible()
  await expect(mainRow(page2, rootText).getByTestId('reaction-chip')).toBeVisible({
    timeout: WS_TIMEOUT,
  })

  // --- 3) Edit a message → "(edited)" marker + new text -----------------------
  const editText = `to be edited ${stamp}`
  await sendMain(page1, editText)
  await expect(mainRow(page1, editText).getByTestId('message-text')).toBeVisible()
  await toolbarClick(mainRow(page1, editText), 'message-edit')
  // Once the row flips to edit mode its text becomes a <textarea> VALUE (not in
  // textContent), so the hasText row filter no longer matches — scope the inline
  // editor to the list, where exactly one row is editing at a time.
  const editedText = `EDITED ${stamp}`
  const list = page1.getByTestId('message-list')
  await list.getByTestId('message-edit-input').fill(editedText)
  await list.getByTestId('message-edit-save').click()
  const editedRow = mainRow(page1, editedText)
  await expect(editedRow.getByTestId('edited-marker')).toBeVisible()
  await expect(editedRow.getByTestId('message-text')).toHaveText(editedText)

  // --- 4) Delete another message → tombstone (soft-delete, redacted) ----------
  const delText = `to be deleted ${stamp}`
  await sendMain(page1, delText)
  await expect(mainRow(page1, delText).getByTestId('message-text')).toBeVisible()
  await toolbarClick(mainRow(page1, delText), 'message-delete')
  // The confirm block renders inside the row; confirm the soft-delete.
  await mainRow(page1, delText).getByTestId('message-delete-confirm-yes').click()
  await expect(page1.getByTestId('message-list').getByTestId('message-tombstone')).toBeVisible()

  // --- 5) Reply in thread → pane opens, reply renders -------------------------
  await toolbarClick(mainRow(page1, rootText), 'reply-in-thread')
  await expect(page1.getByTestId('thread-pane')).toBeVisible()
  const replyText = `threaded reply ${stamp}`
  const threadComposer = page1.getByTestId('thread-composer')
  await threadComposer.getByTestId('composer-input').click()
  await threadComposer.getByTestId('composer-input').fill(replyText)
  await threadComposer.getByTestId('composer-send').click()
  await expect(
    page1.getByTestId('thread-pane').getByTestId('thread-reply').filter({ hasText: replyText }),
  ).toBeVisible()

  // ctx2 sees the thread grow LIVE: the root now shows its reply-count affordance.
  await expect(mainRow(page2, rootText).getByTestId('thread-affordance')).toBeVisible({
    timeout: WS_TIMEOUT,
  })
  await page1.getByTestId('thread-close').click()

  // --- 6) @mention a user → the popup resolves against the directory projection
  await page1.getByTestId('composer-input').click()
  await page1.getByTestId('composer-input').pressSequentially('@Sec', { delay: 40 })
  // The popup is appended to <body> (data-testid mention-popup) with the option list.
  const option = page1.getByTestId('mention-option').filter({ hasText: 'Second' })
  await expect(option).toBeVisible({ timeout: WS_TIMEOUT })
  await option.first().click()
  const mentionTail = `mention-${stamp}`
  await page1.getByTestId('composer-input').pressSequentially(` ${mentionTail}`, { delay: 20 })
  await page1.getByTestId('composer-send').click()
  // The sent message renders with the resolved @mention chip as inert text.
  const mentionRow = mainRow(page1, mentionTail)
  await expect(mentionRow).toBeVisible({ timeout: WS_TIMEOUT })
  await expect(mentionRow.getByTestId('message-text')).toContainText('@Second')

  // --- 7) Create a channel → the store switches to it (header shows the name) -
  const chanName = `proj-${stamp}`
  await page1.getByTestId('open-create-channel').click()
  await expect(page1.getByTestId('create-channel')).toBeVisible()
  await page1.getByTestId('create-channel-name').fill(chanName)
  await page1.getByTestId('create-channel-submit').click()
  await expect(page1.getByTestId('create-channel')).toBeHidden()
  await expect(page1.getByTestId('channel-header')).toContainText(chanName)
  await expect(page1.getByTestId('sidebar-channel').filter({ hasText: chanName })).toBeVisible()

  // --- 8) Start a DM with the second member → a DM stream appears -------------
  // The owner starts with no DMs. A DM stream's name is server-null; ENG-149
  // resolves the row label tab-side to the OTHER participant's display name
  // (from the DM's own cached `dm.created`).
  await expect(page1.getByTestId('sidebar-dm')).toHaveCount(0)
  await page1.getByTestId('open-new-dm').click()
  await expect(page1.getByTestId('new-dm')).toBeVisible()
  await page1.getByTestId('new-dm-filter').fill('Second')
  await page1.getByTestId('new-dm-user').filter({ hasText: 'Second' }).first().click()
  await expect(page1.getByTestId('new-dm')).toBeHidden()
  await expect(page1.getByTestId('sidebar-dm')).toHaveCount(1)
  // ENG-149: the row is labeled by the participant's name once the DM's genesis
  // event lands in the local cache (WS fanout / newest-page pull) — never the id.
  await expect(page1.getByTestId('sidebar-dm')).toContainText('Second', { timeout: WS_TIMEOUT })
  // Sidebar restructure: DM rows carry NO presence dot (presence lives on
  // message rows + the footer card instead).
  await expect(page1.getByTestId('sidebar-dm').getByTestId('presence-dot')).toHaveCount(0)
  // Creating the DM switched to it — the conversation header shows the name too.
  await expect(page1.getByTestId('channel-header')).toContainText('Second', {
    timeout: WS_TIMEOUT,
  })

  // --- 9) Composer formatting smoke: a bulleted list ROUND-TRIPS --------------
  // Toolbar toggles the list (pressed state on), Enter splits a new item instead
  // of sending, and the SENT message renders a real <ul><li> (markdown source →
  // MessageBody), not literal "- " text.
  const itemA = `fmt-alpha-${stamp}`
  const itemB = `fmt-beta-${stamp}`
  await page1.getByTestId('composer-input').click()
  await page1.getByTestId('composer-format-bulletList').click()
  await expect(page1.getByTestId('composer-format-bulletList')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page1.keyboard.type(itemA)
  await page1.keyboard.press('Enter') // inside a list: new item, NOT send
  await page1.keyboard.type(itemB)
  await page1.getByTestId('composer-send').click()
  const fmtRow = mainRow(page1, itemA)
  await expect(fmtRow).toBeVisible({ timeout: WS_TIMEOUT })
  await expect(fmtRow.getByTestId('message-text').locator('ul > li')).toHaveText([itemA, itemB])

  await ctx1.close()
  await ctx2.close()
})
