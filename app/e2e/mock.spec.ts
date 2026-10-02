import { expect, test, type Page } from "@playwright/test";

/** Wait until the app has created its mock and exposed it. */
async function mock(page: Page, query: string) {
  await page.goto(`/?mock&${query}`);
  await page.waitForFunction(() => !!(window as unknown as { __oversightMock?: unknown }).__oversightMock);
}

test("?many=30 plans 30 steps with at least one exact tie", async ({ page }) => {
  await mock(page, "fast&many=30");
  const r = await page.evaluate(async () => {
    const api = (window as any).__oversightMock.api;
    const { task_id } = await api.createTask("crowd");
    const plan = await api.plan(task_id);
    const pts = new Map<string, string[]>();
    for (const s of plan.steps) {
      const x = plan.scores.find((c: any) => c.step_id === s.id && c.dimension === "action_uncertainty").position;
      const y = plan.scores.find((c: any) => c.step_id === s.id && c.dimension === "reversibility").position;
      const k = `${x}|${y}`;
      pts.set(k, [...(pts.get(k) ?? []), s.id]);
    }
    return { n: plan.steps.length, scores: plan.scores.length, maxTie: Math.max(...[...pts.values()].map((v) => v.length)) };
  });
  expect(r.n).toBe(30);
  expect(r.scores).toBe(300);
  expect(r.maxTie).toBeGreaterThanOrEqual(2);
});
