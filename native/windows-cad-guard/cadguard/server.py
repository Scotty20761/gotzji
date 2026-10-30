"""MCP stdio server: the 7 stock multiCAD tools, with their names and input schemas, plus `cad_window`.

Every stock call and every COM touch runs on one CAD thread, one at a time. Register this server as `zwcad`.
"""
from __future__ import annotations

import asyncio
import gc
import json
import os
import sys
import time
import traceback
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Literal

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.tools.tool import Tool, ToolResult
from mcp.types import TextContent
from pydantic import PrivateAttr

from .errors import GuardRefusal

CALL_TIMEOUT_SECONDS = float(os.environ.get("CAD_GUARD_CALL_TIMEOUT", "150"))
SWEEP_EVERY_SECONDS = 300

NOTE = ("\n\n[cad-guard] Runs only in the ZWCAD window selected with the cad_window tool (list, open + status, select). "
        "Drawings the owner made are read-only; write only in drawings of a window opened with cad_window open. "
        "Send new, switch and save each as the only operation of a call. Call cad_window release when the task is "
        "finished. Refusals return a code and the next step.")

CAD_WINDOW_DESCRIPTION = """Choose, open and close ZWCAD windows for the zwcad tools. Every zwcad call runs in the selected window only.

Actions:
- list: every running ZWCAD with its kind (system = opened by this guard, owner = opened by the owner, orphan-candidate, foreign-system), active drawing and whether it can be selected.
- open {tag?}: start a new system window with a blank drawing in the guard sandbox and select it. Returns at once with state 'opening' and a releaseToken; poll status. Keep the releaseToken.
- status {windowId, waitSeconds<=20}: 'opening' -> 'ready' (or 'failed'); after release: 'closing' -> 'closed'.
- select {windowId, releaseToken?} or {pid}: point the zwcad tools at that window. Writing in a system window needs its releaseToken (this session has it after 'open'). An owner window must have a saved drawing active and stays read-only.
- release {windowId, releaseToken?} or {tag}: when the task is done, save the system window's drawings into the sandbox as new DWG files, close them and quit that ZWCAD. A window holding a drawing the guard did not create is never closed; it is handed over to the owner.
- report: ZWCAD processes no record explains (for example a hidden /Automation instance, and the drawing open in it), system windows needing attention, owner drawings a call changed, and updater processes left behind.
"""


def _on_cad_thread(fn: Callable[[], Any]) -> tuple[str, Any]:
    """Run fn and return a plain outcome. Tracebacks hold COM proxies in their frames, so they are cleared and
    collected here, on the thread that owns those proxies, before anything leaves it."""
    try:
        return "ok", fn()
    except GuardRefusal as refusal:
        outcome: tuple[str, Any] = ("refusal", refusal.as_result())
        traceback.clear_frames(refusal.__traceback__)
    except BaseException as error:  # noqa: BLE001 - reported as one coded outcome
        outcome = ("error", {"success": False, "code": "CAD_GUARD_INTERNAL", "detail": f"{type(error).__name__}: {error}"[:500]})
        traceback.clear_frames(error.__traceback__)
    gc.collect()
    try:
        import pythoncom
    except ImportError:  # tests run the server on any OS with fake COM
        return outcome
    pythoncom.CoFreeUnusedLibraries()
    return outcome


class CadThread:
    """One STA thread for COM, kept for the life of the server. A call that overruns its budget keeps running on it;
    until it finishes, new calls are refused instead of queued or moved to another thread."""

    def __init__(self, executor: ThreadPoolExecutor | None = None) -> None:
        self.lock = asyncio.Lock()
        self.executor = executor or ThreadPoolExecutor(max_workers=1, thread_name_prefix="cad", initializer=_co_initialize)
        self.running: Future | None = None

    async def run(self, fn: Callable[[], Any], timeout: float) -> Any:
        async with self.lock:
            if self.running is not None and not self.running.done():
                raise GuardRefusal("CAD_GUARD_BUSY")
            future = self.executor.submit(_on_cad_thread, fn)
            self.running = future
            try:
                kind, value = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(future)), timeout)
            except asyncio.TimeoutError:
                raise GuardRefusal("CAD_WINDOW_CALL_TIMEOUT", f"over {timeout:.0f} s") from None
            # A cancelled MCP request leaves `running` set, so the next call is refused until the thread is free.
        if kind == "ok":
            return value
        raise ToolError(json.dumps(value, ensure_ascii=False))


def _co_initialize() -> None:
    try:
        import pythoncom
    except ImportError:  # tests run the server on any OS with fake COM
        return
    pythoncom.CoInitialize()


class GuardedTool(Tool):
    _runtime: Any = PrivateAttr(default=None)
    _stock_tool: Any = PrivateAttr(default=None)

    async def run(self, arguments: dict[str, Any]) -> ToolResult:
        guard = self._runtime.guard
        raw, incidents = await self._runtime.cad(lambda: (guard.call(self.name, arguments), list(guard.last_incidents)))
        result = self._stock_tool.convert_result(raw)
        if incidents:
            notice = {"cadGuard": "ownerDrawingChanged", "incidents": incidents}
            result.content = [*result.content, TextContent(type="text", text=json.dumps(notice, ensure_ascii=False, default=str))]
        return result


class Runtime:
    def __init__(self, guard: Any, thread: CadThread | None = None) -> None:
        self.guard = guard
        self.thread = thread or CadThread()
        self.last_sweep = 0.0
        self.opener_known = bool(os.environ.get("CAD_GUARD_OPENER"))

    def learn_opener(self) -> None:
        if self.opener_known:
            return
        try:
            from fastmcp.server.dependencies import get_context
            name = get_context().session.client_params.clientInfo.name
        except Exception:  # noqa: BLE001 - an unknown client keeps the default opener
            return
        if name:
            self.guard.opener = str(name)
            self.opener_known = True

    async def cad(self, fn: Callable[[], Any], timeout: float = CALL_TIMEOUT_SECONDS) -> Any:
        self.learn_opener()

        def with_sweep() -> Any:
            if time.time() - self.last_sweep > SWEEP_EVERY_SECONDS:
                self.last_sweep = time.time()
                try:
                    self.guard.sweep()
                except Exception:  # noqa: BLE001 - an idle window's trouble never fails this request
                    pass
            return fn()

        try:
            return await self.thread.run(with_sweep, timeout)
        except GuardRefusal as refusal:
            raise ToolError(json.dumps(refusal.as_result(), ensure_ascii=False)) from None


def build_server(guard: Any, runtime: Runtime | None = None) -> FastMCP:
    runtime = runtime or Runtime(guard)
    mcp = FastMCP("zwcad (cad-guard)")
    for name, stock_tool in guard.stock.tools.items():
        tool = GuardedTool(name=name, description=(stock_tool.description or "") + NOTE, parameters=stock_tool.parameters,
                           output_schema=stock_tool.output_schema, annotations=stock_tool.annotations)
        tool._runtime, tool._stock_tool = runtime, stock_tool
        mcp.add_tool(tool)

    @mcp.tool(name="cad_window", description=CAD_WINDOW_DESCRIPTION)
    async def cad_window(action: Literal["list", "open", "status", "select", "release", "report"], windowId: str | None = None,
                         pid: int | None = None, tag: str | None = None, waitSeconds: float = 0, select: bool = True,
                         releaseToken: str | None = None) -> dict:
        actions: dict[str, Callable[[], Any]] = {
            "list": guard.list,
            "open": lambda: guard.open(tag=tag, select=select),
            "status": lambda: guard.status(windowId or "", waitSeconds),
            "select": lambda: guard.select(window_id=windowId, pid=pid, token=releaseToken),
            "release": lambda: guard.release(window_id=windowId, tag=tag, token=releaseToken),
            "report": guard.report,
        }
        return await runtime.cad(actions[action], timeout=60)

    # Sweep idle windows every few minutes even when no call arrives.
    async def sweeper() -> None:
        while True:
            await asyncio.sleep(SWEEP_EVERY_SECONDS)
            try:
                await runtime.cad(lambda: None, timeout=60)
            except Exception:  # noqa: BLE001 - a busy or failing sweep is retried on the next tick
                pass

    mcp._cad_guard_sweeper = sweeper  # type: ignore[attr-defined]
    return mcp


def main(install_dir: str) -> None:
    from .runtime import build
    try:
        guard, _ = build(install_dir, os.environ.get("CAD_GUARD_OPENER", "mcp-client"))
        # Stock loads here so a fingerprint or config problem fails at start, not on the first call.
        guard.stock.tools  # noqa: B018
    except GuardRefusal as refusal:
        sys.stderr.write(json.dumps(refusal.as_result()) + "\n")
        raise SystemExit(2) from None
    server = build_server(guard)

    async def serve() -> None:
        sweeper = asyncio.create_task(server._cad_guard_sweeper())  # type: ignore[attr-defined]
        try:
            await server.run_async(transport="stdio", show_banner=False)
        finally:
            sweeper.cancel()

    asyncio.run(serve())
