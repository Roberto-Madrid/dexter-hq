import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "STOP ALL" })).toBeVisible();
  await expect(page.locator(".shell[data-ready='1']")).toBeVisible();
}

test("three asks become three plan cards and status uses no model", async ({ page }) => {
  await signIn(page);
  const asks = [
    ["What is the difference between a lease and a run?", "answer"],
    ["Look into whether uncertain outcomes should be reconciled", "research"],
    ["Fix the stale lease check in the repo", "change"],
  ] as const;
  for (const [text, crew] of asks) {
    await page.getByLabel("Message Dexter").fill(text);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("plan-card").filter({ hasText: crew }).first()).toBeVisible();
  }
  await page.getByLabel("Message Dexter").fill("What is the status?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("model-calls")).toHaveText("Model calls 0");
  await expect(page.getByText("Spent this month unknown")).toBeVisible();
});

test("phone keeps STOP ALL visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(page.getByRole("button", { name: "STOP ALL" })).toBeVisible();
  await page.getByRole("button", { name: "board" }).click();
  await expect(page.getByRole("heading", { name: "Request board" })).toBeVisible();
  await page.getByRole("button", { name: "swarm" }).click();
  await expect(page.getByRole("heading", { name: "Swarm view" })).toBeVisible();
});
