import { expect, test, type Page } from "@playwright/test";

// pointermove → next rAF, measured in-page. Gate: p95 < 16 ms with 30 badges.
async function arm(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__lat = [];
    const svg = document.querySelector('[data-testid="boundary-canvas"]')!;
    svg.addEventListener("pointermove", () => {
      const t0 = performance.now();
      requestAnimationFrame(() => w.__lat.push(performance.now() - t0));
    }, { capture: true });
  });
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

test("handle drag and pan stay under one frame with 30 badges", async ({ page }) => {
  await page.goto("/?mock&fast&many=30");
  await page.getByTestId("composer-input").fill("crowd");
  await page.getByTestId("composer-send").click();
  const svg = page.getByTestId("boundary-canvas");
  await expect(svg).toBeVisible({ timeout: 20_000 });
  const b = (await svg.boundingBox())!;
  // draw a loop in the middle
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2, r = Math.min(b.width, b.height) / 4;
  await page.mouse.move(cx + r, cy);
  await page.mouse.down();
  for (let k = 1; k <= 48; k++) await page.mouse.move(cx + r * Math.cos((k / 48) * 2 * Math.PI), cy + r * Math.sin((k / 48) * 2 * Math.PI));
  await page.mouse.up();
  await arm(page);
  // handle drag
  const h = (await page.getByTestId("boundary-handle").first().boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 80, h.y + 40, { steps: 60 });
  await page.mouse.up();
  // pan
  await page.getByTestId("canvas-tool-pan").click();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 120, cy - 60, { steps: 60 });
  await page.mouse.up();
  const lat: number[] = await page.evaluate(() => (window as any).__lat);
  expect(lat.length).toBeGreaterThan(100);
  console.log(`feel p95=${p95(lat).toFixed(2)}ms n=${lat.length}`);
  expect(p95(lat)).toBeLessThan(16);
});
