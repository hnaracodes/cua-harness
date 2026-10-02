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
