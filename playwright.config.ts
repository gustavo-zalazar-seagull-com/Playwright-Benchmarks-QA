import { defineConfig, devices } from '@playwright/test';

// Load .env file into process.env before tests run
require('dotenv').config();

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/*.spec.{js,ts}', '**/*.test.{js,ts}', '**/falabella*.{js,ts}'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'https://falabella.ytem.io',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
