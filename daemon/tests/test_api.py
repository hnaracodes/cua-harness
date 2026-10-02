import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from oversight import executor, fixtures
from oversight.api import create_app
from oversight.settings import Settings


@pytest.fixture
def client(tmp_path):
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        yield c


def _plan(client):
    tid = client.post("/task", json={"prompt": fixtures.TASK_PROMPT}).json()["task_id"]
    body = client.post(f"/task/{tid}/plan").json()
    return tid, body


def test_plan_fixture_shape(client):
    tid, body = _plan(client)
    assert len(body["steps"]) == 6
    assert len(body["scores"]) == 60
    kinds = [e["kind"] for e in client.app.state.oversight.store.get_events(tid)]
    assert kinds[0] == "plan_progress" and "cost" in kinds
    # replay: second call returns the same plan, no regeneration
    again = client.post(f"/task/{tid}/plan").json()
    assert [s["id"] for s in again["steps"]] == [s["id"] for s in body["steps"]]


def test_run_flow_and_409(client):
    tid, body = _plan(client)
    steps = {s["index"]: s["id"] for s in body["steps"]}
    x, y = fixtures.DEMO_AXES
    r = client.put(f"/task/{tid}/boundary",
                   json={"x_dim": x, "y_dim": y, "polygon": fixtures.DEMO_POLYGON}).json()
    assert sorted(r["inside_step_ids"]) == sorted([steps[1], steps[2], steps[4]])
    removed = [steps[3], steps[5], steps[6]]
    bounds = [{"x_dim": x, "y_dim": y, "polygon": fixtures.DEMO_POLYGON}]

    bad = client.post(f"/task/{tid}/run", json={
        "approved_step_ids": [steps[1], steps[2], steps[4], steps[6]],
        "checked_step_ids": [], "removed_step_ids": removed[:2], "boundaries": bounds})
    assert bad.status_code == 409
    assert "expected" in bad.json() and "got" in bad.json()

    pend = client.post(f"/task/{tid}/run", json={
        "approved_step_ids": [steps[1], steps[2], steps[4]],
        "checked_step_ids": [], "removed_step_ids": [steps[3]], "boundaries": bounds})
    assert pend.status_code == 409 and pend.json()["pending"]

    ok = client.post(f"/task/{tid}/run", json={
        "approved_step_ids": [steps[1], steps[2], steps[4]],
        "checked_step_ids": [], "removed_step_ids": removed, "boundaries": bounds})
    assert ok.status_code == 200, ok.text
    for _ in range(100):
        runs = client.get(f"/task/{tid}").json()["runs"]
        if runs and runs[0]["status"] != "running":
            break
        time.sleep(0.05)
    assert runs[0]["status"] == "completed"
    evs = client.app.state.oversight.store.get_events(tid)
    run_kinds = [e["kind"] for e in evs if e["run_id"]]
    assert run_kinds[0] == "consideration_scored"
    assert run_kinds[1:4] == ["step_removed"] * 3
    started = [e["payload"]["step_id"] for e in evs if e["kind"] == "step_started"]
    assert started == [steps[1], steps[2], steps[4]]
    assert evs[-1]["kind"] == "final_result"
    assert evs[-1]["payload"]["message"] == "All approved steps were attempted."
    decisions = client.get(f"/task/{tid}").json()["decisions"]
    rem = [d for d in decisions if d["action"] == "remove"]
    assert len(rem) == 3 and len(rem[0]["snapshot"]["scores"]) == 10


def test_executor_refuses_unapproved_step():
    s = executor.ExecStep(id="x", index=1, title="t", description="d")

    async def emit(kind, payload):
        pass

    with pytest.raises(executor.UnapprovedStepError):
        asyncio.run(executor.run_steps("p", [s], frozenset(), emit, asyncio.Event(),
                                       executor.ExecConfig(mode="simulated")))


def test_dimensions_and_health(client):
    d = client.get("/dimensions").json()["dimensions"]
    assert len(d) == 10 and d[0]["anchors"] == [0.125, 0.375, 0.625, 0.875]
    h = client.get("/health").json()
    assert h["daemon"] == "ok" and h["provider"] == "fixtures"


# ------------------------------------------------------------ review fixes


def _all_ids(body):
    return {s["index"]: s["id"] for s in body["steps"]}


def test_concurrent_live_runs_one_wins_and_stays_stoppable(tmp_path, monkeypatch):
    """Two /run calls racing through the (awaiting) live preflight: one gets 409, and
    /stop reaches the run that is actually executing."""
    import httpx

    from oversight import api as api_mod

    async def slow_status(force=False):
        await asyncio.sleep(0.05)  # the real probe shells out to cua-driver and yields
        return True, "running", "ok"

    started: list[asyncio.Event] = []

    async def fake_run_steps(prompt, steps, approved_ids, emit, stop, config):
        started.append(stop)
        for _ in range(100):
            if stop.is_set():
                return {"status": "stopped", "message": "Stopped by the user.",
                        "attempted": [], "completed": []}
            await asyncio.sleep(0.01)
        return {"status": "completed", "message": "All approved steps were attempted.",
                "attempted": [], "completed": []}

    monkeypatch.setattr(api_mod, "cua_driver_status", slow_status)
    monkeypatch.setattr(executor, "run_steps", fake_run_steps)
    app = create_app(Settings(fixtures=True, exec_mode="live", data_dir=tmp_path))

    async def main():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://t") as c:
            tid = (await c.post("/task", json={"prompt": "x"})).json()["task_id"]
            ids = [s["id"] for s in (await c.post(f"/task/{tid}/plan")).json()["steps"]]
            a = {"approved_step_ids": ids[:2], "checked_step_ids": ids[:2],
                 "removed_step_ids": ids[2:], "boundaries": []}
            b = {"approved_step_ids": ids[:3], "checked_step_ids": ids[:3],
                 "removed_step_ids": ids[3:], "boundaries": []}
            r1, r2 = await asyncio.gather(c.post(f"/task/{tid}/run", json=a),
                                          c.post(f"/task/{tid}/run", json=b))
            assert sorted([r1.status_code, r2.status_code]) == [200, 409]
            winner = (r1 if r1.status_code == 200 else r2).json()["run_id"]
            await asyncio.sleep(0.05)
            assert len(started) == 1
            s = (await c.post(f"/task/{tid}/stop")).json()
            assert s == {"stopped": True, "run_id": winner}
            assert started[0].is_set()
            for _ in range(100):
                runs = (await c.get(f"/task/{tid}")).json()["runs"]
                if runs[0]["status"] != "running":
                    break
                await asyncio.sleep(0.02)
            assert [(r["id"], r["status"]) for r in runs] == [(winner, "stopped")]
            assert tid not in app.state.oversight.active_runs

    asyncio.run(main())


def test_live_preflight_failure_writes_nothing(tmp_path, monkeypatch):
    from oversight import api as api_mod

    async def down(force=False):
        return False, "permissions pending", "no grants"

    monkeypatch.setattr(api_mod, "cua_driver_status", down)
    with TestClient(create_app(Settings(fixtures=True, exec_mode="live",
                                        data_dir=tmp_path))) as c:
        tid, body = _plan(c)
        ids = [s["id"] for s in body["steps"]]
        full = [[0, 0], [1, 0], [1, 1], [0, 1]]
        x, y = fixtures.DEMO_AXES
        r = c.post(f"/task/{tid}/run", json={
            "approved_step_ids": ids, "checked_step_ids": [], "removed_step_ids": [],
            "boundaries": [{"x_dim": x, "y_dim": y, "polygon": full}]})
        assert r.status_code == 503
        t = c.get(f"/task/{tid}").json()
        assert t["boundaries"] == [] and t["runs"] == []
        assert tid not in c.app.state.oversight.active_runs


def test_run_honours_stored_removal(client):
    """A stale client cannot run a step the daemon has recorded as removed."""
    tid, body = _plan(client)
    steps = _all_ids(body)
    ids = list(steps.values())
    x, y = fixtures.DEMO_AXES
    full = [{"x_dim": x, "y_dim": y, "polygon": [[0, 0], [1, 0], [1, 1], [0, 1]]}]
    assert client.post(f"/task/{tid}/decision",
                       json={"step_id": steps[6], "action": "remove"}).json() == {"ok": True}

    stale = client.post(f"/task/{tid}/run", json={
        "approved_step_ids": ids, "checked_step_ids": [], "removed_step_ids": [],
        "boundaries": full})
    assert stale.status_code == 409 and stale.json()["removed"] == [steps[6]]
    assert client.get(f"/task/{tid}").json()["runs"] == []

    # Restore brings it back; then the same body is accepted.
    client.post(f"/task/{tid}/decision", json={"step_id": steps[6], "action": "restore"})
    ok = client.post(f"/task/{tid}/run", json={
        "approved_step_ids": ids, "checked_step_ids": [], "removed_step_ids": [],
        "boundaries": full})
    assert ok.status_code == 200, ok.text


def test_forced_replan_drops_stale_boundaries(client):
    tid, body = _plan(client)
    x, y = fixtures.DEMO_AXES
    client.put(f"/task/{tid}/boundary", json={
        "x_dim": x, "y_dim": y, "polygon": [[0, 0], [1, 0], [1, 1], [0, 1]]})
    assert len(client.get(f"/task/{tid}").json()["boundaries"]) == 1
    new = client.post(f"/task/{tid}/plan?force=true").json()
    assert client.get(f"/task/{tid}").json()["boundaries"] == []
    ids = [s["id"] for s in new["steps"]]
    r = client.post(f"/task/{tid}/run", json={
        "approved_step_ids": ids, "checked_step_ids": [], "removed_step_ids": []})
    assert r.status_code == 409 and len(r.json()["pending"]) == len(ids)


@pytest.mark.parametrize("bad", ["NaN", "Infinity", "-Infinity", "1.5", "-0.1"])
def test_boundary_rejects_non_finite_and_out_of_range(client, bad):
    tid, body = _plan(client)
    x, y = fixtures.DEMO_AXES
    raw = f'{{"x_dim": "{x}", "y_dim": "{y}", "polygon": [[{bad}, 0], [1, 0], [1, 1], [0, 1]]}}'
    r = client.put(f"/task/{tid}/boundary", content=raw,
                   headers={"content-type": "application/json"})
    assert r.status_code in (400, 422), r.text
    ids = [s["id"] for s in body["steps"]]
    run_raw = ('{"approved_step_ids": ' + str(ids).replace("'", '"') +
               ', "checked_step_ids": [], "removed_step_ids": [], "boundaries": [' +
               raw + ']}')
    r = client.post(f"/task/{tid}/run", content=run_raw,
                    headers={"content-type": "application/json"})
    assert r.status_code in (400, 422), r.text
    assert client.get(f"/task/{tid}").status_code == 200
