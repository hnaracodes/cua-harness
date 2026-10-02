// app/e2e/setup.spec.ts. Run: E2E_PORT=1436 npx playwright test e2e/setup.spec.ts
import { expect, test, type Page } from "@playwright/test";

async function toKey(page: Page) {
  await page.goto("/?mock&setup");
  await expect(page.getByTestId("setup-wizard")).toBeVisible();
  await expect(page.getByTestId("setup-skip-plan-only")).toHaveCount(0);
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("setup-next")).toBeDisabled();
  await expect(page.getByTestId("setup-skip-plan-only")).toHaveCount(0);
  await page.getByTestId("setup-key-input").fill("sk-test-123");
  await page.getByTestId("setup-key-save").click();
  await expect(page.getByTestId("setup-next")).toBeEnabled();
  await expect(page.getByTestId("setup-key-input")).toHaveValue(""); // never kept in the page
  await page.getByTestId("setup-next").click();
}

test("full walk-through: key, driver, permissions (live), self-test, done", async ({ page }) => {
  await toKey(page);
  if (await page.getByTestId("setup-driver-install").isVisible()) await page.getByTestId("setup-driver-install").click();
  await page.getByTestId("setup-driver-start").click();
  await expect(page.getByTestId("setup-next")).toBeEnabled({ timeout: 5_000 });
  await page.getByTestId("setup-next").click();
  await expect(page.getByText("CuaDriver")).toBeVisible();
  await page.getByTestId("setup-open-accessibility").click();
  await page.getByTestId("setup-open-screen_recording").click();
  await expect(page.getByText("Waiting for", { exact: false })).toBeVisible();
  await expect(page.getByTestId("setup-next")).toBeEnabled({ timeout: 6_000 }); // polled, no click needed
  await page.getByTestId("setup-next").click();
  await page.getByTestId("setup-selftest-run").click();
  await expect(page.getByTestId("setup-done")).toBeEnabled({ timeout: 5_000 });
  await page.getByTestId("setup-done").click();
  await expect(page.getByTestId("setup-wizard")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What should the agent do?" })).toBeVisible();
});

test("plan-only skip from the cua-driver step lands on home", async ({ page }) => {
  await toKey(page);
  await page.getByTestId("setup-skip-plan-only").click();
  await expect(page.getByTestId("setup-wizard")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What should the agent do?" })).toBeVisible();
});
