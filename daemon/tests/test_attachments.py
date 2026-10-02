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
