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

/** Plan, approve everything, run, and collect events until final_result. */
async function runAll(page: Page, removeIndex: number | null = null) {
  return page.evaluate(async (rm) => {
    const api = (window as any).__oversightMock.api;
    const { task_id } = await api.createTask("run me");
    const plan = await api.plan(task_id);
    const removed = rm ? [plan.steps[rm - 1].id] : [];
    const approved = plan.steps.map((s: any) => s.id).filter((id: string) => !removed.includes(id));
    const events: any[] = [];
    const done = new Promise<void>((res) => {
      api.subscribe(task_id, 0, (e: any) => {
        events.push(e);
        if (e.kind === "final_result") res();
      });
    });
    const r = await api.run(task_id, { approved_step_ids: approved, checked_step_ids: approved, removed_step_ids: removed, boundaries: [] });
    await done;
    const frames = events.filter((e) => e.kind === "frame");
    return { ok: r.ok, task_id, events, frameUrl: frames.length ? api.frameUrl(task_id, frames[0].payload.seq) : "" };
  }, removeIndex);
}

test("a run narrates: actions/duration on step_result, frames, recap before final", async ({ page }) => {
  await mock(page, "fast");
  const r = await runAll(page, 3);
  expect(r.ok).toBe(true);
  const kinds = r.events.map((e: any) => e.kind);
  const results = r.events.filter((e: any) => e.kind === "step_result");
  expect(results.length).toBe(5);
  for (const e of results) {
    expect(e.payload.actions).toBeGreaterThan(0);
    expect(e.payload.duration_ms).toBeGreaterThanOrEqual(0);
  }
  const nActions = kinds.filter((k: string) => k === "action").length;
  expect(kinds.filter((k: string) => k === "frame").length).toBe(nActions);
  const seqs = r.events.filter((e: any) => e.kind === "frame").map((e: any) => e.payload.seq);
  expect(seqs).toEqual(seqs.map((_: number, i: number) => i + 1));
  expect(kinds.filter((k: string) => k === "run_recap").length).toBe(1);
  expect(kinds.indexOf("run_recap")).toBe(kinds.indexOf("final_result") - 1);
  const recap = r.events.find((e: any) => e.kind === "run_recap").payload;
  expect(recap.source).toBe("fallback");
  expect(recap.done.length).toBe(5);
  expect(recap.skipped.map((s: any) => s.reason)).toEqual(["You removed this step before the run."]);
  expect(r.frameUrl.startsWith("data:image/svg+xml")).toBe(true);
  expect(decodeURIComponent(r.frameUrl)).toContain("Search for tennis rackets under $100");
});
