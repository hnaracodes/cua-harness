import { expect, test, type Page } from "@playwright/test";

async function openReview(page: Page) {
  await page.goto("/?mock");
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("badge-6")).toBeVisible();
}

async function plotBox(page: Page) {
  const svg = page.getByTestId("boundary-canvas");
  const box = (await svg.boundingBox())!;
  const [x, y, w, h] = (await svg.getAttribute("data-plot"))!.split(",").map(Number);
  return { left: box.x + x, top: box.y + y, w, h };
}

/** Screen point for a data-space point at identity camera. */
const at = (pl: { left: number; top: number; w: number; h: number }, x: number, y: number) => ({ x: pl.left + x * pl.w, y: pl.top + (1 - y) * pl.h });

/** Ellipse loop around data (cx,cy) with radii (rx,ry); calls `beforeUp` before releasing. */
async function loop(page: Page, c: { x: number; y: number }, rx: number, ry: number, beforeUp?: () => Promise<void>) {
  await page.mouse.move(c.x + rx, c.y);
  await page.mouse.down();
  for (let k = 1; k <= 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    await page.mouse.move(c.x + rx * Math.cos(a), c.y + ry * Math.sin(a));
  }
  if (beforeUp) await beforeUp();
  await page.mouse.up();
}

async function targets(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<SVGGElement>('[data-testid^="badge-"]:not([data-testid="badge-layer"]):not([data-testid="badge-tooltip"]), [data-testid="stack-badge"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-testid")!, status: el.getAttribute("data-status")!, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
}

test("loop reclassifies live, before mouseup", async ({ page }) => {
  await openReview(page);
  const pl = await plotBox(page);
  const c = at(pl, 0.13, 0.1);
  const rx = 0.09 * pl.w, ry = 0.12 * pl.h;
  await loop(page, c, rx, ry, async () => {
    const ts = await targets(page);
    const inside = ts.filter((t) => ((t.x - c.x) / rx) ** 2 + ((t.y - c.y) / ry) ** 2 < 0.8);
    const outside = ts.filter((t) => ((t.x - c.x) / rx) ** 2 + ((t.y - c.y) / ry) ** 2 > 1.25);
    expect(inside.length).toBeGreaterThan(0);
    for (const t of inside) expect(t.status, t.id).toBe("approved");
    for (const t of outside) expect(t.status, t.id).not.toBe("approved");
  });
  const v = Number(await page.getByTestId("boundary-polygon").getAttribute("data-vertices"));
  expect(v).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("badge-1")).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("badge-4")).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("badge-6")).toHaveAttribute("data-status", "pending");
  await expect(page.getByTestId("coach-hint")).toHaveCount(0);
});

test("draw at 400% zoom: every stored vertex stays in [0,1]", async ({ page }) => {
  await openReview(page);
  for (let i = 0; i < 4; i++) await page.getByTestId("canvas-zoom-in").click();
  await expect(page.getByTestId("canvas-zoom-label")).toHaveText("400%");
  // Center the view near the data origin (minimap click) so a big loop really crosses x<0 and y<0.
  const mm = (await page.getByTestId("minimap").boundingBox())!;
  await page.mouse.click(mm.x + 6 + 0.05 * 108, mm.y + 70 - 0.05 * 64);
  await expect(page.getByTestId("canvas-zoom-label")).toHaveText("400%");
  const pl = await plotBox(page);
  // A loop much larger than the visible plot: it starts on the canvas (a press has to land
  // there), then runs off the plot, off the canvas, and out of data space.
  await loop(page, { x: pl.left + pl.w / 2, y: pl.top + pl.h / 2 }, pl.w * 0.45, pl.h * 0.9);
  const pts = JSON.parse((await page.getByTestId("boundary-polygon").getAttribute("data-points"))!) as [number, number][];
  expect(pts.length).toBeGreaterThanOrEqual(3);
  for (const [x, y] of pts) {
    expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1);
    expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1);
  }
  // The loop crossed out of data space, so clamping actually ran.
  expect(pts.some(([x, y]) => x === 0 || y === 0)).toBe(true);
});

test("stack at 50%: fan out and approve one member", async ({ page }) => {
  await openReview(page);
  await page.getByTestId("canvas-zoom-out").click();
  await page.getByTestId("canvas-zoom-out").click();
  await expect(page.getByTestId("canvas-zoom-label")).toHaveText("50%");
  const stack = page.locator('[data-testid="stack-badge"][data-members="1,4"]');
  await expect(stack).toBeVisible();
  await stack.click();
  await expect(page.getByTestId("fan-out")).toBeVisible();
  await page.getByTestId("fan-approve-4").click();
  await expect(page.getByTestId("badge-4")).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("badge-1")).toHaveAttribute("data-status", "pending");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fan-out")).toHaveCount(0);
  await expect(stack).toHaveAttribute("data-status", "mixed");
});

test("undo restores the previous polygon; clear then undo brings it back", async ({ page }) => {
  await openReview(page);
  const pl = await plotBox(page);
  await loop(page, at(pl, 0.13, 0.1), 0.09 * pl.w, 0.12 * pl.h);
  const first = await page.getByTestId("boundary-polygon").getAttribute("data-points");
  await loop(page, at(pl, 0.48, 0.2), 0.12 * pl.w, 0.2 * pl.h);
  expect(await page.getByTestId("boundary-polygon").getAttribute("data-points")).not.toBe(first);
  await page.getByTestId("canvas-undo").click();
  await expect(page.getByTestId("boundary-polygon")).toHaveAttribute("data-points", first!);
  await page.getByTestId("canvas-clear").click();
  await expect(page.getByTestId("boundary-polygon")).toHaveCount(0);
  await page.keyboard.press("Meta+z");
  await expect(page.getByTestId("boundary-polygon")).toHaveAttribute("data-points", first!);
});

test("pan never re-renders badges; Fit returns to a framing camera", async ({ page }) => {
  await openReview(page);
  for (let i = 0; i < 2; i++) await page.getByTestId("canvas-zoom-in").click();
  const svg = page.getByTestId("boundary-canvas");
  const layer = page.getByTestId("badge-layer");
  const before = await layer.getAttribute("data-renders");
  const ty0 = await svg.getAttribute("data-ty");
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120); // plain wheel = pan
  await expect(svg).not.toHaveAttribute("data-ty", ty0!);
  expect(await layer.getAttribute("data-renders")).toBe(before);
  await page.getByTestId("canvas-fit").click();
  for (const i of [1, 2, 3, 4, 5, 6]) await expect(page.getByTestId(`badge-${i}`)).toBeInViewport();
});

test("space released while the window was blurred does not leave space-drag stuck on", async ({ page }) => {
  await openReview(page);
  const svg = page.getByTestId("boundary-canvas");
  await svg.focus();
  await page.keyboard.down("Space");
  await expect(svg).toHaveCSS("cursor", "grab");
  // The keyup lands in another window, so the page only ever sees a blur.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(svg).not.toHaveCSS("cursor", "grab");
  const tx0 = await svg.getAttribute("data-tx");
  const pl = await plotBox(page);
  await loop(page, at(pl, 0.13, 0.1), 0.09 * pl.w, 0.12 * pl.h);
  await expect(page.getByTestId("boundary-polygon")).toBeVisible();
  await expect(svg).toHaveAttribute("data-tx", tx0!);
});

test("space-drag state also clears when the page is hidden", async ({ page }) => {
  await openReview(page);
  const svg = page.getByTestId("boundary-canvas");
  await svg.focus();
  await page.keyboard.down("Space");
  await expect(svg).toHaveCSS("cursor", "grab");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(svg).not.toHaveCSS("cursor", "grab");
});

test("a keyboard zoom made mid-pan is kept by the rest of the pan", async ({ page }) => {
  await openReview(page);
  const svg = page.getByTestId("boundary-canvas");
  await svg.focus();
  await page.keyboard.press("h"); // pan tool
  const box = (await svg.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y + 10, { steps: 4 });
  await page.keyboard.press("+");
  await expect(svg).toHaveAttribute("data-scale", "1.4142");
  const tx = Number(await svg.getAttribute("data-tx"));
  await page.mouse.move(x + 30, y + 10, { steps: 2 });
  await expect(svg).toHaveAttribute("data-scale", "1.4142");
  expect(Number(await svg.getAttribute("data-tx"))).toBeCloseTo(tx + 10, 0);
  await page.mouse.up();
  await expect(svg).toHaveAttribute("data-scale", "1.4142");
});

test("feel: pointermove → next frame under 16 ms (median) during a handle drag", async ({ page }) => {
  await openReview(page);
  const pl = await plotBox(page);
  await loop(page, at(pl, 0.3, 0.15), 0.25 * pl.w, 0.15 * pl.h);
  const h = (await page.getByTestId("boundary-handle").first().boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { __feel: number[] };
    w.__feel = [];
    window.addEventListener("pointermove", (e) => {
      const t0 = e.timeStamp;
      requestAnimationFrame(() => w.__feel.push(performance.now() - t0));
    }, { capture: true });
  });
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) await page.mouse.move(h.x + h.width / 2 + i * 2, h.y + h.height / 2 - i);
  await page.mouse.up();
  const ms = await page.evaluate(() => (window as unknown as { __feel: number[] }).__feel.slice().sort((a, b) => a - b));
  const median = ms[Math.floor(ms.length / 2)];
  // Budget is one 60 Hz frame. A loaded CI box can override with FEEL_BUDGET_MS; locally it must hold at 16.
  expect(median).toBeLessThan(Number(process.env.FEEL_BUDGET_MS ?? 16));
});
