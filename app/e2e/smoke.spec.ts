import { expect, test } from "@playwright/test";

// The whole spine on the mock daemon. Every Wave 1 track keeps this green.
test("home → plan → approve all → run → recap", async ({ page }) => {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 45_000 });
});

test("paper view still runs the source flow", async ({ page }) => {
  await page.goto("/?mock&paper");
  await page.getByTestId("generate-plan").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Select All" }).click();
  await page.getByTestId("approve-run").click();
  await expect(page.getByText("All approved steps were attempted.")).toBeVisible({ timeout: 45_000 });
});
