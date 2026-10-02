"""Provider-neutral structured-output call with cost and latency accounting.

Every planner and scorer call goes through `StructuredLLM.call`, which returns
parsed JSON (never prose) plus a `CallRecord`. The caller is responsible for
persisting the record and emitting a `cost` event (see api.py).
"""

from __future__ import annotations

import base64
import json
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

# USD per million tokens (input, output). Anthropic rates from the claude-api
# reference (cached 2026-09-25). OpenAI rates are placeholders for the
# fallback provider and should be checked before relying on the cost counter.
PRICING: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "gpt-5.5": (5.0, 20.0),
}


def price_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    rate = PRICING.get(model)
    if rate is None:
        # Match by prefix for dated or suffixed ids returned by the API.
        for k, v in PRICING.items():
            if model.startswith(k):
                rate = v
                break
    if rate is None:
        rate = (5.0, 25.0)
    return round(input_tokens * rate[0] / 1e6 + output_tokens * rate[1] / 1e6, 6)


@dataclass
class CallRecord:
    scope: str
    provider: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    usd: float = 0.0
    latency_ms: int = 0
    ok: bool = True
    error: str | None = None


@dataclass(frozen=True)
class ImageInput:
    """One user-attached image for a structured call (track D2 builds the blocks)."""

    mime: str  # image/png | image/jpeg | image/webp
    data: bytes


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


class LLMError(RuntimeError):
    def __init__(self, message: str, record: CallRecord | None = None):
        super().__init__(message)
        self.record = record


class StructuredLLM:
    """One structured-output call: system + user text in, JSON object out."""

    def __init__(self, provider: str, model: str):
        self.provider = provider
        self.model = model
        self._client: Any = None
        self._fallbacks_ok = True

    def _anthropic(self):
        if self._client is None:
            import anthropic

            self._client = anthropic.AsyncAnthropic(max_retries=2, timeout=120.0)
        return self._client

    def _openai(self):
        if self._client is None:
            import openai

            self._client = openai.AsyncOpenAI(max_retries=2, timeout=120.0)
        return self._client

    async def call(self, *, scope: str, system: str, user: str, schema: dict,
                   schema_name: str, effort: str = "low",
                   max_tokens: int = 8000,
                   images: Sequence[ImageInput] = ()) -> tuple[dict, CallRecord]:
        rec = CallRecord(scope=scope, provider=self.provider, model=self.model)
        t0 = time.perf_counter()
        try:
            _check_images(images)
            if self.provider == "anthropic":
                data = await self._call_anthropic(rec, system, user, schema, effort, max_tokens,
                                                  images)
            elif self.provider == "openai":
                data = await self._call_openai(rec, system, user, schema, schema_name, images)
            else:
                raise LLMError(f"unknown provider {self.provider}")
        except LLMError as e:
            rec.ok = False
            rec.error = str(e)
            rec.latency_ms = int((time.perf_counter() - t0) * 1000)
            rec.usd = price_usd(rec.model, rec.input_tokens, rec.output_tokens)
            e.record = rec
            raise
        except Exception as e:  # SDK / network errors
            rec.ok = False
            rec.error = f"{type(e).__name__}: {e}"
            rec.latency_ms = int((time.perf_counter() - t0) * 1000)
            raise LLMError(rec.error, rec) from e
        rec.latency_ms = int((time.perf_counter() - t0) * 1000)
        rec.usd = price_usd(rec.model, rec.input_tokens, rec.output_tokens)
        return data, rec

    async def _call_anthropic(self, rec: CallRecord, system: str, user: str, schema: dict,
                              effort: str, max_tokens: int,
                              images: Sequence[ImageInput] = ()) -> dict:
        import anthropic

        client = self._anthropic()
        kwargs: dict[str, Any] = dict(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": anthropic_user_content(user, images)}],
            output_config={"effort": effort,
                           "format": {"type": "json_schema", "schema": schema}},
        )
        resp = None
        if self._fallbacks_ok and os.environ.get("OVERSIGHT_NO_FALLBACKS") != "1":
            # Server-side refusal fallback ("default" routing by refusal category).
            try:
                resp = await client.beta.messages.create(
                    betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
                )
            except anthropic.BadRequestError as e:
                if "fallback" not in str(e).lower():
                    raise
                self._fallbacks_ok = False
        if resp is None:
            resp = await client.messages.create(**kwargs)

        usage = resp.usage
        rec.model = getattr(resp, "model", None) or self.model
        rec.input_tokens = int((usage.input_tokens or 0)
                               + (getattr(usage, "cache_creation_input_tokens", 0) or 0)
                               + (getattr(usage, "cache_read_input_tokens", 0) or 0))
        rec.output_tokens = int(usage.output_tokens or 0)
        if resp.stop_reason == "refusal":
            raise LLMError("model refused the request")
        if resp.stop_reason == "max_tokens":
            raise LLMError("hit max_tokens before finishing structured output")
        text = next((b.text for b in resp.content if b.type == "text"), None)
        if text is None:
            raise LLMError("no text block in structured response")
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise LLMError(f"invalid JSON from model: {e}") from e

    async def _call_openai(self, rec: CallRecord, system: str, user: str, schema: dict,
                           schema_name: str, images: Sequence[ImageInput] = ()) -> dict:
        client = self._openai()
        resp = await client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": openai_user_content(user, images)}],
            response_format={"type": "json_schema",
                             "json_schema": {"name": schema_name, "schema": schema,
                                             "strict": True}},
        )
        rec.model = resp.model or self.model
        if resp.usage:
            rec.input_tokens = int(resp.usage.prompt_tokens or 0)
            rec.output_tokens = int(resp.usage.completion_tokens or 0)
        msg = resp.choices[0].message
        if getattr(msg, "refusal", None):
            raise LLMError(f"model refused: {msg.refusal}")
        try:
            return json.loads(msg.content or "")
        except json.JSONDecodeError as e:
            raise LLMError(f"invalid JSON from model: {e}") from e
