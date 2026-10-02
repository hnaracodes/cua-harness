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

test("repropose edits the last non-removed step, or adds one on 'add'", async ({ page }) => {
  await mock(page, "fast");
  const r = await page.evaluate(async () => {
    const api = (window as any).__oversightMock.api;
    const { task_id } = await api.createTask("revise me");
    const plan = await api.plan(task_id);
    const last = plan.steps[plan.steps.length - 1];
    const prev = plan.steps[plan.steps.length - 2];
    await api.decision(task_id, { step_id: last.id, action: "remove", source: "step_list" });
    const events: any[] = [];
    api.subscribe(task_id, 0, (e: any) => events.push(e));
    const a = await api.repropose(task_id, "only message the party group");
    const b = await api.repropose(task_id, "add a step to compare reviews");
    const revised = events.filter((e) => e.kind === "plan_revised").map((e) => e.payload);
    let conflict = 0;
    try {
      const { task_id: t2 } = await api.createTask("no plan");
      await api.repropose(t2, "x");
    } catch (e: any) {
      conflict = e.status;
    }
    return {
      prevId: prev.id, prevTitle: prev.title,
      aStep: a.steps.find((s: any) => s.id === prev.id),
      aRev: a.revision, bLen: b.steps.length, bLast: b.steps[b.steps.length - 1],
      revised, before: plan.steps.length, conflict,
      scoresForNew: b.scores.filter((s: any) => s.step_id === b.steps[b.steps.length - 1].id).length,
    };
  });
  expect(r.aStep.title).toContain("only message the party group");
  expect(r.aStep.edited_from).toBe(r.prevTitle);
  expect(r.aRev).toBe(1);
  expect(r.revised[0]).toMatchObject({ revision: 1, instruction: "only message the party group", changed_step_ids: [r.prevId], added_step_ids: [], dropped_step_ids: [] });
  expect(r.bLen).toBe(r.before + 1);
  expect(r.bLast.status).toBe("pending");
  expect(r.revised[1].added_step_ids).toEqual([r.bLast.id]);
  expect(r.scoresForNew).toBe(10);
  expect(r.conflict).toBe(409);
});

test("listTasks is newest first", async ({ page }) => {
  await mock(page, "fast");
  const ids = await page.evaluate(async () => {
    const api = (window as any).__oversightMock.api;
    const a = (await api.createTask("first")).task_id;
    await new Promise((r) => setTimeout(r, 5));
    const b = (await api.createTask("second")).task_id;
    return { a, b, list: (await api.listTasks()).map((t: any) => t.id) };
  });
  expect(ids.list.slice(0, 2)).toEqual([ids.b, ids.a]);
});
