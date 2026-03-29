import { defineConfig, devices } from '@playwright/test';

const storybookPort = 4173;
const storybookOrigin = `http://127.0.0.1:${storybookPort}`;

export default defineConfig({
  testDir: './playwright',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  timeout: 90_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: 'list',
  use: {
    baseURL: storybookOrigin,
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 720 },
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec http-server storybook-static -p ${storybookPort} -c-1 --silent`,
    url: storybookOrigin,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
