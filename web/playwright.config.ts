import { defineConfig, devices } from '@playwright/test'

// Harness stub only (D-3). The golden-path spec (login → send → reload →
// second-browser-live, TDD §12) and the CI e2e step land in ENG-83; browsers
// are NOT installed in CI at ENG-75. `tests/e2e/` is seeded empty.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // webServer is stubbed until ENG-83 wires a real server for the golden path:
  // webServer: {
  //   command: 'pnpm preview --port 5173',
  //   url: 'http://localhost:5173',
  //   reuseExistingServer: !process.env.CI,
  // },
})
