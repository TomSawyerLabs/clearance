import { defineConfig } from "@playwright/test";

// Drives the built UI against the real Bun server with an in-memory database.
// Run with `bun run test:e2e`, which builds the UI first.
const PORT = 8099;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    // E2E_COMMAND points the same test at another build, e.g. the compiled executable.
    command: process.env.E2E_COMMAND || "bun src/entry/bun.ts",
    url: `http://localhost:${PORT}/api/state`,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATABASE_URL: "sqlite::memory:",
    },
    reuseExistingServer: false,
  },
});
