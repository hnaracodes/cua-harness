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

test("pencil edits a step inline; Escape cancels; Save persists", async ({ page }) => {
  await page.goto("/?mock&paper");
  await page.getByTestId("generate-plan").click();
  await expect(page.getByTestId("step-card-2")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("edit-2").click();
  await page.getByTestId("edit-title-2").fill("Pick the cheapest racket");
  await page.getByTestId("edit-title-2").press("Escape");
  await expect(page.getByTestId("step-card-2")).not.toContainText("Pick the cheapest racket");
  await page.getByTestId("edit-2").click();
  await page.getByTestId("edit-title-2").fill("Pick the cheapest racket");
  await page.getByTestId("edit-desc-2").fill("Choose the lowest-priced option under $100.");
  await page.getByTestId("edit-save-2").click();
  await expect(page.getByTestId("step-card-2")).toContainText("Pick the cheapest racket");
  await expect(page.getByTestId("step-card-2")).toContainText("Choose the lowest-priced option under $100.");
});

async function center(page: Page, testid: string) {
  const b = (await page.getByTestId(testid).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * Freehand loop around the given badge centers: the convex hull of a disc of radius `pad`
 * around each badge, traced in small steps. (A triangle pushed out from the centroid is a
 * sliver when two of the badges sit close together, as 1 and 4 do in the fixtures, and can
 * miss a badge's true scored point, which is what classification tests.)
 */
async function loopAround(page: Page, pts: { x: number; y: number }[], pad = 24, release = true) {
  const cloud: { x: number; y: number }[] = [];
  for (const p of pts)
    for (let k = 0; k < 24; k++) {
      const t = (2 * Math.PI * k) / 24;
      cloud.push({ x: p.x + pad * Math.cos(t), y: p.y + pad * Math.sin(t) });
    }
  cloud.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: { x: number; y: number }[]) => {
    const h: { x: number; y: number }[] = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  const ring = [...half(cloud), ...half([...cloud].reverse())];
  await page.mouse.move(ring[0].x, ring[0].y);
  await page.mouse.down();
  for (let i = 1; i <= ring.length; i++) {
    const a = ring[i - 1], b = ring[i % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6));
    for (let k = 1; k <= n; k++) await page.mouse.move(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n);
  }
  if (release) await page.mouse.up();
}

test.describe("paper flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mock&paper");
    await page.getByTestId("generate-plan").click();
    await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  });

  test("drawing a loop reclassifies live, before release", async ({ page }) => {
    const pts = [await center(page, "badge-1"), await center(page, "badge-2"), await center(page, "badge-4")];
    await loopAround(page, pts, 24, false);
    // still holding the mouse: classification already happened
    for (const i of [1, 2, 4]) await expect(page.getByTestId(`badge-${i}`)).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId("count-approved")).toContainText("3");
    await page.mouse.up();
    await expect(page.getByTestId("boundary-handle").first()).toBeVisible();
    for (const i of [1, 2, 4]) await expect(page.getByTestId(`badge-${i}`)).toHaveAttribute("data-status", "approved");
  });

  test("Select All approves every step and enables Approve & Run", async ({ page }) => {
    await expect(page.getByTestId("approve-run")).toBeDisabled();
    await page.getByTestId("select-all").click();
    for (const i of [1, 2, 3, 4, 5, 6]) await expect(page.getByTestId(`step-card-${i}`)).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId("approve-run")).toBeEnabled();
  });

  test("removed step is struck through with the verbatim label, and Undo restores it", async ({ page }) => {
    await page.getByTestId("remove-3").click();
    const card = page.getByTestId("step-card-3");
    await expect(card).toHaveAttribute("data-status", "removed");
    await expect(card).toContainText("Removed by oversight - excluded");
    const deco = await card.locator(".card-title").evaluate((el) => getComputedStyle(el).textDecorationLine);
    expect(deco).toContain("line-through");
    await page.getByTestId("undo-3").click();
    await expect(card).toHaveAttribute("data-status", "pending");
  });

  test("Undo in the plan panel records its decision with source plan_panel", async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __oversightMock: { api: { decision: (t: string, d: unknown) => Promise<unknown> } }; __decisions: unknown[] };
      const api = w.__oversightMock.api;
      const orig = api.decision.bind(api);
      w.__decisions = [];
      api.decision = (t, d) => { w.__decisions.push(d); return orig(t, d); };
    });
    await page.getByTestId("remove-3").click();
    await page.getByTestId("undo-3").click();
    await expect(page.getByTestId("step-card-3")).toHaveAttribute("data-status", "pending");
    const sent = await page.evaluate(() => (window as unknown as { __decisions: { action: string; source: string }[] }).__decisions);
    expect(sent.map((d) => `${d.action}:${d.source}`)).toEqual(["remove:plan_panel", "restore:plan_panel"]);
  });

  test("run view keeps original indices 1, 2, 4 and lists removed actions", async ({ page }) => {
    const pts = [await center(page, "badge-1"), await center(page, "badge-2"), await center(page, "badge-4")];
    await loopAround(page, pts);
    for (const i of [3, 5, 6]) await page.getByTestId(`remove-${i}`).click();
    await expect(page.getByTestId("approve-run")).toBeEnabled();
    await page.getByTestId("approve-run").click();
    await expect(page.getByTestId("execution-view")).toBeVisible({ timeout: 10_000 });
    for (const i of [1, 2, 4]) await expect(page.getByTestId(`progress-${i}`)).toBeVisible();
    for (const i of [3, 5, 6]) await expect(page.getByTestId(`progress-${i}`)).toHaveCount(0);
    await expect(page.getByTestId("removed-action")).toBeVisible();
    await expect(page.getByTestId("final-result")).toContainText("All approved steps were attempted.", { timeout: 45_000 });
  });
});
