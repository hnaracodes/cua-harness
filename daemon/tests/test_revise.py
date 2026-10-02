import asyncio

import pytest

from oversight import fixtures
from oversight.llm import CallRecord, ImageInput, LLMError
from oversight.replanner import (
    RevisedStep,
    fixture_replan,
    merge_revision,
    replan,
    validate_revision,
)


def _steps(statuses=("pending",) * 6):
    return [{"id": f"stp_{i + 1}", "task_id": "tsk_1", "index": i + 1, "title": t,
             "description": d, "glyph": g, "status": statuses[i], "edited_from": None,
             "revision": 0} for i, (t, d, g) in enumerate(fixtures.STEPS)]


def test_fixture_replan_grammar_drop_and_add():
    cur = _steps()
    out = fixture_replan(cur, "drop 6; add Ask the party group for a date")
    assert [r.keep_step_id for r in out] == ["stp_1", "stp_2", "stp_3", "stp_4", "stp_5", None]
    assert out[-1].title == "Ask the party group for a date"
    assert [r.title for r in out[:5]] == [s["title"] for s in cur[:5]]


def test_fixture_replan_free_text_revises_last_active_step():
    cur = _steps(("pending",) * 5 + ("removed",))
    out = fixture_replan(cur, "only message the party group")
    assert out[4].keep_step_id == "stp_5"
    assert out[4].title == cur[4]["title"] + " (revised: only message the party group)"
    assert out[5].title == cur[5]["title"]  # removed step kept verbatim, stays removed


def test_fixture_replan_without_instruction_keeps_everything():
    cur = _steps()
    out = fixture_replan(cur, None)
    assert [(r.keep_step_id, r.title, r.description) for r in out] == \
        [(s["id"], s["title"], s["description"]) for s in cur]


def test_merge_revision_classifies_and_preserves():
    cur = _steps(("approved", "pending", "pending", "pending", "removed", "pending"))
    cur[1]["edited_from"] = "Old title"
    revised = [
        RevisedStep("stp_1", cur[0]["title"], cur[0]["description"], "search"),   # unchanged
        RevisedStep("stp_2", cur[1]["title"], cur[1]["description"], "compare"),  # unchanged
        RevisedStep("stp_4", "Draft a shorter message", "Keep it to two lines.", "message"),  # changed
        RevisedStep("stp_5", cur[4]["title"], cur[4]["description"], "contacts"),  # unchanged, removed
        RevisedStep(None, "Ask for a date", "Ask the group which date works.", "message"),  # new
    ]
    m = merge_revision("tsk_1", cur, revised)
    assert m.unchanged == {"stp_1", "stp_2", "stp_5"}
    assert m.changed == {"stp_4"}
    assert m.dropped == {"stp_3", "stp_6"}
    assert len(m.added) == 1
    by = {s["id"]: s for s in m.steps}
    assert [s["index"] for s in m.steps] == [1, 2, 3, 4, 5]
    assert by["stp_1"]["status"] == "approved"
    assert by["stp_5"]["status"] == "removed"
    assert by["stp_2"]["edited_from"] == "Old title"
    assert (by["stp_4"]["status"], by["stp_4"]["revision"]) == ("pending", 1)
    new = by[next(iter(m.added))]
    assert new["status"] == "pending" and new["task_id"] == "tsk_1" and new["revision"] == 0


def test_merge_revision_duplicate_or_unknown_ids_become_new_steps():
    cur = _steps()
    revised = [RevisedStep("stp_1", "A", "a", "generic"), RevisedStep("stp_1", "B", "b", "generic"),
               RevisedStep("stp_99", "C", "c", "generic")]
    m = merge_revision("tsk_1", cur, revised)
    assert m.steps[0]["id"] == "stp_1"
    assert len(m.added) == 2 and "stp_99" not in {s["id"] for s in m.steps}


def test_validate_revision_drops_unknown_keep_ids_and_bad_glyphs():
    data = {"steps": [{"keep_step_id": "stp_1", "title": "A", "description": "a", "glyph": "search"},
                      {"keep_step_id": "nope", "title": "B", "description": "b", "glyph": "rocket"},
                      {"keep_step_id": None, "title": "C", "description": "c", "glyph": "send"},
                      {"keep_step_id": None, "title": "D", "description": "d", "glyph": "send"}]}
    out = validate_revision(data, {"stp_1"})
    assert [r.keep_step_id for r in out] == ["stp_1", None, None, None]
    assert out[1].glyph == "generic"
    with pytest.raises(LLMError):
        validate_revision({"steps": data["steps"][:2]}, {"stp_1"})  # fewer than 4 steps
    with pytest.raises(LLMError):
        validate_revision({"steps": [{"keep_step_id": None, "title": "", "description": "x",
                                      "glyph": "send"}] * 4}, set())


class _FakeLLM:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    async def call(self, **kw):
        self.calls.append(kw)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply, CallRecord(scope="plan", provider="fake", model="fake")


def _reply(cur):
    return {"steps": [{"keep_step_id": s["id"], "title": s["title"], "description": s["description"],
                       "glyph": s["glyph"]} for s in cur]}


def test_replan_prompt_carries_statuses_instruction_and_images():
    cur = _steps(("approved", "pending", "pending", "pending", "removed", "pending"))
    llm = _FakeLLM([_reply(cur)])
    seen = []

    async def on_call(rec):
        seen.append(rec)

    out = asyncio.run(replan(llm, "the task", cur, "skip the cart", images=[ImageInput("image/png", b"x")],
                             on_call=on_call))
    assert [r.keep_step_id for r in out] == [s["id"] for s in cur]
    kw = llm.calls[0]
    assert kw["schema_name"] == "revise" and kw["scope"] == "plan"
    assert "id=stp_1 [approved]" in kw["user"] and "id=stp_5 [removed]" in kw["user"]
    assert "skip the cart" in kw["user"] and "the task" in kw["user"]
    assert [i.mime for i in kw["images"]] == ["image/png"]
    assert len(seen) == 1


def test_replan_retries_once_then_fails():
    cur = _steps()
    llm = _FakeLLM([{"steps": []}, _reply(cur)])
    assert len(asyncio.run(replan(llm, "t", cur, None))) == 6
    llm = _FakeLLM([{"steps": []}, {"steps": []}])
    with pytest.raises(LLMError, match="replanner failed"):
        asyncio.run(replan(llm, "t", cur, None))


from fastapi.testclient import TestClient

from oversight.api import ActiveRun, create_app
from oversight.routes import revise as revise_routes
from oversight.settings import Settings

OTHER = ("financial_commitment", "verifiability")


@pytest.fixture
def client(tmp_path):
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        yield c


def _plan(client):
    tid = client.post("/task", json={"prompt": fixtures.TASK_PROMPT}).json()["task_id"]
    body = client.post(f"/task/{tid}/plan").json()
    return tid, {s["index"]: s for s in body["steps"]}, body["scores"]


def _events(client, tid, kind):
    return [e for e in client.app.state.oversight.store.get_events(tid) if e["kind"] == kind]


def test_repropose_preserves_state(client):
    # Review Focus #3: mixed polygon/check/remove state on two axis pairs.
    tid, steps, scores = _plan(client)
    x, y = fixtures.DEMO_AXES
    client.put(f"/task/{tid}/boundary", json={"x_dim": x, "y_dim": y, "polygon": fixtures.DEMO_POLYGON})
    client.put(f"/task/{tid}/boundary", json={"x_dim": OTHER[0], "y_dim": OTHER[1],
                                              "polygon": [[0, 0], [0.3, 0], [0.3, 0.3]]})
    client.post(f"/task/{tid}/decision", json={"step_id": steps[3]["id"], "action": "check", "source": "step_list"})
    client.post(f"/task/{tid}/decision", json={"step_id": steps[5]["id"], "action": "remove", "source": "step_list"})

    r = client.post(f"/task/{tid}/repropose", json={"instruction": "drop 6; add Ask the party group for a date"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["revision"] == 1 and body["task_id"] == tid
    new = {s["index"]: s for s in body["steps"]}
    assert [new[i]["id"] for i in range(1, 6)] == [steps[i]["id"] for i in range(1, 6)]
    assert steps[6]["id"] not in {s["id"] for s in body["steps"]}
    assert new[6]["title"] == "Ask the party group for a date" and new[6]["status"] == "pending"
    assert new[3]["status"] == "approved" and new[5]["status"] == "removed"

    before = sorted((s for s in scores if s["step_id"] == steps[1]["id"]), key=lambda s: s["dimension"])
    after = sorted((s for s in body["scores"] if s["step_id"] == steps[1]["id"]), key=lambda s: s["dimension"])
    assert before == after
    assert len([s for s in body["scores"] if s["step_id"] == new[6]["id"]]) == 10

    pairs = {(b["x_dim"], b["y_dim"]) for b in client.app.state.oversight.store.get_boundaries(tid)}
    assert pairs == {(x, y), OTHER}

    ev = _events(client, tid, "plan_revised")[-1]["payload"]
    assert ev == {"revision": 1, "instruction": "drop 6; add Ask the party group for a date",
                  "changed_step_ids": [], "added_step_ids": [new[6]["id"]],
                  "dropped_step_ids": [steps[6]["id"]]}
    decs = [(d["step_id"], d["action"], d["source"]) for d in client.get(f"/task/{tid}").json()["decisions"]]
    assert (steps[6]["id"], "revise", "chat") in decs and (new[6]["id"], "revise", "chat") in decs
    stages = [e["payload"]["stage"] for e in _events(client, tid, "plan_progress")]
    assert stages[-3:] == ["planning", "scoring", "done"]

    assert client.post(f"/task/{tid}/repropose", json={"instruction": None}).json()["revision"] == 2


def test_repropose_rewrite_goes_pending_and_rescored(client):
    tid, steps, _ = _plan(client)
    client.post(f"/task/{tid}/decision", json={"step_id": steps[6]["id"], "action": "check", "source": "step_list"})
    body = client.post(f"/task/{tid}/repropose", json={"instruction": "only message the party group"}).json()
    s6 = next(s for s in body["steps"] if s["id"] == steps[6]["id"])
    assert s6["title"].endswith("(revised: only message the party group)")
    assert (s6["status"], s6["revision"]) == ("pending", 1)
    ev = _events(client, tid, "plan_revised")[-1]["payload"]
    assert ev["changed_step_ids"] == [steps[6]["id"]]


def test_repropose_errors(client):
    assert client.post("/task/tsk_nope/repropose", json={"instruction": "x"}).status_code == 404
    tid = client.post("/task", json={"prompt": "p"}).json()["task_id"]
    assert client.post(f"/task/{tid}/repropose", json={"instruction": "x"}).status_code == 409

    tid, _steps_, _ = _plan(client)
    st = client.app.state.oversight
    st.active_runs[tid] = ActiveRun(run_id="run_x", stop=asyncio.Event())
    assert client.post(f"/task/{tid}/repropose", json={"instruction": "x"}).status_code == 409
    del st.active_runs[tid]

    lock = asyncio.Lock()
    asyncio.run(lock.acquire())
    st.plan_locks[tid] = lock
    assert client.post(f"/task/{tid}/repropose", json={"instruction": "x"}).status_code == 409
    lock.release()


def test_repropose_llm_failure_is_502_and_reported(client, monkeypatch):
    tid, steps, _ = _plan(client)

    def boom(current, instruction):
        raise LLMError("model refused the request")

    monkeypatch.setattr(revise_routes, "fixture_replan", boom)
    r = client.post(f"/task/{tid}/repropose", json={"instruction": "x"})
    assert r.status_code == 502 and "model refused" in r.json()["error"]
    assert _events(client, tid, "plan_progress")[-1]["payload"]["stage"] == "error"
    assert [s["id"] for s in client.get(f"/task/{tid}").json()["steps"]] == [steps[i]["id"] for i in range(1, 7)]


def test_repropose_live_path_uses_replan_with_images(client, monkeypatch):
    tid, steps, _ = _plan(client)
    seen = {}

    async def fake_replan(llm, prompt, current, instruction, images=(), on_call=None):
        seen.update(prompt=prompt, instruction=instruction, images=list(images), n=len(current))
        return [RevisedStep(s["id"], s["title"], s["description"], s["glyph"])
                for s in sorted(current, key=lambda s: s["index"])]

    monkeypatch.setattr(revise_routes, "replan", fake_replan)
    client.app.state.oversight.settings.fixtures = False
    client.app.state.oversight.llm = object()  # never called: replan is faked, nothing rescored
    r = client.post(f"/task/{tid}/repropose", json={"instruction": "keep it"})
    client.app.state.oversight.settings.fixtures = True
    assert r.status_code == 200, r.text
    assert seen == {"prompt": fixtures.TASK_PROMPT, "instruction": "keep it", "images": [], "n": 6}


def test_revise_routes_registered(client):
    paths = {getattr(r, "path", "") for r in client.app.routes}
    assert {"/task/{task_id}/repropose", "/task/{task_id}/step/{step_id}"} <= paths


def test_edit_step_flow(client):
    tid, steps, _ = _plan(client)
    sid = steps[4]["id"]
    client.post(f"/task/{tid}/decision", json={"step_id": sid, "action": "check", "source": "step_list"})

    r = client.patch(f"/task/{tid}/step/{sid}", json={"title": "Draft a short party message"})
    assert r.status_code == 200, r.text
    step = r.json()["step"]
    assert step["title"] == "Draft a short party message"
    assert step["description"] == steps[4]["description"]
    assert step["edited_from"] == steps[4]["title"]
    assert step["status"] == "pending"
    assert len(r.json()["scores"]) == 10 and {s["step_id"] for s in r.json()["scores"]} == {sid}

    r2 = client.patch(f"/task/{tid}/step/{sid}", json={"description": "Two lines, no names."})
    assert r2.json()["step"]["edited_from"] == steps[4]["title"]  # first original title kept
    assert r2.json()["step"]["revision"] == 2

    decs = [d for d in client.get(f"/task/{tid}").json()["decisions"] if d["action"] == "edit"]
    assert len(decs) == 2 and decs[0]["source"] == "step_list" and decs[0]["step_id"] == sid
    assert decs[0]["snapshot"]["edited_from"] == steps[4]["title"]


def test_edit_step_errors(client):
    tid, steps, _ = _plan(client)
    sid = steps[1]["id"]
    assert client.patch(f"/task/{tid}/step/{sid}", json={"title": "  ", "description": ""}).status_code == 400
    assert client.patch(f"/task/{tid}/step/stp_nope", json={"title": "x"}).status_code == 404
    assert client.patch(f"/task/tsk_nope/step/{sid}", json={"title": "x"}).status_code == 404
    st = client.app.state.oversight
    st.active_runs[tid] = ActiveRun(run_id="run_x", stop=asyncio.Event())
    assert client.patch(f"/task/{tid}/step/{sid}", json={"title": "x"}).status_code == 409
    del st.active_runs[tid]


def test_edit_step_noop_returns_current_without_decision(client):
    tid, steps, _ = _plan(client)
    sid = steps[2]["id"]
    r = client.patch(f"/task/{tid}/step/{sid}", json={"title": steps[2]["title"]})
    assert r.status_code == 200 and r.json()["step"]["revision"] == 0
    assert not [d for d in client.get(f"/task/{tid}").json()["decisions"] if d["action"] == "edit"]
