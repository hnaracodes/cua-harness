"""save_document: the executor's one file-writing action.

The agent writes a document (title + Markdown) and the daemon saves it as a new
PDF in the person's Downloads folder. Rules, enforced here rather than by
convention:

* The file always lands in ``directory`` (default ``~/Downloads``). The name is
  reduced to a bare, sanitized file name, so ``../`` or absolute paths cannot
  escape the folder.
* Never overwrite. The file is created with exclusive-create (``"xb"``); if the
  name is taken, `` (2)``, `` (3)``... is appended.
* Content is escaped: Markdown becomes plain HTML with no scripts, and only
  http(s) links survive.

PDF rendering uses Chrome in headless mode with a throwaway profile: no window,
no focus change, and it never touches the user's Chrome profile. Headless Chrome
writes the PDF and then may not exit, so we wait for a complete file (it ends
with ``%%EOF``) and then stop the process.
"""

from __future__ import annotations

import asyncio
import html
import os
import re
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path

MAX_CONTENT_CHARS = 200_000
MAX_NAME_CHARS = 80
CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)

Renderer = Callable[[str, Path], Awaitable[None]]


class DocumentError(RuntimeError):
    pass


def default_documents_dir() -> str:
    return str(Path.home() / "Downloads")


def safe_filename(filename: str, title: str) -> str:
    """A bare ``.pdf`` file name: no folders, no odd characters, never empty."""
    base = Path(str(filename or "").replace("\\", "/")).name or str(title or "")
    base = re.sub(r"\.(pdf|md|txt|html?)$", "", base.strip(), flags=re.IGNORECASE)
    base = re.sub(r"[^\w .()\-]+", " ", base, flags=re.UNICODE)
    base = re.sub(r"\s+", " ", base).strip(" .")[:MAX_NAME_CHARS].strip(" .")
    return f"{base or 'Document'}.pdf"


_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s\"<>]+)\)")  # runs on escaped text
_BOLD = re.compile(r"\*\*(.+?)\*\*")


def _inline(text: str) -> str:
    out = html.escape(text, quote=False)
    out = _LINK.sub(lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>', out)
    return _BOLD.sub(r"<strong>\1</strong>", out)


def markdown_to_html(title: str, content: str) -> str:
    """A small Markdown subset (headings, bullets, numbered lists, bold, http(s)
    links, paragraphs). Everything else is escaped text."""
    body: list[str] = []
    para: list[str] = []
    list_tag: str | None = None

    def flush_para() -> None:
        if para:
            body.append(f"<p>{_inline(' '.join(para))}</p>")
            para.clear()

    def close_list() -> None:
        nonlocal list_tag
        if list_tag:
            body.append(f"</{list_tag}>")
            list_tag = None

    for raw in content.splitlines():
        line = raw.rstrip()
        m_head = re.match(r"^(#{1,3})\s+(.*)$", line)
        m_bullet = re.match(r"^\s*[-*]\s+(.*)$", line)
        m_num = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
        if not line.strip():
            flush_para()
            close_list()
        elif m_head:
            flush_para()
            close_list()
            n = len(m_head.group(1)) + 1
            body.append(f"<h{n}>{_inline(m_head.group(2))}</h{n}>")
        elif m_bullet or m_num:
            flush_para()
            tag = "ul" if m_bullet else "ol"
            if list_tag != tag:
                close_list()
                body.append(f"<{tag}>")
                list_tag = tag
            body.append(f"<li>{_inline((m_bullet or m_num).group(1))}</li>")
        else:
            close_list()
            para.append(line.strip())
    flush_para()
    close_list()
    style = ("body{font:12pt -apple-system,Helvetica,Arial,sans-serif;line-height:1.45;margin:48px;"
             "color:#111}h1{font-size:20pt}h2{font-size:15pt;margin-top:22px}h3{font-size:12.5pt}"
             "a{color:#3451b2}li{margin:3px 0}")
    return (f'<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title>'
            f"<style>{style}</style></head><body><h1>{html.escape(title)}</h1>{''.join(body)}"
            "</body></html>")


def find_chrome() -> str | None:
    for c in CHROME_CANDIDATES:
        if os.path.exists(c):
            return c
    return shutil.which("google-chrome") or shutil.which("chromium")


async def chrome_render(html_text: str, out_pdf: Path, timeout_s: float = 45.0) -> None:
    """Print HTML to PDF with headless Chrome and a throwaway profile."""
    chrome = find_chrome()
    if not chrome:
        raise DocumentError("Chrome is not installed, so the PDF could not be rendered.")
    with tempfile.TemporaryDirectory(prefix="oversight-doc-") as tmp:
        src = Path(tmp) / "doc.html"
        src.write_text(html_text, encoding="utf-8")
        proc = await asyncio.create_subprocess_exec(
            chrome, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
            "--no-first-run", "--no-default-browser-check",
            f"--user-data-dir={Path(tmp) / 'profile'}", f"--print-to-pdf={out_pdf}", src.as_uri(),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + timeout_s
            while loop.time() < deadline:
                if proc.returncode is not None and not out_pdf.exists():
                    raise DocumentError(f"Chrome exited ({proc.returncode}) without writing the PDF.")
                if out_pdf.exists() and out_pdf.stat().st_size > 0 and _complete(out_pdf):
                    return
                await asyncio.sleep(0.2)
            raise DocumentError(f"Chrome did not finish the PDF within {timeout_s:.0f}s.")
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()


def _complete(pdf: Path) -> bool:
    with pdf.open("rb") as f:
        f.seek(max(0, pdf.stat().st_size - 32))
        return b"%%EOF" in f.read()


async def save_document(title: str, content: str, filename: str, directory: str | Path, *,
                        render: Renderer = chrome_render) -> Path:
    """Render and save a new PDF in ``directory``. Returns its path. Never overwrites."""
    title = str(title or "").strip() or "Document"
    content = str(content or "")
    if not content.strip():
        raise DocumentError("The document has no content.")
    if len(content) > MAX_CONTENT_CHARS:
        raise DocumentError(f"The document is too long ({len(content)} characters).")
    folder = Path(directory).expanduser().resolve()
    if not folder.is_dir():
        raise DocumentError(f"The folder {folder} does not exist.")
    name = safe_filename(filename, title)

    with tempfile.TemporaryDirectory(prefix="oversight-pdf-") as tmp:
        rendered = Path(tmp) / "out.pdf"
        await render(markdown_to_html(title, content), rendered)
        data = rendered.read_bytes()

    stem = name[:-4]
    for n in range(1, 200):
        target = folder / (name if n == 1 else f"{stem} ({n}).pdf")
        if target.resolve().parent != folder:
            raise DocumentError("Refusing to write outside the documents folder.")
        try:
            with target.open("xb") as f:  # exclusive create: never overwrite
                f.write(data)
            return target
        except FileExistsError:
            continue
    raise DocumentError("Too many files with that name already exist.")
