import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright owns the browser specs. Only `*.spec.ts` are collected here;
 * `tests/**\/*.test.ts` are Vitest files and must never be picked up by
 * Playwright's default `**\/*.@(spec|test).ts` rule.
 */
const localBaseUrl = "http://127.0.0.1:4173";
/** Point the suite at a deploy (e.g. the freshness guard) instead of a build. */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? localBaseUrl;
const useLocalServer = baseURL === localBaseUrl;

export default defineConfig({
  testDir: "./tests",
  testMatch: /\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  snapshotPathTemplate:
    "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",
  use: {
    baseURL,
    locale: "ar-SA",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
      },
    },
    {
      name: "desktop-firefox",
      testMatch: /compatibility\.spec\.ts/,
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "desktop-webkit",
      testMatch: /compatibility\.spec\.ts/,
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile-webkit",
      testMatch: /compatibility\.spec\.ts/,
      use: {
        ...devices["iPhone 15"],
      },
    },
  ],
  // The preview server mirrors the production API paths over the committed
  // fixture grids; `vite preview` alone cannot serve `/api/wind/grids/*.bin`.
  webServer: useLocalServer
    ? {
        command:
          "VITE_WIND_MANIFEST_URL=/data/processed/latest.json bun run build && bun tests/support/preview-server.mjs",
        url: localBaseUrl,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
});
