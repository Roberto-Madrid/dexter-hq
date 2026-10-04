import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "STOP ALL" })).toBeVisible();
  await expect(page.locator(".tower[data-ready='1']")).toBeVisible();
  await expect(page.getByText("Example", { exact: true }).first()).toBeVisible();
}

test("signed-in desktop shows the example control tower", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await expect(page.getByRole("button", { name: "STOP ALL" })).toBeVisible();
  await expect(page.getByText("Agents")).toBeVisible();
  await expect(page.getByText("2/4")).toBeVisible();
  await expect(page.getByText("18%")).toBeVisible();
  await expect(page.getByText("Council")).toBeVisible();
  await expect(page.getByText("4/5")).toBeVisible();
  await expect(page.getByText("Growing from Dexter · 2 of 4 links live")).toBeVisible();
  await expect(page.getByText("Point production at v5").first()).toBeVisible();
  await expect(page.getByText("dreggbot").first()).toBeVisible();
  await expect(page.getByText("Path B council seat").first()).toBeVisible();
  await page.getByRole("button", { name: /Point production at v5/ }).click();
  await expect(page.getByText("Production still tracks main. v5 is the integration branch.")).toBeVisible();
  await expect(page.getByRole("button", { name: "STOP ALL" })).toBeVisible();
  await expect(page.getByText("Local graph · grown from Dexter")).toBeVisible();
});

test("phone keeps STOP ALL on every tab and the open request", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(page.getByRole("button", { name: "STOP ALL" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Requests" })).toBeVisible();
  await page.getByRole("button", { name: "Swarm" }).click();
  await expect(page.getByText("Growing from Dexter · 2 of 4 links live")).toBeVisible();
  await expect(page.getByRole("button", { name: "STOP ALL" })).toBeVisible();
  await page.getByRole("button", { name: "Bots" }).click();
  await expect(page.getByText("waiting")).toBeVisible();
  await expect(page.getByRole("button", { name: "STOP ALL" })).toBeVisible();
  await page.getByRole("button", { name: "Needs you" }).click();
  await expect(page.getByText("Set the Vercel production branch to v5")).toBeVisible();
  await expect(page.getByText("Approve").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "STOP ALL" })).toBeVisible();
  await page.getByRole("button", { name: "Requests" }).click();
  await page.getByRole("button", { name: /Point production at v5/ }).click();
  await expect(page.getByText("Production still tracks main. v5 is the integration branch.")).toBeVisible();
  await expect(page.getByRole("button", { name: "STOP ALL" })).toBeVisible();
});
