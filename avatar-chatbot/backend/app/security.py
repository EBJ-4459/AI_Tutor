import re
import secrets
import time
from collections import defaultdict, deque

from fastapi import Header, HTTPException

from .config import settings

CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def valid_client_id(value: str | None) -> bool:
    return bool(value and CLIENT_ID_RE.match(value))


def token_ok(token: str | None) -> bool:
    if not settings.app_token:
        return True
    return bool(token) and secrets.compare_digest(token, settings.app_token)


async def require_client(
    authorization: str | None = Header(default=None),
    x_client_id: str | None = Header(default=None),
) -> str:
    """FastAPI dependency: validates the optional bearer token and returns the client id."""
    if settings.app_token:
        bearer = (authorization or "").removeprefix("Bearer ").strip()
        if not token_ok(bearer):
            raise HTTPException(status_code=401, detail="Invalid or missing access token")
    if not valid_client_id(x_client_id):
        raise HTTPException(status_code=400, detail="Missing or invalid X-Client-Id")
    return x_client_id  # type: ignore[return-value]


class RateLimiter:
    """Sliding-window limiter kept in memory (single process)."""

    def __init__(self, max_events: int, window_s: float = 60.0) -> None:
        self.max, self.window = max_events, window_s
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        q = self._hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.max:
            return False
        q.append(now)
        if len(self._hits) > 5000:  # crude memory guard
            for k in [k for k, v in self._hits.items() if not v][:1000]:
                self._hits.pop(k, None)
        return True


limiter = RateLimiter(settings.rate_limit_per_minute)


def origin_allowed(origin: str | None) -> bool:
    # Non-browser clients send no Origin header; browsers always do for WebSockets.
    if origin is None or "*" in settings.allowed_origins or origin in settings.allowed_origins:
        return True
    try:
        from urllib.parse import urlparse
        parsed = urlparse(origin)
        host = (parsed.hostname or "").lower()
        if host in ("localhost", "127.0.0.1") or host.endswith(".vercel.app"):
            return True
    except Exception:
        pass
    return False
