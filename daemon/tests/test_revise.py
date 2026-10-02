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
