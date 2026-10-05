import { expect, test, type Locator, type Page } from "@playwright/test";

function shown(locator: Locator) {
  return locator.filter({ visible: true });
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(shown(page.getByRole("button", { name: "STOP ALL" }))).toBeVisible();
  await expect(page.locator(".tower[data-ready='1']")).toBeVisible();
  await expect(shown(page.locator(".ex")).first()).toBeVisible();
}

test("signed-in desktop shows the example control tower", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await expect(shown(page.getByRole("button", { name: "STOP ALL" }))).toBeVisible();
  await expect(shown(page.getByText("Agents"))).toBeVisible();
  await expect(shown(page.getByText("2/4"))).toBeVisible();
  await expect(shown(page.getByText("18%"))).toBeVisible();
  await expect(shown(page.getByText("Council", { exact: true }))).toBeVisible();
  await expect(shown(page.getByText("4/5"))).toBeVisible();
  await expect(shown(page.getByText("Growing from Dexter · 2 of 4 links live"))).toBeVisible();
  await expect(shown(page.getByText("Point production at v5")).first()).toBeVisible();
  await expect(shown(page.getByText("dreggbot")).first()).toBeVisible();
  await expect(shown(page.getByText("Path B council seat")).first()).toBeVisible();
  await shown(page.getByRole("button", { name: /Point production at v5/ })).click();
  await expect(shown(page.getByText("Production still tracks main. v5 is the integration branch."))).toBeVisible();
  await expect(shown(page.getByRole("button", { name: "STOP ALL" }))).toBeVisible();
  await expect(shown(page.getByText("Local graph · grown from Dexter"))).toBeVisible();
});

test("phone keeps STOP ALL on every tab and the open request", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(shown(page.getByRole("button", { name: "STOP ALL" }))).toBeVisible();
  await expect(page.getByRole("button", { name: "Requests" })).toBeVisible();
  await page.getByRole("button", { name: "Swarm" }).click();
  await expect(shown(page.getByText("Growing from Dexter · 2 of 4 links live"))).toBeVisible();
  await expect(shown(page.getByRole("button", { name: "STOP ALL" }))).toBeVisible();
  await page.getByRole("button", { name: "Bots" }).click();
  await expect(shown(page.getByText("waiting"))).toBeVisible();
  await expect(shown(page.getByRole("button", { name: "STOP ALL" }))).toBeVisible();
  await page.getByRole("button", { name: "Needs you" }).click();
  await expect(shown(page.getByText("Set the Vercel production branch to v5"))).toBeVisible();
  await expect(shown(page.getByRole("button", { name: "Approve" })).first()).toBeVisible();
  await expect(shown(page.getByRole("button", { name: "Deny" })).first()).toBeVisible();
  await expect(shown(page.getByRole("button", { name: "STOP ALL" }))).toBeVisible();
  await page.getByRole("button", { name: "Requests" }).click();
  await shown(page.getByRole("button", { name: /Point production at v5/ })).click();
  await expect(shown(page.getByText("Production still tracks main. v5 is the integration branch."))).toBeVisible();
  await expect(shown(page.getByRole("button", { name: "STOP ALL" }))).toBeVisible();
});

test("signed-in owner can resume from the tower after STOP ALL", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/stop", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reports: [], asOf: "2026-10-04T12:00:00.000Z" }),
    });
  });
  await page.route("**/api/resume", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ resumed: true, asOf: "2026-10-04T12:00:01.000Z" }),
    });
  });
  await signIn(page);
  await expect(shown(page.getByRole("button", { name: "Resume" }))).toHaveCount(0);
  await shown(page.getByRole("button", { name: "STOP ALL" })).click();
  await expect(shown(page.getByRole("button", { name: "Resume" }))).toBeVisible();
  await expect(shown(page.getByRole("button", { name: "STOP ALL" }))).toBeVisible();
  await shown(page.getByRole("button", { name: "Resume" })).click();
  await expect(shown(page.getByRole("button", { name: "Resume" }))).toHaveCount(0);
  await expect(shown(page.getByRole("button", { name: "STOP ALL" }))).toBeVisible();
});
