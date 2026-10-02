import asyncio

import pytest
from fastapi.testclient import TestClient

from oversight import fixtures
from oversight.api import create_app
from oversight.llm import ImageInput, StructuredLLM
from oversight.settings import Settings


@pytest.fixture
def client(tmp_path):
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        yield c


def test_scores_for_steps_fixture_and_synthetic():
    steps = [{"id": "a", "index": 1, "title": fixtures.STEPS[0][0]},
             {"id": "b", "index": 2, "title": "Something new"}]
    sc = fixtures.scores_for_steps(steps)
    assert len(sc) == 20
    assert [x.to_api() for x in sc] == [x.to_api() for x in fixtures.scores_for_steps(steps)]
    assert [x for x in sc if x.step_id == "a"] == fixtures.fixture_scores({1: "a"})
    assert all(0.0 <= x.position <= 1.0 for x in sc)


def test_health_has_setup_fields(client):
    h = client.get("/health").json()
    assert h["setup_complete"] is False and h["plan_only"] is False
    client.app.state.oversight.store.set_setting("setup_complete", True)
    assert client.get("/health").json()["setup_complete"] is True


def test_task_attachments_validation(client):
    store = client.app.state.oversight.store
    aid = store.add_attachment("s1", "image/png", 3, "/nope.png")
    r = client.post("/task", json={"prompt": "p", "attachment_ids": [aid]})
    assert r.status_code == 200
    tid = r.json()["task_id"]
    got = client.get(f"/task/{tid}").json()["task"]["attachments"]
    assert got == [{"attachment_id": aid, "mime": "image/png", "bytes": 3}]
    assert client.post("/task", json={"prompt": "p", "attachment_ids": ["att_x"]}).status_code == 400
    ids = [store.add_attachment(f"h{i}", "image/png", 1, "/n") for i in range(5)]
    assert client.post("/task", json={"prompt": "p", "attachment_ids": ids}).status_code == 400
    # missing files are skipped, never crash planning
    assert client.app.state.ctx.load_images(tid) == []


def test_ctx_score_steps_fixture_mode(client):
    ctx = client.app.state.ctx
    tid = client.post("/task", json={"prompt": "p"}).json()["task_id"]
    out = asyncio.run(ctx.score_steps(tid, "p", [
        {"id": "s1", "index": 1, "title": "Brand new step", "description": "d"}]))
    assert len(out) == 10 and {o["step_id"] for o in out} == {"s1"}


def test_llm_and_planner_accept_images_param():
    # Signature only: track D2 replaces the Wave 0 gate without editing this frozen file.
    import inspect
    from oversight.planner import plan_task
    assert "images" in inspect.signature(StructuredLLM.call).parameters
    assert "images" in inspect.signature(plan_task).parameters
    assert ImageInput("image/png", b"x").mime == "image/png"
