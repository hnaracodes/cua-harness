import asyncio
import base64
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from oversight import api as api_module
from oversight import fixtures
from oversight import planner as planner_module
from oversight.api import create_app
from oversight.llm import CallRecord, ImageInput, LLMError, StructuredLLM
from oversight.planner import IMAGES_NOTE, PlannedStep, plan_task
from oversight.settings import Settings

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 32
HEIC = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 32


@pytest.fixture
def client(tmp_path):
    s = Settings(fixtures=True, exec_mode="simulated", data_dir=tmp_path)
    with TestClient(create_app(s)) as c:
        yield c


def _up(client, data, name="a.png", ctype="image/png"):
    return client.post("/attachments", files={"file": (name, data, ctype)})


def test_upload_png_jpeg_webp_by_magic_bytes(client):
    for data, mime in ((PNG, "image/png"), (JPEG, "image/jpeg"), (WEBP, "image/webp")):
        r = _up(client, data, ctype="application/octet-stream")  # declared type is ignored
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["mime"] == mime and body["bytes"] == len(data)
        assert body["attachment_id"].startswith("att_")


def test_declared_type_never_wins(client):
    r = _up(client, PNG, name="photo.jpg", ctype="image/jpeg")
    assert r.json()["mime"] == "image/png"


def test_attachment_rejections(client, tmp_path):
    # Review Focus #4: 0-byte, HEIC, too big, a fifth image, the same image twice.
    r = _up(client, b"")
    assert r.status_code == 400 and "empty" in r.json()["error"].lower()

    r = _up(client, HEIC, name="IMG_0001.heic", ctype="image/heic")
    assert r.status_code == 400 and "HEIC" in r.json()["error"]

    r = _up(client, b"GIF89a" + b"\x00" * 20, name="a.gif", ctype="image/gif")
    assert r.status_code == 400 and "PNG, JPEG or WebP" in r.json()["error"]

    r = _up(client, PNG + b"\x00" * (6 * 1024 * 1024))
    assert r.status_code == 413 and "5 MB" in r.json()["error"]

    a = _up(client, PNG).json()["attachment_id"]
    b = _up(client, PNG, name="again.png").json()["attachment_id"]
    assert a == b
    assert len(list((tmp_path / "attachments").iterdir())) == 1

    ids = [_up(client, PNG + bytes([i])).json()["attachment_id"] for i in range(5)]
    assert len(set(ids)) == 5
    assert client.post("/task", json={"prompt": "p", "attachment_ids": ids}).status_code == 400
    assert client.post("/task", json={"prompt": "p", "attachment_ids": ids[:4]}).status_code == 200


def test_get_attachment_serves_bytes_with_mime(client):
    aid = _up(client, JPEG, name="x.jpg", ctype="image/jpeg").json()["attachment_id"]
    r = client.get(f"/attachments/{aid}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content == JPEG
    assert client.get("/attachments/att_nope").status_code == 404


def test_task_detail_lists_uploaded_attachments(client):
    aid = _up(client, PNG).json()["attachment_id"]
    tid = client.post("/task", json={"prompt": "p", "attachment_ids": [aid]}).json()["task_id"]
    atts = client.get(f"/task/{tid}").json()["task"]["attachments"]
    assert atts == [{"attachment_id": aid, "mime": "image/png", "bytes": len(PNG)}]
    imgs = client.app.state.ctx.load_images(tid)
    assert len(imgs) == 1 and imgs[0].mime == "image/png" and imgs[0].data == PNG


class _Capture:
    def __init__(self, resp):
        self.kwargs = None
        self.resp = resp

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return self.resp


def _anthropic_llm(monkeypatch):
    monkeypatch.setenv("OVERSIGHT_NO_FALLBACKS", "1")
    resp = SimpleNamespace(
        model="claude-sonnet-5-5", stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=10, output_tokens=5, cache_creation_input_tokens=0,
                              cache_read_input_tokens=0),
        content=[SimpleNamespace(type="text", text='{"ok": true}')])
    cap = _Capture(resp)
    llm = StructuredLLM("anthropic", "claude-sonnet-5-5")
    llm._client = SimpleNamespace(messages=cap, beta=SimpleNamespace(messages=cap))
    return llm, cap


def _openai_llm():
    resp = SimpleNamespace(
        model="gpt-5.5", usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5),
        choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}', refusal=None))])
    cap = _Capture(resp)
    llm = StructuredLLM("openai", "gpt-5.5")
    llm._client = SimpleNamespace(chat=SimpleNamespace(completions=cap))
    return llm, cap


def _call(llm, images=()):
    return asyncio.run(llm.call(scope="plan", system="sys", user="do the task", schema={},
                                schema_name="plan", images=images))


def test_anthropic_image_blocks_precede_text(monkeypatch):
    llm, cap = _anthropic_llm(monkeypatch)
    data, rec = _call(llm, [ImageInput("image/png", PNG), ImageInput("image/jpeg", JPEG)])
    assert data == {"ok": True} and rec.ok
    content = cap.kwargs["messages"][0]["content"]
    assert [b["type"] for b in content] == ["image", "image", "text"]
    assert content[0]["source"] == {"type": "base64", "media_type": "image/png",
                                    "data": base64.b64encode(PNG).decode()}
    assert content[1]["source"]["media_type"] == "image/jpeg"
    assert content[2] == {"type": "text", "text": "do the task"}


def test_anthropic_without_images_is_unchanged(monkeypatch):
    llm, cap = _anthropic_llm(monkeypatch)
    _call(llm)
    assert cap.kwargs["messages"] == [{"role": "user", "content": "do the task"}]


def test_openai_image_blocks_are_data_urls():
    llm, cap = _openai_llm()
    _call(llm, [ImageInput("image/webp", WEBP)])
    user_msg = cap.kwargs["messages"][1]
    assert user_msg["role"] == "user"
    assert user_msg["content"][0] == {
        "type": "image_url",
        "image_url": {"url": "data:image/webp;base64," + base64.b64encode(WEBP).decode()}}
    assert user_msg["content"][1] == {"type": "text", "text": "do the task"}
    assert cap.kwargs["messages"][0] == {"role": "system", "content": "sys"}


def test_unsupported_image_mime_is_an_llm_error(monkeypatch):
    llm, _cap = _anthropic_llm(monkeypatch)
    with pytest.raises(LLMError, match="image/gif"):
        _call(llm, [ImageInput("image/gif", b"GIF89a")])


class _FakePlannerLLM:
    def __init__(self):
        self.calls = []

    async def call(self, **kw):
        self.calls.append(kw)
        steps = [{"title": f"Step {i}", "description": "Do it.", "glyph": "generic"}
                 for i in range(4)]
        return {"steps": steps}, CallRecord(scope="plan", provider="fake", model="fake")


def test_planner_adds_image_note_only_with_images():
    llm = _FakePlannerLLM()
    asyncio.run(plan_task(llm, "p", None))
    asyncio.run(plan_task(llm, "p", None, images=[ImageInput("image/png", PNG)]))
    assert IMAGES_NOTE not in llm.calls[0]["system"] and llm.calls[0]["images"] == ()
    assert llm.calls[1]["system"].endswith(IMAGES_NOTE)
    assert [i.mime for i in llm.calls[1]["images"]] == ["image/png"]


def test_plan_live_sends_task_attachments_to_planner(tmp_path, monkeypatch):
    seen = {}

    async def fake_plan_task(llm, prompt, selected_app, on_call=None, images=()):
        seen["images"] = list(images)
        return [PlannedStep(f"Step {i}", "Do it.", "generic") for i in range(4)]

    class FakeScorer:
        def __init__(self, *a, **k):
            pass

        async def score(self, task, step, context):
            return fixtures.synthetic_scores(step.id, step.title)

    monkeypatch.setattr(api_module, "plan_task", fake_plan_task)
    monkeypatch.setattr(api_module, "LLMScorer", FakeScorer)
    s = Settings(fixtures=False, exec_mode="simulated", data_dir=tmp_path,
                 provider="anthropic", model="claude-sonnet-5-5")
    with TestClient(create_app(s)) as c:
        aid = _up(c, PNG).json()["attachment_id"]
        tid = c.post("/task", json={"prompt": "p", "attachment_ids": [aid]}).json()["task_id"]
        r = c.post(f"/task/{tid}/plan")
        assert r.status_code == 200, r.text
    assert [(i.mime, i.data) for i in seen["images"]] == [("image/png", PNG)]


def test_planner_exports_note():
    assert planner_module.IMAGES_NOTE.strip()
