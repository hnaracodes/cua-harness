# Track D2: Daemon image attachments

> Part of `docs/superpowers/plans/2026-10-02-ui-redesign.md`. Read its Global Constraints, Contracts (C1–C8) and Ownership matrix first. Spec: "Daemon API changes §1 Attachments". Wave 1, Batch A. Starts from `ui-redesign` after Wave 0 is merged.

**Owns (and only these):** `daemon/oversight/routes/attachments.py`, `daemon/oversight/llm.py`, `daemon/oversight/planner.py`, `daemon/tests/test_attachments.py`.

Worktree:

```bash
cd "/Users/hrudaynara/Research/Security CUAs Week 1/appdev"
git worktree add ".worktrees/rd-D2" -b "rd/D2" ui-redesign
cd ".worktrees/rd-D2/daemon" && uv sync
```

All commands below run from `.worktrees/rd-D2/daemon`.

---

## Task D2-1: Upload and serve attachments

**Files:**
- Modify: `daemon/oversight/routes/attachments.py` (replace the Wave 0 stub)
- Test: `daemon/tests/test_attachments.py`

**Interfaces:**
- Consumes: C4 `Ctx` (`ctx.st.store`, `ctx.st.settings.data_dir`), and the store methods `add_attachment`, `get_attachment`, and `get_task_attachments`. Also consumes `POST /task` attachment validation, which W0-1 already implemented: at most 4, unknown → 400.
- Produces: C3 `POST /attachments` returns `{attachment_id, mime, bytes}`, 400 `{error}` (empty or unsupported), 413 `{error}` (>5 MB). C3 `GET /attachments/{id}` returns raw bytes with the stored mime, or 404. Files live at `<data_dir>/attachments/<sha256>.<png|jpg|webp>`.

- [ ] **Step 1: Write the failing tests**

Create `daemon/tests/test_attachments.py`:

```python
import pytest
from fastapi.testclient import TestClient

from oversight.api import create_app
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_attachments.py -q`
Expected: FAIL. The stub registers no routes, so `POST /attachments` returns 404 and asserts like `assert 404 == 200` fail.

- [ ] **Step 3: Implement the routes**

Replace `daemon/oversight/routes/attachments.py` with:

```python
"""Image attachments (spec: Daemon API changes §1). Track D2.

The file type is decided by magic bytes, never by the client's declared content type
or file name. Files are stored once per sha256 under <data_dir>/attachments/.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from fastapi import FastAPI, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from .ctx import Ctx

MAX_BYTES = 5 * 1024 * 1024
CHUNK = 64 * 1024
EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
_HEIF_BRANDS = (b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1", b"avif")


def sniff_mime(head: bytes) -> str | None:
    """PNG, JPEG or WebP from the first bytes, else None."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def unsupported_reason(head: bytes) -> str:
    if len(head) >= 12 and head[4:8] == b"ftyp" and head[8:12] in _HEIF_BRANDS:
        return "HEIC/HEIF images aren't supported. Export it as JPEG or PNG and attach that."
    if head.startswith(b"GIF8"):
        return "GIF isn't supported. Use PNG, JPEG or WebP."
    return "Unsupported file type. Use PNG, JPEG or WebP."


def _err(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


def register(app: FastAPI, ctx: Ctx) -> None:
    store = ctx.st.store
    root = Path(ctx.st.settings.data_dir) / "attachments"

    @app.post("/attachments")
    async def upload_attachment(file: UploadFile):
        buf = bytearray()
        while True:
            chunk = await file.read(CHUNK)
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > MAX_BYTES:  # stop reading early; never buffer a huge upload
                return _err(413, "Images must be 5 MB or smaller.")
        if not buf:
            return _err(400, "The file is empty.")
        head = bytes(buf[:16])
        mime = sniff_mime(head)
        if mime is None:
            return _err(400, unsupported_reason(head))
        data = bytes(buf)
        sha = hashlib.sha256(data).hexdigest()
        root.mkdir(parents=True, exist_ok=True)
        path = root / f"{sha}.{EXT[mime]}"
        if not path.exists():
            tmp = path.with_suffix(path.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(path)  # atomic: a half-written file is never served
        aid = store.add_attachment(sha, mime, len(data), str(path))
        return {"attachment_id": aid, "mime": mime, "bytes": len(data)}

    @app.get("/attachments/{attachment_id}")
    async def get_attachment(attachment_id: str):
        a = store.get_attachment(attachment_id)
        if a is None or not Path(a["path"]).is_file():
            return _err(404, "attachment not found", attachment_id=attachment_id)
        return FileResponse(a["path"], media_type=a["mime"])
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_attachments.py -q`
Expected: `5 passed`.

- [ ] **Step 5: Run the whole suite**

Run: `uv run pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add oversight/routes/attachments.py tests/test_attachments.py
git commit -m "daemon: image attachments (magic-byte sniffing, sha256 dedupe, 5 MB cap)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Task D2-2: Images reach the model (LLM blocks + planner)

**Files:**
- Modify: `daemon/oversight/llm.py` (remove the Wave 0 gate, build image blocks)
- Modify: `daemon/oversight/planner.py` (one system-prompt sentence when images are attached)
- Test: `daemon/tests/test_attachments.py` (append)

**Interfaces:**
- Consumes: C4 `ImageInput(mime, data)`, `StructuredLLM.call(..., images=())`, `plan_task(..., images=())`. Also consumes W0-1's `plan_live`, which already passes `images=load_images(task_id)`.
- Produces: `StructuredLLM.call` with non-empty `images` sends:
  - **Anthropic:** user content `[{"type":"image","source":{"type":"base64","media_type":mime,"data":b64}}, ..., {"type":"text","text":user}]`.
  - **OpenAI:** user content `[{"type":"image_url","image_url":{"url":"data:<mime>;base64,<b64>"}}, ..., {"type":"text","text":user}]`.

  An unsupported mime raises `LLMError`. With no images the request is unchanged (content stays a plain string). The planner exports `IMAGES_NOTE`.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/tests/test_attachments.py`:

```python
import asyncio
import base64
from types import SimpleNamespace

from oversight import api as api_module
from oversight import fixtures
from oversight import planner as planner_module
from oversight.llm import CallRecord, ImageInput, LLMError, StructuredLLM
from oversight.planner import IMAGES_NOTE, PlannedStep, plan_task


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
```

Also add `planner_module` to the module's unused-import guard by using it once:

```python
def test_planner_exports_note():
    assert planner_module.IMAGES_NOTE.strip()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_attachments.py -q`
Expected: collection FAILS with `ImportError: cannot import name 'IMAGES_NOTE' from 'oversight.planner'`.

- [ ] **Step 3: Build the image blocks in `llm.py`**

In `daemon/oversight/llm.py`:

1. Add `import base64` to the stdlib imports.
2. Add these helpers below the `ImageInput` dataclass:

```python
IMAGE_MIMES = ("image/png", "image/jpeg", "image/webp")


def _check_images(images: Sequence[ImageInput]) -> None:
    for im in images:
        if im.mime not in IMAGE_MIMES:
            raise LLMError(f"unsupported image type {im.mime}; use PNG, JPEG or WebP")


def anthropic_user_content(user: str, images: Sequence[ImageInput]) -> str | list[dict]:
    """Plain string when there are no images (request unchanged), else image blocks + text."""
    if not images:
        return user
    blocks: list[dict] = [{"type": "image", "source": {
        "type": "base64", "media_type": im.mime,
        "data": base64.b64encode(im.data).decode()}} for im in images]
    blocks.append({"type": "text", "text": user})
    return blocks


def openai_user_content(user: str, images: Sequence[ImageInput]) -> str | list[dict]:
    if not images:
        return user
    blocks: list[dict] = [{"type": "image_url", "image_url": {
        "url": f"data:{im.mime};base64,{base64.b64encode(im.data).decode()}"}} for im in images]
    blocks.append({"type": "text", "text": user})
    return blocks
```

3. In `call`, delete the Wave 0 gate (the `if images: raise LLMError("image input not implemented")` lines and their comment). Change the dispatch inside the `try:` to:

```python
            _check_images(images)
            if self.provider == "anthropic":
                data = await self._call_anthropic(rec, system, user, schema, effort, max_tokens,
                                                  images)
            elif self.provider == "openai":
                data = await self._call_openai(rec, system, user, schema, schema_name, images)
            else:
                raise LLMError(f"unknown provider {self.provider}")
```

4. Change the `_call_anthropic` signature and its message:

```python
    async def _call_anthropic(self, rec: CallRecord, system: str, user: str, schema: dict,
                              effort: str, max_tokens: int,
                              images: Sequence[ImageInput] = ()) -> dict:
```

and in its `kwargs`:

```python
            messages=[{"role": "user", "content": anthropic_user_content(user, images)}],
```

5. Change the `_call_openai` signature and its messages:

```python
    async def _call_openai(self, rec: CallRecord, system: str, user: str, schema: dict,
                           schema_name: str, images: Sequence[ImageInput] = ()) -> dict:
```

```python
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": openai_user_content(user, images)}],
```

- [ ] **Step 4: Add the planner note**

In `daemon/oversight/planner.py`, add this below `SYSTEM`:

```python
IMAGES_NOTE = ("\nThe user attached one or more images with the task. Treat them as context the "
               "user provided (for example a product, a form, or a screenshot to work from). "
               "Plan only the actions the task asks for; never plan to upload or forward the "
               "images unless the task says to.")
```

In `plan_task`, add `system = SYSTEM + IMAGES_NOTE if images else SYSTEM` right after the `user = ...` lines. In the `llm.call(...)`, pass `system=system` instead of `system=SYSTEM`. Add `"IMAGES_NOTE"` to `__all__`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_attachments.py -q`
Expected: `12 passed`.

Run: `uv run pytest -q`
Expected: all pass.

W0-1's `test_llm_and_planner_accept_images_param` checks only the signature, so removing the gate breaks no frozen test.

- [ ] **Step 6: Commit**

```bash
git add oversight/llm.py oversight/planner.py tests/test_attachments.py
git commit -m "daemon: attached images reach the planner (Anthropic + OpenAI image blocks)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01FcgVw1DNaGHuPko3uy1RBq"
```

---

## Contract notes

- Resolved in Wave 0: the W0-1 image test checks the signature only.
- `POST /attachments` with no `file` field returns the daemon's existing 422 `{error: "invalid request body"}` (the global validation handler), not 400. The UI always sends `file`.
- `/health` and `SetupStatus` don't expose the provider name for the "Sent to {Provider}" note. The UI reads it from `GET /settings` (`AppSettings.provider`, D1).
