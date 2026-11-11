import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testIgnore: ["**/regras.test.mjs"], // regras do banco rodam no emulador (npm run test:regras)
  timeout: 30_000,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5055", ...devices["Pixel 7"], browserName: "chromium", trace: "off" },
  webServer: { command: "node e2e/servidor.mjs", url: "http://localhost:5055/x", reuseExistingServer: true },
});
