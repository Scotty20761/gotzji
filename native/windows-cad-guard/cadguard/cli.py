"""One-shot entry for hosts that run a command per operation (gotzji): one JSON request on stdin, one JSON line out.

Request: {"action": "list|open|status|select|release|report|call", "opener": str, "windowId"?, "pid"?, "tag"?,
"waitSeconds"?, "releaseToken"?, "tool"?, "arguments"?}. Output, always exactly one line:
{"ok": true, "value": …, "incidents"?: […]} or {"ok": false, "error": {"code": …, …}}.
"""
from __future__ import annotations

import json
import sys
import traceback
from typing import Any, Callable

from .errors import GuardRefusal

MAX_REQUEST_BYTES = 256 * 1024


def handle(guard: Any, request: dict) -> Any:
    action = request.get("action")
    token = request.get("releaseToken")
    if token is not None and not isinstance(token, str):
        raise GuardRefusal("CAD_INPUT_UNREADABLE", "releaseToken")
    if action == "list":
        return guard.list()
    if action == "open":
        return guard.open(tag=request.get("tag"), select=False)
    if action == "status":
        wait = request.get("waitSeconds", 0)
        if not isinstance(wait, (int, float)) or isinstance(wait, bool):
            raise GuardRefusal("CAD_INPUT_UNREADABLE", "waitSeconds")
        return guard.status(_window_id(request), float(wait))
    if action == "select":
        pid = request.get("pid")
        if pid is not None and (not isinstance(pid, int) or isinstance(pid, bool)):
            raise GuardRefusal("CAD_INPUT_UNREADABLE", "pid")
        return guard.select(window_id=request.get("windowId") if request.get("windowId") is None else _window_id(request), pid=pid, token=token)
    if action == "release":
        tag = request.get("tag")
        return guard.release(window_id=None if request.get("windowId") is None else _window_id(request),
                             tag=tag if isinstance(tag, str) else None, token=token)
    if action == "report":
        return guard.report()
    if action == "call":
        tool, arguments = request.get("tool"), request.get("arguments", {})
        if not isinstance(tool, str) or not isinstance(arguments, dict):
            raise GuardRefusal("CAD_INPUT_UNREADABLE", "tool and arguments")
        # A one-shot run has no session: the caller names the window and proves it opened it with the token.
        window_id = _window_id(request)
        if token is not None:
            guard.tokens[window_id] = token
        guard.selection = window_id
        return guard.call(tool, arguments)
    raise GuardRefusal("CAD_INPUT_UNREADABLE", f"unknown action {action!r}")


def _window_id(request: dict) -> str:
    window_id = request.get("windowId")
    if not isinstance(window_id, str) or not window_id:
        raise GuardRefusal("CAD_WINDOW_NOT_SELECTED", "windowId")
    return window_id


def run(raw: bytes, build: Callable[[str], Any]) -> dict:
    """Never raises: every failure becomes one coded JSON object."""
    try:
        if len(raw) > MAX_REQUEST_BYTES:
            raise GuardRefusal("CAD_INPUT_UNREADABLE", "request too large")
        try:
            request = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise GuardRefusal("CAD_INPUT_UNREADABLE", "not JSON") from None
        if not isinstance(request, dict) or not isinstance(request.get("opener"), str) or not request["opener"]:
            raise GuardRefusal("CAD_INPUT_UNREADABLE", "a request object with an opener")
        guard = build(request["opener"])
        try:
            guard.sweep()
        except Exception:  # noqa: BLE001 - an idle window's trouble never fails this request
            pass
        value = handle(guard, request)
        output: dict = {"ok": True, "value": value}
        if getattr(guard, "last_incidents", None):
            output["incidents"] = guard.last_incidents
        return output
    except GuardRefusal as refusal:
        return {"ok": False, "error": refusal.as_result()}
    except BaseException as error:  # noqa: BLE001 - the caller always gets one coded line
        return {"ok": False, "error": {"success": False, "code": "CAD_GUARD_INTERNAL", "detail": "".join(traceback.format_exception_only(type(error), error)).strip()[:500]}}


def main(install_dir: str) -> None:
    def build(opener: str) -> Any:
        import pythoncom
        from .runtime import build as build_guard
        pythoncom.CoInitialize()
        guard, _ = build_guard(install_dir, opener)
        return guard

    output = run(sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1), build)
    sys.stdout.write(json.dumps(output, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()
