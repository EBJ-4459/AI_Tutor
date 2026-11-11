"""Server-side speech-to-text fallback for browsers without the Web Speech API."""
from .config import settings

_client = None


async def transcribe(filename: str, content: bytes, content_type: str) -> str:
    global _client
    if not settings.openai_key:
        raise RuntimeError("OPENAI_API_KEY is not set on the server")
    if _client is None:
        from openai import AsyncOpenAI

        _client = AsyncOpenAI(api_key=settings.openai_key)
    resp = await _client.audio.transcriptions.create(
        model=settings.openai_stt_model,
        file=(filename or "speech.webm", content, content_type or "audio/webm"),
    )
    return (resp.text or "").strip()
