import { expect, test, type Page } from "@playwright/test";

// U1 note: a health-pill "Fix" link must open SetupWizard at the matching initialStep.
// The skip button appears from the cua-driver step on, so walk welcome → key first.
async function planOnly(page: Page) {
  await page.goto("/?mock&setup");
  await expect(page.getByTestId("setup-wizard")).toBeVisible();
  await page.getByTestId("setup-next").click();
  await page.getByTestId("setup-key-input").fill("sk-test-123");
  await page.getByTestId("setup-key-save").click();
  await page.getByTestId("setup-next").click();
  await page.getByTestId("setup-skip-plan-only").click(); // plan-only: setup completes, cua_driver still false
  await expect(page.getByTestId("setup-wizard")).toHaveCount(0);
  await expect(page.getByTestId("health-pill")).toBeVisible();
}

async function expectWizardAtFixStep(page: Page) {
  await expect(page.getByTestId("setup-wizard")).toBeVisible();
  await expect(page.locator("[data-testid^='setup-step-'][aria-current='step']")).toHaveAttribute("data-testid", /setup-step-(driver|permissions)/);
}

test("health pill Fix opens the wizard at the permissions step", async ({ page }) => {
  await planOnly(page);
  // The Fix link sits beside the pill (a button can't nest in the pill's button).
  await page.getByTestId("health-pill").locator("xpath=..").getByRole("button", { name: /^fix$/i }).click();
  await expectWizardAtFixStep(page);
});

test("the pill's status popover Fix opens the wizard at the same step", async ({ page }) => {
  await planOnly(page);
  await page.getByTestId("health-pill").click();
  await page.getByRole("dialog", { name: "Daemon status" }).getByRole("button", { name: /^fix$/i }).click();
  await expectWizardAtFixStep(page);
});
