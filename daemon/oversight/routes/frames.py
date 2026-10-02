"""Agent desk frames (track D4): the window-scoped capture the model saw, as JPEG."""

from __future__ import annotations

import io
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse

from .ctx import Ctx

MAX_FRAME_WIDTH = 1600
JPEG_QUALITY = 80


def save_frame_jpeg(png: bytes, dest: Path) -> None:
    """Decode `png`, downscale to MAX_FRAME_WIDTH keeping aspect, write JPEG to `dest`.
    Raises on undecodable input (the caller drops that frame)."""
    from PIL import Image

    with Image.open(io.BytesIO(png)) as im:
        im.load()
        rgb = im.convert("RGB")
    if rgb.width > MAX_FRAME_WIDTH:
        h = max(1, round(rgb.height * MAX_FRAME_WIDTH / rgb.width))
        rgb = rgb.resize((MAX_FRAME_WIDTH, h))
    dest.parent.mkdir(parents=True, exist_ok=True)
    rgb.save(dest, "JPEG", quality=JPEG_QUALITY)


def register(app: FastAPI, ctx: Ctx) -> None:
    store = ctx.st.store

    @app.get("/task/{task_id}/frames/{seq}.jpg")
    async def get_frame(task_id: str, seq: int):
        fr = store.get_frame(task_id, seq)
        if fr is None or not Path(fr["path"]).is_file():
            return JSONResponse({"error": "frame not found", "task_id": task_id, "seq": seq},
                                status_code=404)
        return FileResponse(fr["path"], media_type="image/jpeg")
