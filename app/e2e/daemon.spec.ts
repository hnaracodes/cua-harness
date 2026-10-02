import { expect, test } from "@playwright/test";

test.skip(!process.env.E2E_DAEMON_URL, "needs E2E_DAEMON_URL (real fixtures daemon)");

test("real fixtures daemon: home → plan → approve all → run → recap", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("composer-input").fill("Help me find a tennis racket less than $100 for my friends birthday present, and prepare a short message to my other friends to let them know I am planning a party via whatsapp.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-msg-step").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 120_000 });
});
