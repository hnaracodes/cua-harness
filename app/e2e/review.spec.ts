import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_DIMENSIONS } from "../src/api/fixtures";

// Run: E2E_PORT=1434 npx playwright test e2e/review.spec.ts
const def = (key: string) => FIXTURE_DIMENSIONS.find((d) => d.key === key)!.definition;

async function toReview(page: Page) {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
}

test("axis picker shows the exact definition string from /dimensions", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("axis-x-info").hover();
  await expect(page.getByTestId("axis-x-definition")).toHaveText(def("action_uncertainty"));
  await page.getByTestId("axis-x").selectOption("verifiability");
  await page.getByTestId("axis-x-info").hover();
  await expect(page.getByTestId("axis-x-definition")).toHaveText(def("verifiability"));
  // Picking the other axis's dimension swaps the axes instead of plotting X against itself.
  await page.getByTestId("axis-x").selectOption("reversibility");
  await expect(page.getByTestId("axis-y")).toHaveValue("verifiability");
});

test("edit a step inline", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("step-edit-1").click();
  await page.getByTestId("step-edit-title-1").fill("Search for rackets under $80");
  await page.getByTestId("step-edit-save-1").click();
  await expect(page.getByTestId("step-row-1")).toContainText("Search for rackets under $80");
});

test("remove and undo", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("step-remove-6").click();
  await expect(page.getByTestId("step-row-6")).toHaveAttribute("data-status", "removed");
  await page.getByTestId("step-restore-6").click();
  await expect(page.getByTestId("step-row-6")).toHaveAttribute("data-status", "pending");
});

test("primary button walks Approve all → Run K, skip M → runs and records the skip", async ({ page }) => {
  await toReview(page);
  await expect(page.getByTestId("approve-all")).toHaveText("Approve all 6");
  await expect(page.getByTestId("run-primary")).toHaveCount(0);
  await page.getByTestId("step-approve-1").click();
  await page.getByTestId("step-approve-2").click();
  await expect(page.getByTestId("run-primary")).toHaveText("Run 2 approved, skip 4");
  await expect(page.getByTestId("decision-hint")).toHaveText("4 steps still need a decision");
  await expect(page.getByTestId("approve-all")).toHaveText("Approve all 6");
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-run-started")).toContainText("Plan approved: steps 1, 2 · skipped 3, 4, 5, 6", { timeout: 20_000 });
});

test("revise from chat", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("composer-input").fill("Only message the party group");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("chat-revised")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-msg-user").nth(1)).toHaveText("Only message the party group");
  await expect(page.getByTestId("composer-input")).toHaveValue("");
});

test("paper toggle switches to the source layout", async ({ page }) => {
  await toReview(page);
  await page.getByTestId("paper-toggle").click();
  await expect(page.getByTestId("approve-run")).toBeVisible();
  await page.getByTestId("paper-exit").click();
  await expect(page.getByTestId("run-primary").or(page.getByTestId("approve-all"))).toBeVisible();
});
