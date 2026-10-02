import { expect, test, type Page } from "@playwright/test";

// Run: E2E_PORT=1435 npx playwright test e2e/run.spec.ts
async function startRun(page: Page) {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("desk-view")).toBeVisible();
}

test("narrates step messages in order and ends in a recap with Details", async ({ page }) => {
  await startRun(page);
  await expect(page.getByTestId("desk-view")).toContainText("only this window is visible to the model");
  await expect(page.getByTestId("desk-progress").locator("span")).toHaveCount(6);
  await expect(page.getByTestId("desk-frame")).toBeVisible();
  await expect(page.getByTestId("desk-label")).toHaveText(/step \d of 6/);
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 60_000 });
  const rows = page.getByTestId("chat-msg-step");
  await expect(rows).toHaveCount(6);
  for (let i = 0; i < 6; i++) await expect(rows.nth(i)).toContainText(`step ${i + 1}`);
  await expect(page.getByTestId("desk-label")).toHaveText("6 of 6 done");
  await page.getByTestId("chat-recap-details").click();
  await expect(page.getByTestId("chat-recap-log")).toBeVisible();
});

test("Stop mid-run gives a stopped recap", async ({ page }) => {
  await startRun(page);
  await expect(page.getByTestId("chat-step-running")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("composer-stop").click();
  const recap = page.getByTestId("chat-recap");
  await expect(recap).toBeVisible({ timeout: 20_000 });
  await expect(recap).toContainText(/stop/i);
  expect(await page.getByTestId("chat-msg-step").count()).toBeLessThan(6);
});

test("a new task from the done composer goes back to planning", async ({ page }) => {
  await startRun(page);
  await expect(page.getByTestId("chat-step-running")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("composer-stop").click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("composer-input").fill("Draft a reply to my latest email");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("chat-msg-user").first()).toHaveText("Draft a reply to my latest email");
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
});
