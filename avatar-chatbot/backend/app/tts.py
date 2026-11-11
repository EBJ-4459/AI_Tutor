"""Text-to-speech providers. Each returns audio bytes + per-word timings (milliseconds)
in the shape TalkingHead.speakAudio() expects."""
import base64
import io
import re
import wave
from dataclasses import dataclass, field

import httpx

from .config import settings


@dataclass
class TTSResult:
    audio: bytes
    mime: str
    words: list[str] = field(default_factory=list)
    wtimes: list[int] = field(default_factory=list)
    wdurations: list[int] = field(default_factory=list)

    def to_event(self) -> dict:
        return {
            "mime": self.mime,
            "data": base64.b64encode(self.audio).decode("ascii"),
            "words": self.words,
            "wtimes": self.wtimes,
            "wdurations": self.wdurations,
        }


class TTSNotConfigured(RuntimeError):
    pass


def estimate_word_timings(text: str, duration_ms: float) -> tuple[list[str], list[int], list[int]]:
    """Distribute duration over words by length, with a small pause after punctuation."""
    words = text.split()
    if not words:
        return [], [], []
    weights = []
    for w in words:
        weight = len(re.sub(r"\W", "", w)) + 1.5
        if re.search(r"[,;:]$", w):
            weight += 2
        elif re.search(r"[.!?…]$", w):
            weight += 4
        weights.append(weight)
    total = sum(weights)
    times, durs, t = [], [], 0.0
    for w, weight in zip(words, weights):
        d = duration_ms * weight / total
        times.append(int(t))
        durs.append(max(int(d * 0.92), 40))
        t += d
    return words, times, durs


def clean_for_speech(text: str) -> str:
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[*_`#>~]+", "", text)
    text = re.sub("[\U0001F000-\U0001FAFF☀-➿️‍]", "", text)  # emoji -> facial expressions on the client
    return re.sub(r"\s+", " ", text).strip()


async def synthesize(text: str) -> TTSResult | None:
    text = clean_for_speech(text)
    if not text or not re.search(r"\w", text):
        return None
    p = settings.tts_provider
    if p == "edge":
        return await _edge(text)
    if p == "elevenlabs":
        return await _elevenlabs(text)
    if p == "openai":
        return await _openai(text)
    raise TTSNotConfigured(f"Unknown TTS_PROVIDER '{p}'")


# ---------------------------------------------------------------- Edge TTS (free)
async def _edge(text: str) -> TTSResult:
    import edge_tts

    comm = edge_tts.Communicate(text, settings.edge_voice, boundary="WordBoundary")
    audio = bytearray()
    words: list[str] = []
    wtimes: list[int] = []
    wdurs: list[int] = []
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            words.append(chunk["text"])
            wtimes.append(int(chunk["offset"] / 10_000))  # 100-ns ticks -> ms
            wdurs.append(max(int(chunk["duration"] / 10_000), 40))
    if not audio:
        raise RuntimeError("Edge TTS returned no audio")
    if not words:  # sentence-level only: fall back to an estimate (~15 chars/sec)
        words, wtimes, wdurs = estimate_word_timings(text, max(len(text) / 15 * 1000, 500))
    return TTSResult(bytes(audio), "audio/mpeg", words, wtimes, wdurs)


# ---------------------------------------------------------------- ElevenLabs
async def _elevenlabs(text: str) -> TTSResult:
    if not settings.eleven_key:
        raise TTSNotConfigured("ELEVENLABS_API_KEY is not set on the server")
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{settings.eleven_voice}/with-timestamps"
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            url,
            params={"output_format": "mp3_44100_64"},
            headers={"xi-api-key": settings.eleven_key},
            json={"text": text, "model_id": settings.eleven_model},
        )
    r.raise_for_status()
    data = r.json()
    audio = base64.b64decode(data["audio_base64"])
    al = data.get("alignment") or data.get("normalized_alignment") or {}
    chars = al.get("characters", [])
    starts = al.get("character_start_times_seconds", [])
    ends = al.get("character_end_times_seconds", [])
    words, wtimes, wdurs = [], [], []
    cur, w_start, w_end = "", None, 0.0
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if cur:
                words.append(cur)
                wtimes.append(int(w_start * 1000))
                wdurs.append(max(int((w_end - w_start) * 1000), 40))
                cur, w_start = "", None
            continue
        if w_start is None:
            w_start = s
        cur += ch
        w_end = e
    if cur:
        words.append(cur)
        wtimes.append(int(w_start * 1000))
        wdurs.append(max(int((w_end - w_start) * 1000), 40))
    if not words:
        words, wtimes, wdurs = estimate_word_timings(text, max(len(text) / 15 * 1000, 500))
    return TTSResult(audio, "audio/mpeg", words, wtimes, wdurs)


# ---------------------------------------------------------------- OpenAI (timings estimated)
_openai_client = None


async def _openai(text: str) -> TTSResult:
    global _openai_client
    if not settings.openai_key:
        raise TTSNotConfigured("OPENAI_API_KEY is not set on the server")
    if _openai_client is None:
        from openai import AsyncOpenAI

        _openai_client = AsyncOpenAI(api_key=settings.openai_key)
    resp = await _openai_client.audio.speech.create(
        model=settings.openai_tts_model,
        voice=settings.openai_tts_voice,
        input=text,
        response_format="wav",
    )
    audio = resp.content
    with wave.open(io.BytesIO(audio)) as w:
        duration_ms = w.getnframes() / float(w.getframerate()) * 1000
    words, wtimes, wdurs = estimate_word_timings(text, duration_ms)
    return TTSResult(audio, "audio/wav", words, wtimes, wdurs)
