import { defineConfig } from "@playwright/test";

const reuseExistingServer = process.env.CI !== "true";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: process.env.CI ? 60_000 : 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // The three engines share the same two reference origins. Serial projects
  // prevent browser startup contention from becoming false conformance failures.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "PORT=18080 node examples/server.mjs",
      url: "http://localhost:18080/examples/sender/",
      reuseExistingServer,
      timeout: 15_000,
    },
    {
      command: "PORT=18081 node examples/server.mjs",
      url: "http://127.0.0.1:18081/.well-known/open-app-bridge",
      reuseExistingServer,
      timeout: 15_000,
    },
  ],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
