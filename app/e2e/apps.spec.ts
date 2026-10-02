import { expect, test } from "@playwright/test";

// Native app routing v2 on the mock daemon: an iMessage prompt routes the messaging
// steps to the Messages app; the search step stays in the agent's own browser.
test("a prompt via iMessage shows 'in Messages' chips on the messaging steps only", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill(
    "Find a tennis racket under $100 and tell my other friends about the party via iMessage",
  );
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("step-row-6")).toBeVisible({ timeout: 20_000 });

  for (const i of [4, 5, 6]) await expect(page.getByTestId(`step-app-${i}`)).toHaveText("in Messages");
  for (const i of [1, 2, 3]) await expect(page.getByTestId(`step-app-${i}`)).toHaveCount(0);
  await expect(page.getByTestId("step-row-1")).toContainText("Search");

  // The run's chat lines carry the app too.
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("chat-msg-step").filter({ hasText: "step 6 · in Messages" })).toHaveCount(1);
  await expect(page.getByTestId("chat-msg-step").filter({ hasText: "step 1 · in" })).toHaveCount(0);
});

test("a browser-only prompt shows no app chips", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("step-row-6")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid^="step-app-"]')).toHaveCount(0);
});
