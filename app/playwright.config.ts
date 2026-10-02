import { defineConfig, devices } from "@playwright/test";

// Each worktree runs its own server on its own port (see the E2E port table in the
// master plan), so parallel tracks never test each other's code.
const PORT = Number(process.env.E2E_PORT ?? 1430);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    env: process.env.E2E_DAEMON_URL ? { VITE_DAEMON_URL: process.env.E2E_DAEMON_URL } : { VITE_MOCK: "1" },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
