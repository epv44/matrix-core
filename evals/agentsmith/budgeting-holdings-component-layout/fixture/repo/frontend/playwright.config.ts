import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  // Concurrent cold-page compilation can corrupt Next 16's dev RSC manifest.
  // Browser behavior is still concurrent within each page; compile test pages
  // serially until the upstream Turbopack race is resolved.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev:clean -- -p 3000",
    port: 3000,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
