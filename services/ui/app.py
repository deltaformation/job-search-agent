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
from services.ui.briefing_view import render_briefing_dashboard_html


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
        allowed_entities = session.get("allowed_entity_ids") or []
        if purpose == "bridge_test":
            target_url = "/bridge/ping"
        elif purpose in ("morning_briefing", "dashboard"):
            if allowed_entities:
                target_url = f"/ui/briefings/{allowed_entities[0]}"
            else:
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

    async def briefing_dashboard_page(request: Request) -> Response:
        briefing_id = request.path_params.get("briefing_id")
        if not briefing_id:
            return JSONResponse({"status": "error", "message": "Missing briefing identifier."}, status_code=400)

        # Check if the parameter is actually an unredeemed one-time token
        cookie = request.cookies.get("session")
        if not cookie:
            # Try redeeming as a one-time token
            ok, cookie_token, session, msg = session_mgr.redeem_url_token(briefing_id)
            if ok and cookie_token and session:
                target_briefing = (session.get("allowed_entity_ids") or [briefing_id])[0]
                resp = RedirectResponse(url=f"/ui/briefings/{target_briefing}", status_code=303)
                resp.set_cookie(
                    key="session",
                    value=cookie_token,
                    httponly=True,
                    samesite="strict",
                    path="/",
                    max_age=3600
                )
                return resp
            return JSONResponse({"status": "error", "message": "Authentication required. Redeem token first."}, status_code=401)

        session = session_mgr.authenticate_cookie(cookie)
        if not session:
            return JSONResponse({"status": "error", "message": "Unauthenticated or expired session."}, status_code=401)

        allowed_entities = session.get("allowed_entity_ids") or []
        if allowed_entities and briefing_id not in allowed_entities:
            return JSONResponse({"status": "error", "message": f"Access to briefing '{briefing_id}' denied for this session."}, status_code=403)

        briefing = repository.get_job_briefing(briefing_id)
        if not briefing:
            return JSONResponse({"status": "error", "message": f"Briefing '{briefing_id}' not found."}, status_code=404)

        items = repository.get_briefing_items(briefing_id)
        csrf_token = generate_csrf_token(cookie)
        html = render_briefing_dashboard_html(briefing, items, csrf_token)
        return HTMLResponse(content=html)

    async def prepare_briefing_action(request: Request) -> Response:
        cookie = request.cookies.get("session")
        session = session_mgr.authenticate_cookie(cookie)
        if not session:
            return JSONResponse({"status": "error", "message": "Unauthenticated or expired session."}, status_code=401)

        csrf_header = request.headers.get("x-csrf-token")
        if not csrf_header or not verify_csrf_token(cookie, csrf_header):
            return JSONResponse({"status": "error", "message": "Invalid or missing CSRF token."}, status_code=403)

        briefing_id = request.path_params.get("briefing_id")
        if not briefing_id:
            return JSONResponse({"status": "error", "message": "Missing briefing_id."}, status_code=400)

        allowed_actions = session.get("allowed_actions") or []
        if "prepare_selected" not in allowed_actions:
            return JSONResponse({"status": "error", "message": "Action 'prepare_selected' not permitted for this session."}, status_code=403)

        allowed_entities = session.get("allowed_entity_ids") or []
        if allowed_entities and briefing_id not in allowed_entities:
            return JSONResponse({"status": "error", "message": f"Access to briefing '{briefing_id}' denied for this session."}, status_code=403)

        try:
            body_bytes = await request.body()
            body_json = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            job_ids = body_json.get("job_ids") or []
            idempotency_key = body_json.get("idempotency_key")
            if not job_ids or not isinstance(job_ids, list):
                return JSONResponse({"status": "error", "message": "job_ids must be a non-empty list of UUIDs."}, status_code=400)
            if not idempotency_key or not isinstance(idempotency_key, str) or not idempotency_key.strip():
                return JSONResponse({"status": "error", "message": "idempotency_key is required."}, status_code=400)
        except Exception as exc:
            return JSONResponse({"status": "error", "message": f"Invalid payload: {exc}"}, status_code=400)

        try:
            result = repository.prepare_briefing_jobs(
                briefing_id=briefing_id,
                job_ids=job_ids,
                idempotency_key=idempotency_key,
                requested_by=f"ui_session_{session['id']}",
                ui_session_id=str(session["id"])
            )
            return JSONResponse({
                "status": "success",
                "briefing_id": briefing_id,
                "action_id": result.get("action_id"),
                "results": result.get("results")
            })
        except ValueError as exc:
            return JSONResponse({"status": "error", "message": str(exc)}, status_code=400)
        except Exception as exc:
            return JSONResponse({"status": "error", "message": str(exc)}, status_code=500)

    routes = [
        Route("/health", health, methods=["GET"]),
        Route("/redeem", redeem_token, methods=["GET"]),
        Route("/bridge/ping", bridge_ping_page, methods=["GET"]),
        Route("/ui/briefings/{briefing_id}", briefing_dashboard_page, methods=["GET"]),
        Route("/api/briefings/{briefing_id}/prepare", prepare_briefing_action, methods=["POST"]),
        Route("/api/session", get_session_info, methods=["GET"]),
        Route("/api/actions", submit_action, methods=["POST"]),
    ]

    middleware = [
        Middleware(SecurityHeadersMiddleware),
        Middleware(LoopbackOriginGuardMiddleware),
    ]

    return Starlette(debug=False, routes=routes, middleware=middleware)
