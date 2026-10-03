import { defineConfig } from "@playwright/test";

const port = process.env.PORT ?? "3210";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  workers: 1,
  expect: { timeout: 20_000 },
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: undefined,
});
