"""Starlette web application for the local control center."""
import json
from typing import Optional
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.routing import Route

from services.memory.repository import JobRepository
from services.ui.actions import ActionSubmissionRequest, dispatch_action
from services.ui.security import (
    LoopbackOriginGuardMiddleware,
    SecurityHeadersMiddleware,
    generate_csrf_token,
    verify_csrf_token,
)
from services.ui.sessions import SessionManager


def create_app(repo: Optional[JobRepository] = None) -> Starlette:
    repository = repo or JobRepository()
    session_mgr = SessionManager(repository)

    async def health(request: Request) -> Response:
        return JSONResponse({"status": "ok", "service": "control_center"})

    async def redeem_token(request: Request) -> Response:
        raw_token = request.query_params.get("token")
        if not raw_token:
            return JSONResponse({"status": "error", "message": "Missing token query parameter."}, status_code=400)

        ok, cookie_token, session, msg = session_mgr.redeem_url_token(raw_token)
        if not ok or not cookie_token or not session:
            return JSONResponse({"status": "error", "message": msg}, status_code=403)

        # Redirect target based on session purpose
        purpose = session.get("purpose", "")
        if purpose == "bridge_test":
            target_url = "/bridge/ping"
        elif purpose == "dashboard":
            target_url = "/dashboard"
        elif purpose == "review":
            target_url = "/review"
        else:
            target_url = "/dashboard"

        response = RedirectResponse(url=target_url, status_code=303)
        # Issue HttpOnly, SameSite=Strict session cookie
        response.set_cookie(
            key="session",
            value=cookie_token,
            httponly=True,
            samesite="strict",
            path="/",
            max_age=3600
        )
        return response

    async def get_session_info(request: Request) -> Response:
        cookie = request.cookies.get("session")
        session = session_mgr.authenticate_cookie(cookie)
        if not session:
            return JSONResponse({"status": "error", "message": "Unauthenticated or expired session."}, status_code=401)

        csrf_token = generate_csrf_token(cookie)
        return JSONResponse({
            "status": "success",
            "session_id": str(session["id"]),
            "purpose": session["purpose"],
            "allowed_actions": session.get("allowed_actions", []),
            "csrf_token": csrf_token,
            "expires_at": session["expires_at"].isoformat()
        })

    async def bridge_ping_page(request: Request) -> Response:
        cookie = request.cookies.get("session")
        session = session_mgr.authenticate_cookie(cookie)
        if not session:
            return JSONResponse({"status": "error", "message": "Authentication required. Redeem token first."}, status_code=401)

        csrf_token = generate_csrf_token(cookie)
        html_content = f"""<!DOCTYPE html>
<html>
<head>
    <title>Control Center - Milestone 5 Bridge Ping</title>
</head>
<body>
    <h1>Control Center Bridge Ping</h1>
    <p>Session ID: {session['id']}</p>
    <p>Purpose: {session['purpose']}</p>
    <div id="csrf-token" data-token="{csrf_token}"></div>
</body>
</html>"""
        return HTMLResponse(content=html_content)

    async def submit_action(request: Request) -> Response:
        cookie = request.cookies.get("session")
        session = session_mgr.authenticate_cookie(cookie)
        if not session:
            return JSONResponse({"status": "error", "message": "Unauthenticated or expired session."}, status_code=401)

        # CSRF check
        csrf_header = request.headers.get("x-csrf-token")
        if not csrf_header or not verify_csrf_token(cookie, csrf_header):
            return JSONResponse({"status": "error", "message": "Invalid or missing CSRF token."}, status_code=403)

        try:
            body_bytes = await request.body()
            body_json = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            submission = ActionSubmissionRequest.model_validate(body_json)
        except Exception as exc:
            return JSONResponse({"status": "error", "message": f"Invalid action payload: {exc}"}, status_code=400)

        try:
            record, is_new = dispatch_action(repository, session, submission)
            return JSONResponse({
                "status": "success",
                "is_new": is_new,
                "action": {
                    "id": str(record["id"]),
                    "action_type": record["action_type"],
                    "status": record["status"],
                    "idempotency_key": record["idempotency_key"]
                }
            })
        except PermissionError as exc:
            return JSONResponse({"status": "error", "message": str(exc)}, status_code=403)
        except Exception as exc:
            return JSONResponse({"status": "error", "message": str(exc)}, status_code=500)

    routes = [
        Route("/health", health, methods=["GET"]),
        Route("/redeem", redeem_token, methods=["GET"]),
        Route("/bridge/ping", bridge_ping_page, methods=["GET"]),
        Route("/api/session", get_session_info, methods=["GET"]),
        Route("/api/actions", submit_action, methods=["POST"]),
    ]

    middleware = [
        Middleware(SecurityHeadersMiddleware),
        Middleware(LoopbackOriginGuardMiddleware),
    ]

    return Starlette(debug=False, routes=routes, middleware=middleware)
