const { test } = require("@playwright/test");
const { mkdirSync, readFileSync } = require("node:fs");
test("screenshot", async ({ page }) => {
  mkdirSync("shots", { recursive: true });
  await page.setContent(readFileSync("index.html", "utf8"));
  await page.screenshot({ path: "shots/checker.png" });
});
