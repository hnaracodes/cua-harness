import { expect, test, type Page } from "@playwright/test";

test.use({ colorScheme: "dark" });

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test.describe("paper.css scoping", () => {
  test("default view is pure Graphite", async ({ page }) => {
    await page.goto("/?mock");
    await expect(page.getByTestId("composer-input")).toBeVisible();
    expect(await bodyBg(page)).toBe("rgb(20, 20, 20)");
    expect(await rootVar(page, "--accent")).toBe("#9d8cff");
    expect(await page.locator(".paper-root").count()).toBe(0);
  });

  test("paper gradient lives only inside .paper-root, and exiting restores Graphite", async ({ page }) => {
    await page.goto("/?mock&paper");
    const root = page.locator(".paper-root").first();
    await expect(root).toBeVisible();
    const bgImage = await root.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bgImage).toContain("linear-gradient");
    // body itself stays Graphite even while Paper is mounted
    expect(await bodyBg(page)).toBe("rgb(20, 20, 20)");
    // paper's --accent (#2f7cf6) is defined on .paper-root, never on :root
    expect(await rootVar(page, "--accent")).toBe("#9d8cff");
    await page.getByTestId("paper-exit").click();
    await expect(page.getByTestId("composer-input")).toBeVisible();
    expect(await bodyBg(page)).toBe("rgb(20, 20, 20)");
    expect(await rootVar(page, "--accent")).toBe("#9d8cff");
  });
});

test("Exit Paper view sits in the header row, right-aligned, not over content", async ({ page }) => {
  await page.goto("/?mock&paper");
  const exit = page.getByTestId("paper-exit");
  await expect(exit).toBeVisible();
  const inHeader = await exit.evaluate((el) => !!el.closest("header.app-header"));
  expect(inHeader).toBe(true);
  const [eb, hb] = await Promise.all([exit.boundingBox(), page.locator("header.app-header h1").boundingBox()]);
  expect(eb!.x).toBeGreaterThan(hb!.x + hb!.width);
});

test("Re-propose plan is enabled in review and round-trips through the daemon", async ({ page }) => {
  await page.goto("/?mock&paper");
  await page.getByTestId("generate-plan").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  const btn = page.getByTestId("repropose");
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(btn).toHaveText(/Re-proposing/);
  await expect(btn).toHaveText(/Re-propose plan/, { timeout: 10_000 });
  await expect(page.getByTestId("step-card-1")).toBeVisible();
});
