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
