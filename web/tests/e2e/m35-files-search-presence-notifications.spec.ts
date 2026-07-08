// ENG-130 M3.5 exit-gate golden paths (TDD §12): the M3.5 feature surface —
// files/attachments (ENG-117/118/121), search (ENG-122/126/127), presence +
// typing (ENG-125/128), and notifications + mark-read (ENG-123/129) — driven
// end-to-end over the REAL PRODUCTION stack: a real msgd server (Postgres
// testcontainer + subprocess uvicorn) serving the built SPA, the /v1 API, and
// the /v1/ws WebSocket from ONE origin, on uvicorn's DEFAULT `websockets`
// backend (ENG-92 — no `--ws` override), exactly what a real self-host runs.
//
// Four focused tests, each standing up its own browser context(s):
//
//   1. FILES    — attach a text file via the hidden `attach-file-input`, send,
//                 the message renders the `attachment-file` card; Download
//                 round-trips the worker blob path (`client.files.download` →
//                 one-shot local `blob:` URL → a real browser download whose
//                 BYTES equal the upload). Then an image attachment renders its
//                 server WEBP thumbnail (`attachment-image`) from a worker
//                 `blob:` URL — never a server HTTP URL in the DOM (the token
//                 boundary the AttachmentImage doc promises).
//   2. SEARCH   — send a message carrying a distinctive token, open the search
//                 overlay from `topbar-search`, type the token: a
//                 `search-result` appears with the term <mark>-highlighted
//                 (XSS-safe segments, never v-html), and `search-jump` lands on
//                 that message in the conversation.
//   3. PRESENCE + TYPING (two browsers) — the owner sees the second member's
//                 `presence-dot` flip ONLINE on their message row (ephemeral WS
//                 presence — never persisted, §3.3/D3), and sees the
//                 "Second is typing…" `typing-indicator` while the second
//                 member types in the shared channel.
//   4. NOTIFICATIONS (two browsers) — the owner @mentions the second member in
//                 #general while the second member is on the Inbox view (no
//                 active conversation): an in-app `notification-toast` appears
//                 AND the sidebar's #general row grows a `mention-badge`;
//                 opening #general marks it read (ENG-123 read-state) and the
//                 badge clears. The OS-level `Notification` API is permission-
//                 gated and NOT grantable headless — the in-app toast is the
//                 asserted path (the browser Notification is fired behind the
//                 exact same `shouldNotify` matrix, unit-covered in
//                 stores/notifications.spec.ts).
//
// Focused golden paths, not an exhaustive UI suite. Uses the current Ranin
// data-testids; serverctl.py bootstraps the owner + #general + the invited
// second member before the browsers run (same harness as the ENG-83/105 specs).

import { readFileSync } from 'node:fs'

import { expect, test, type Locator, type Page } from '@playwright/test'

// Matches serverctl.py's bootstrap identities.
const OWNER = { email: 'owner@example.com', password: 'correct-horse-battery-staple' }
const SECOND = { email: 'second@example.com', password: 'correct-horse-battery-staple-2' }

const WS_TIMEOUT = 20_000

// A real 1×1 red PNG (valid raster → the server renders a WEBP thumbnail; the
// bomb guard only rejects OVERSIZED sources, and `thumbnail()` never upscales).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

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
 * Attach one in-memory file through the hidden `attach-file-input`, wait for its
 * pending chip to reach phase `done` (the send gate blocks until every upload
 * has settled), then send with `text`.
 */
async function sendWithAttachment(
  page: Page,
  text: string,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await page.getByTestId('attach-file-input').setInputFiles(file)
  await expect(page.locator('[data-testid="composer-attachment"][data-phase="done"]')).toBeVisible({
    timeout: WS_TIMEOUT,
  })
  await sendMain(page, text)
}

test('m3.5 files: attach → send → card renders → download round-trips bytes → image thumbnail', async ({
  browser,
}) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await login(page, OWNER)
  await openGeneral(page)

  const stamp = Date.now()

  // --- 1) A non-image file → the attachment CARD renders on the sent message --
  const fileText = `file drop ${stamp}`
  const notes = `attachment payload ${stamp}\n`
  await sendWithAttachment(page, fileText, {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(notes, 'utf-8'),
  })
  const fileRow = mainRow(page, fileText)
  await expect(fileRow.getByTestId('attachment-file')).toBeVisible({ timeout: WS_TIMEOUT })
  await expect(fileRow.getByTestId('attachment-file-name')).toHaveText('notes.txt')

  // --- 2) Download → the worker blob path fires a REAL browser download whose
  //        bytes equal the upload (client.files.download → one-shot blob: URL).
  const downloadPromise = page.waitForEvent('download')
  await fileRow.getByTestId('attachment-download').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('notes.txt')
  const savedPath = await download.path()
  expect(savedPath).not.toBeNull()
  expect(readFileSync(savedPath, 'utf-8')).toBe(notes)

  // --- 3) An image file → the server thumbnail renders inline, from a worker
  //        blob: URL only (the token/URL boundary — never a server HTTP path).
  const imageText = `image drop ${stamp}`
  await sendWithAttachment(page, imageText, {
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  })
  const imageRow = mainRow(page, imageText)
  const thumb = imageRow.getByTestId('attachment-image')
  await expect(thumb).toBeVisible({ timeout: WS_TIMEOUT })
  const src = await thumb.getAttribute('src')
  expect(src).toMatch(/^blob:/)

  await ctx.close()
})

test('m3.5 search: distinctive token → overlay → highlighted hit → jump lands on the message', async ({
  browser,
}) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await login(page, OWNER)
  await openGeneral(page)

  // A single FTS-friendly token (no punctuation — one tsvector lexeme).
  const token = `zxqfinder${Date.now()}`
  await sendMain(page, `searchable message ${token}`)
  await expect(mainRow(page, token).getByTestId('message-text')).toBeVisible({
    timeout: WS_TIMEOUT,
  })

  // Open the overlay from the top bar and search for the token. The hit comes
  // from the SERVER's readable-scoped FTS (the one HTTP read, made worker-side),
  // so the send must have settled server-side first — retype to retry the (one
  // debounced) search until the index catches up, bounded by attempts.
  await page.getByTestId('topbar-search').click()
  await expect(page.getByTestId('search-overlay')).toBeVisible()
  const input = page.getByTestId('search-input')
  const hit = page.getByTestId('search-result').first()
  let found = false
  for (let attempt = 0; attempt < 8 && !found; attempt++) {
    await input.fill('')
    await input.fill(token)
    found = await hit
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
  }
  expect(found, `no search hit for ${token} after retries`).toBe(true)

  // The matched term is <mark>-highlighted (plain text segments — never v-html).
  await expect(hit.locator('mark')).toContainText(token)

  // Jump → overlay closes, the conversation shows that message.
  await hit.getByTestId('search-jump').click()
  await expect(page.getByTestId('search-overlay')).toBeHidden()
  await expect(mainRow(page, token).getByTestId('message-text')).toBeVisible({
    timeout: WS_TIMEOUT,
  })

  await ctx.close()
})

test('m3.5 presence + typing: A sees B online (presence dot) and sees B typing live', async ({
  browser,
}) => {
  // ctx1: the owner (observer); ctx2: the invited second member (actor).
  const ctx1 = await browser.newContext()
  const page1 = await ctx1.newPage()
  await login(page1, OWNER)
  await openGeneral(page1)

  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  await login(page2, SECOND)
  await openGeneral(page2)

  // --- 1) B posts → A's row for it carries B's presence dot, ONLINE ----------
  // (Ephemeral WS presence only — the store's default is offline until the
  // worker's presence push says otherwise, so `data-status="online"` proves the
  // live frame arrived; nothing about presence is ever persisted or pulled.)
  const probe = `presence probe ${Date.now()}`
  await sendMain(page2, probe)
  const probeRow = mainRow(page1, probe)
  await expect(probeRow.getByTestId('message-text')).toBeVisible({ timeout: WS_TIMEOUT })
  await expect(probeRow.getByTestId('presence-dot')).toHaveAttribute('data-status', 'online', {
    timeout: WS_TIMEOUT,
  })

  // --- 2) B types in the shared channel → A sees "Second is typing…" ---------
  // pressSequentially keeps the composer updating (each update re-signals; the
  // worker throttles frames and TTL-expires the set ~5s after B stops).
  await page2.getByTestId('composer-input').click()
  const typingSeen = expect(page1.getByTestId('typing-indicator')).toContainText('Second', {
    timeout: WS_TIMEOUT,
  })
  await page2
    .getByTestId('composer-input')
    .pressSequentially('composing a long thought, slowly', { delay: 120 })
  await typingSeen

  await ctx1.close()
  await ctx2.close()
})

test('m3.5 notifications: @mention while unfocused → toast + mention badge → open clears it', async ({
  browser,
}) => {
  // ctx1: the owner (mentioner); ctx2: the second member (recipient).
  const ctx1 = await browser.newContext()
  const page1 = await ctx1.newPage()
  await login(page1, OWNER)
  await openGeneral(page1)

  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  await login(page2, SECOND)
  // Open #general once (baseline read-state), then move to the Inbox view: no
  // active conversation, so an inbound #general message must notify (the
  // shouldNotify matrix only suppresses the ACTIVE + visible conversation).
  await openGeneral(page2)
  const generalRow2 = page2.getByTestId('sidebar-channel').first()
  await page2.getByTestId('nav-inbox').click()
  await expect(page2.getByTestId('inbox-view')).toBeVisible()

  // --- 1) Owner @mentions Second in #general (resolved via the mention popup) -
  const stamp = Date.now()
  await page1.getByTestId('composer-input').click()
  await page1.getByTestId('composer-input').pressSequentially('@Sec', { delay: 40 })
  const option = page1.getByTestId('mention-option').filter({ hasText: 'Second' })
  await expect(option).toBeVisible({ timeout: WS_TIMEOUT })
  await option.first().click()
  await page1.getByTestId('composer-input').pressSequentially(` ping-${stamp}`, { delay: 20 })
  await page1.getByTestId('composer-send').click()
  await expect(mainRow(page1, `ping-${stamp}`)).toBeVisible({ timeout: WS_TIMEOUT })

  // --- 2) Second gets the IN-APP toast (the OS Notification API is permission-
  //        gated and not grantable headless — the toast is the assertable path).
  const toast = page2.getByTestId('notification-toast').filter({ hasText: `ping-${stamp}` })
  await expect(toast).toBeVisible({ timeout: WS_TIMEOUT })
  await expect(toast.getByTestId('toast-title')).toContainText('general')

  // --- 3) …and the sidebar's #general row grows the red mention badge ---------
  await expect(generalRow2.getByTestId('mention-badge')).toBeVisible({ timeout: WS_TIMEOUT })

  // --- 4) Opening #general marks it read (ENG-123 read-state) → badge clears --
  await generalRow2.click()
  await expect(mainRow(page2, `ping-${stamp}`)).toBeVisible({ timeout: WS_TIMEOUT })
  await expect(generalRow2.getByTestId('mention-badge')).toBeHidden({ timeout: WS_TIMEOUT })

  await ctx1.close()
  await ctx2.close()
})
