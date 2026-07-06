import { defineConfig, devices } from '@playwright/test'

// ENG-83 golden-path smoke (TDD §12): login → send → reload → history intact →
// a SECOND browser context sees the message live (real WS fanout → projection →
// UI). Drives the REAL PRODUCTION topology: a real msgd server (Postgres
// testcontainer + subprocess uvicorn) that serves the built SPA (web/dist),
// the /v1 API, and the /v1/ws WebSocket all from ONE origin — no proxy — booted
// by global-setup (see serverctl.py). Heavier than the unit suite; its own CI
// job. The base URL is fixed by MSGD_E2E_PORT (default 8099).
const PORT = process.env.MSGD_E2E_PORT ?? '8099'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 90_000,
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
