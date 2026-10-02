import { expect, test, type Page } from "@playwright/test";

test.use({ colorScheme: "dark" });

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function center(page: Page, testid: string) {
  const b = (await page.getByTestId(testid).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// Loop = convex hull of a circle of radius `pad` around each point (a capsule for two
// points). Tracing the raw points would be a zero-area stroke for two badges, which the
// gesture correctly rejects as "not a loop".
async function loop(page: Page, pts: { x: number; y: number }[], pad = 30) {
  const cloud = pts.flatMap((p) => Array.from({ length: 24 }, (_, k) => ({ x: p.x + pad * Math.cos((k / 24) * 2 * Math.PI), y: p.y + pad * Math.sin((k / 24) * 2 * Math.PI) })));
  cloud.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (src: typeof cloud) => {
    const h: typeof cloud = [];
    for (const p of src) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); }
    return h.slice(0, -1);
  };
  const ring = [...half(cloud), ...half([...cloud].reverse())];
  await page.mouse.move(ring[0].x, ring[0].y);
  await page.mouse.down();
  for (let i = 1; i <= ring.length; i++) {
    const a = ring[i - 1], b = ring[i % ring.length];
    for (let k = 1; k <= 4; k++) await page.mouse.move(a.x + ((b.x - a.x) * k) / 4, a.y + ((b.y - a.y) * k) / 4);
  }
  await page.mouse.up();
}

test("gate 1+3+5: attach → plan → revise → zoom/pan → loop → skip undecided → narrated run → recap → replay", async ({ page }) => {
  await page.goto("/?mock&fast");
  // Home: attach an image
  await page.getByTestId("composer-file").setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1);
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100 and draft a WhatsApp message");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("chat-plan-ready")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-msg-user")).toBeVisible();

  // Revise from chat
  await page.getByTestId("composer-input").fill("only message the party group");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("chat-revised")).toBeVisible({ timeout: 10_000 });

  // Zoom in twice, pan, back to draw, fit
  const label = page.getByTestId("canvas-zoom-label");
  const z0 = await label.textContent();
  await page.getByTestId("canvas-zoom-in").click();
  await page.getByTestId("canvas-zoom-in").click();
  await expect(label).not.toHaveText(z0!);
  await page.getByTestId("canvas-tool-pan").click();
  const c = await center(page, "boundary-canvas");
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 20, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId("canvas-tool-draw").click();
  await page.getByTestId("canvas-fit").click();

  // Loop around 1 and 2 → approved; leave others undecided
  await loop(page, [await center(page, "badge-1"), await center(page, "badge-2")]);
  await expect(page.getByTestId("badge-1")).toHaveAttribute("data-status", "approved");
  const primary = page.getByTestId("run-primary");
  await expect(primary).toHaveText(/^Run \d+ approved, skip \d+/);
  await primary.click();

  // Narrated run ending in a recap
  await expect(page.getByTestId("chat-msg-step").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("desk-frame")).toBeVisible();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 45_000 });
  const live = await page.getByTestId("chat-thread").innerText();

  // History reopen replays the identical chat
  await page.getByTestId("new-task").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await page.getByTestId("history-toggle").click(); // the rail is collapsible (U1)
  await page.getByTestId("history-item").first().click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 10_000 });
  expect(await page.getByTestId("chat-thread").innerText()).toBe(live);
});

test("gate 2: tied badges stack; fan-out approves one member", async ({ page }) => {
  await page.goto("/?mock&fast&many=30");
  await page.getByTestId("composer-input").fill("crowd");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  const stack = page.getByTestId("stack-badge").first();
  await expect(stack).toBeVisible();
  await stack.click();
  await expect(page.getByTestId("fan-out")).toBeVisible();
  const approve = page.locator('[data-testid^="fan-approve-"]').first();
  const i = (await approve.getAttribute("data-testid"))!.replace("fan-approve-", "");
  await approve.click();
  await expect(page.getByTestId(`step-row-${i}`)).toHaveAttribute("data-status", "approved");
});
