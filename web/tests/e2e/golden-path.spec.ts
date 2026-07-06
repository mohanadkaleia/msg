// ENG-83 golden-path smoke (TDD §12): the single happy flow, end to end, over
// the REAL PRODUCTION stack — a real msgd server (Postgres + uvicorn) serving
// the built SPA, the /v1 API, and the /v1/ws WebSocket from one origin:
//
//   login → send a message → reload → history intact →
//   a SECOND browser context sees the message live (real WS fanout).
//
// The server harness (serverctl.py) bootstraps the owner + a public `general`
// channel via msgctl before the browser runs (the server's /v1/setup makes only
// workspace-meta; a channel is born from a channel.created event). Focused
// smoke, not an exhaustive UI suite. Uses the data-test/-testid hooks ENG-82
// exposed (login form: data-test; shell: data-testid).

import { expect, test, type Page } from '@playwright/test'

// Matches serverctl.py's bootstrap identity.
const OWNER = {
  email: 'owner@example.com',
  password: 'correct-horse-battery-staple',
}

/** Log in the bootstrapped owner and land on the authed shell. */
async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.fill('[data-test="email"]', OWNER.email)
  await page.fill('[data-test="password"]', OWNER.password)
  await page.click('[data-test="submit"]')
  await expect(page.locator('[data-testid="sidebar-channel"]').first()).toBeVisible({
    timeout: 30_000,
  })
}

/** Open the first channel (general) and send `text`. */
async function sendMessage(page: Page, text: string): Promise<void> {
  await page.locator('[data-testid="sidebar-channel"]').first().click()
  await page.fill('[data-testid="composer-input"]', text)
  await page.click('[data-testid="composer-send"]')
}

test('golden path: login → send → reload → history intact → second browser live', async ({
  browser,
}) => {
  // --- Browser context 1: log in, send, and see the message render -----------
  const ctx1 = await browser.newContext()
  const page1 = await ctx1.newPage()
  await login(page1)

  const first = `hello from owner ${Date.now()}`
  await sendMessage(page1, first)
  await expect(page1.locator('[data-testid="message-text"]', { hasText: first })).toBeVisible({
    timeout: 20_000,
  })

  // --- Reload → history intact (Dexie cache + pull catch-up) ------------------
  await page1.reload()
  await page1.locator('[data-testid="sidebar-channel"]').first().click()
  await expect(page1.locator('[data-testid="message-text"]', { hasText: first })).toBeVisible({
    timeout: 20_000,
  })

  // --- Browser context 2: log in as the same user, open the channel ----------
  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  await login(page2)
  await page2.locator('[data-testid="sidebar-channel"]').first().click()
  // Context 2 catches up the earlier message via pull.
  await expect(page2.locator('[data-testid="message-text"]', { hasText: first })).toBeVisible({
    timeout: 20_000,
  })

  // --- Context 1 sends a NEW message → context 2 sees it LIVE (WS fanout) -----
  const live = `live broadcast ${Date.now()}`
  await sendMessage(page1, live)
  await expect(page2.locator('[data-testid="message-text"]', { hasText: live })).toBeVisible({
    timeout: 20_000,
  })

  await ctx1.close()
  await ctx2.close()
})
