import { expect, test, type Page } from "@playwright/test";

// Run: E2E_PORT=1432 npx playwright test e2e/chat.spec.ts
async function toReview(page: Page, prompt = "Find a tennis racket under $100") {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
}

test("the user's prompt and the plan message with live counts", async ({ page }) => {
  await toReview(page);
  await expect(page.getByTestId("chat-msg-user").first()).toContainText("Find a tennis racket under $100");
  const plan = page.getByTestId("chat-plan-ready");
  await expect(plan).toContainText("6 steps");
  await expect(plan).toContainText("0 approved");
  await expect(plan).toContainText("6 need a decision");
  await page.getByTestId("approve-all").click();
  await expect(plan).toContainText("6 approved");
  await expect(plan).toContainText("0 need a decision");
});

test("a run narrates step rows in order and ends in a recap with a Details log", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-run-started")).toContainText("Plan approved: steps 1, 2, 3, 4, 5, 6");
  const recap = page.getByTestId("chat-recap");
  await expect(recap).toBeVisible({ timeout: 60_000 });
  const rows = page.getByTestId("chat-msg-step");
  await expect(rows).toHaveCount(6);
  for (let i = 0; i < 6; i++) await expect(rows.nth(i)).toContainText(`step ${i + 1}`);
  await expect(page.getByTestId("chat-step-running")).toHaveCount(0);
  await expect(recap).toBeInViewport();
  await expect(page.getByTestId("chat-recap-log")).toHaveCount(0);
  await page.getByTestId("chat-recap-details").click();
  await expect(page.getByTestId("chat-recap-log")).toContainText("step 1 started");
});
