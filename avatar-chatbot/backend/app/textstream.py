"""Helpers that turn a raw LLM token stream into clean text, mood events and speakable sentences."""
import re

MOODS = {"neutral", "happy", "angry", "sad", "fear", "disgust", "love", "sleep"}
_MAX_TAG_LEN = 14


class TagParser:
    """Removes [mood] tags from a streamed text. feed() returns [("text", str) | ("mood", str)]."""

    def __init__(self) -> None:
        self._buf = ""

    def feed(self, delta: str) -> list[tuple[str, str]]:
        self._buf += delta
        return self._drain(final=False)

    def flush(self) -> list[tuple[str, str]]:
        return self._drain(final=True)

    def _drain(self, final: bool) -> list[tuple[str, str]]:
        out: list[tuple[str, str]] = []
        while self._buf:
            i = self._buf.find("[")
            if i == -1:
                out.append(("text", self._buf))
                self._buf = ""
                break
            if i > 0:
                out.append(("text", self._buf[:i]))
                self._buf = self._buf[i:]
            j = self._buf.find("]")
            if j == -1:
                if len(self._buf) > _MAX_TAG_LEN or final:
                    out.append(("text", "["))
                    self._buf = self._buf[1:]
                    continue
                break  # wait for more data
            tag = self._buf[1:j].strip().lower()
            if tag in MOODS:
                out.append(("mood", tag))
                self._buf = self._buf[j + 1 :].lstrip(" ")
            else:
                out.append(("text", self._buf[: j + 1]))
                self._buf = self._buf[j + 1 :]
        return out


_SENT_END = re.compile(r"(?<=[.!?…。！？])[\"')\]]*\s+|\n+")


class SentenceSplitter:
    """Accumulates text and yields speakable chunks. First chunk is allowed to be short for low latency."""

    def __init__(self, min_first: int = 12, min_next: int = 30, max_len: int = 260) -> None:
        self._buf = ""
        self._count = 0
        self.min_first, self.min_next, self.max_len = min_first, min_next, max_len

    def feed(self, text: str) -> list[str]:
        self._buf += text
        out: list[str] = []
        while True:
            need = self.min_first if self._count == 0 else self.min_next
            cut = None
            for m in _SENT_END.finditer(self._buf):
                if m.start() >= need:
                    cut = m.end()
                    break
            if cut is None and len(self._buf) > self.max_len:
                sp = self._buf.rfind(" ", 0, self.max_len)
                cut = sp + 1 if sp > 0 else self.max_len
            if cut is None:
                break
            piece, self._buf = self._buf[:cut].strip(), self._buf[cut:]
            if piece:
                out.append(piece)
                self._count += 1
        return out

    def flush(self) -> list[str]:
        piece, self._buf = self._buf.strip(), ""
        return [piece] if piece else []


_SPEAKABLE = re.compile(r"\w")


def is_speakable(text: str) -> bool:
    return bool(_SPEAKABLE.search(text))
