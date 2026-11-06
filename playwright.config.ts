import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5055", ...devices["Pixel 7"], browserName: "chromium", trace: "off" },
  webServer: { command: "node e2e/servidor.mjs", url: "http://localhost:5055/x", reuseExistingServer: true },
});
