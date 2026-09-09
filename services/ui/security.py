"""Security primitives, middleware, and request guards for the local control center."""
import hashlib
import hmac
import secrets
import time
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response


MAX_REQUEST_BODY_BYTES = 65536  # 64 KB
ALLOWED_LOOPBACK_HOSTS = {"127.0.0.1", "localhost"}


def generate_secure_token() -> str:
    """Generate a high-entropy URL-safe token (32 bytes / ~43 chars)."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """Compute SHA-256 hex digest of a raw token."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class RateLimiter:
    """In-memory sliding-window rate limiter per client/session."""
    def __init__(self, max_requests: int = 60, window_seconds: int = 60) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._history: Dict[str, List[float]] = {}

    def is_allowed(self, key: str) -> bool:
        now = time.time()
        window_start = now - self.window_seconds
        timestamps = self._history.get(key, [])
        valid_timestamps = [ts for ts in timestamps if ts > window_start]
        if len(valid_timestamps) >= self.max_requests:
            self._history[key] = valid_timestamps
            return False
        valid_timestamps.append(now)
        self._history[key] = valid_timestamps
        return True

    def reset(self) -> None:
        self._history.clear()


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Enforces strict security headers: CSP, anti-framing, no-referrer, no-store."""
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; frame-ancestors 'none';"
        )
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        return response


class LoopbackOriginGuardMiddleware(BaseHTTPMiddleware):
    """
    Guards local control service against foreign Host and cross-origin POST attacks.
    Binds strictly to 127.0.0.1 / localhost and blocks all cross-origin state changes.
    """
    def __init__(self, app, rate_limiter: Optional[RateLimiter] = None) -> None:
        super().__init__(app)
        self.rate_limiter = rate_limiter or RateLimiter()

    async def dispatch(self, request: Request, call_next) -> Response:
        # 1. Validate Host header
        host_header = request.headers.get("host", "").strip().lower()
        if not host_header:
            return JSONResponse({"status": "error", "message": "Missing Host header."}, status_code=400)
        host_name = host_header.split(":")[0]
        if host_name not in ALLOWED_LOOPBACK_HOSTS:
            return JSONResponse({"status": "error", "message": "Invalid Host header."}, status_code=403)

        # 2. Enforce request body size limit
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > MAX_REQUEST_BODY_BYTES:
                    return JSONResponse({"status": "error", "message": "Request body exceeds maximum allowed size."}, status_code=413)
            except ValueError:
                return JSONResponse({"status": "error", "message": "Invalid Content-Length header."}, status_code=400)

        # 3. For state-changing methods, enforce Origin / Referer loopback matching
        if request.method in ("POST", "PUT", "DELETE", "PATCH"):
            origin = request.headers.get("origin")
            referer = request.headers.get("referer")
            check_url = origin or referer

            if not check_url:
                # Require explicit origin or referer on state-changing requests
                return JSONResponse({"status": "error", "message": "Missing Origin/Referer on state-changing request."}, status_code=403)

            parsed = urlparse(check_url)
            if parsed.scheme != "http" or parsed.hostname not in ALLOWED_LOOPBACK_HOSTS:
                return JSONResponse({"status": "error", "message": "Cross-origin request rejected."}, status_code=403)

        # 4. Rate limiting check
        client_key = request.cookies.get("session") or request.client.host if request.client else "unknown"
        if not self.rate_limiter.is_allowed(client_key):
            return JSONResponse({"status": "error", "message": "Too many requests. Rate limit exceeded."}, status_code=429)

        return await call_next(request)


def generate_csrf_token(cookie_token: str, secret_key: str = "job_system_csrf_secret") -> str:
    """Derive deterministic HMAC CSRF token for a given session cookie."""
    return hmac.new(secret_key.encode(), cookie_token.encode(), hashlib.sha256).hexdigest()


def verify_csrf_token(cookie_token: str, csrf_token: str, secret_key: str = "job_system_csrf_secret") -> bool:
    """Verify submitted CSRF token matches session cookie."""
    expected = generate_csrf_token(cookie_token, secret_key=secret_key)
    return hmac.compare_digest(expected, csrf_token)
