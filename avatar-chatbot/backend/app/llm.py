"""Streaming LLM providers. Each yields text deltas."""
from typing import AsyncIterator

from .config import settings


def normalize_messages(messages: list[dict]) -> list[dict]:
    """Drop empties, merge consecutive same-role messages, make sure the list starts with 'user'."""
    out: list[dict] = []
    for m in messages:
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if out and out[-1]["role"] == m["role"]:
            out[-1]["content"] += "\n" + content
        else:
            out.append({"role": m["role"], "content": content})
    while out and out[0]["role"] != "user":
        out.pop(0)
    return out


class LLMNotConfigured(RuntimeError):
    pass


async def stream_chat(messages: list[dict], system: str | None = None) -> AsyncIterator[str]:
    messages = normalize_messages(messages)
    if not messages:
        return
    if system is None:
        system = settings.system_text()
    if settings.llm_provider == "gemini":
        async for t in _gemini(system, messages):
            yield t
    elif settings.llm_provider == "openai":
        async for t in _openai(system, messages):
            yield t
    else:
        raise LLMNotConfigured(f"Unknown LLM_PROVIDER '{settings.llm_provider}'")


_gemini_client = None
_openai_client = None


async def _gemini(system: str, messages: list[dict]) -> AsyncIterator[str]:
    """Stream a Gemini response using the Google Gen AI SDK, with automatic model fallback."""
    global _gemini_client
    if not settings.gemini_key:
        raise LLMNotConfigured("GEMINI_API_KEY is not set on the server")
    if _gemini_client is None:
        from google import genai

        _gemini_client = genai.Client(api_key=settings.gemini_key).aio

    # Gemini uses the role name "model" for assistant messages.
    contents = [
        {"role": "model" if message["role"] == "assistant" else "user",
         "parts": [{"text": message["content"]}]}
        for message in messages
    ]
    from google.genai import types

    models_to_try = [settings.gemini_model]
    for fallback in (
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
    ):
        if fallback not in models_to_try:
            models_to_try.append(fallback)

    last_err = None
    for model_name in models_to_try:
        try:
            stream = await _gemini_client.models.generate_content_stream(
                model=model_name,
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    max_output_tokens=settings.llm_max_tokens,
                ),
            )
            has_yielded = False
            async for chunk in stream:
                text = chunk.text
                if text:
                    has_yielded = True
                    yield text
            return
        except Exception as e:
            last_err = e
            if has_yielded:
                raise
            import logging
            logging.getLogger("avatar-chat").warning(
                "Gemini model '%s' failed (%s), trying fallback...", model_name, e
            )
            continue

    if last_err:
        raise last_err


async def _openai(system: str, messages: list[dict]) -> AsyncIterator[str]:
    global _openai_client
    if not settings.openai_key:
        raise LLMNotConfigured("OPENAI_API_KEY is not set on the server")
    if _openai_client is None:
        from openai import AsyncOpenAI

        _openai_client = AsyncOpenAI(api_key=settings.openai_key)
    stream = await _openai_client.chat.completions.create(
        model=settings.openai_model,
        messages=[{"role": "system", "content": system}, *messages],
        max_tokens=settings.llm_max_tokens,
        stream=True,
    )
    async for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content
