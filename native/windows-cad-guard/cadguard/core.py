"""The guard's decisions. Every method runs on the one CAD thread; COM objects never leave a call.

`platform` hides Win32 and the running-object table, and `stock` hides stock multiCAD, so this module is tested with
fakes on any OS. See references/DESIGN-2026-10-10-cad-guard.md in the Investment Library for the design.
"""
from __future__ import annotations

import hashlib
import ntpath
import os
import re
import secrets
import shutil
import time
import uuid
from contextlib import ExitStack, contextmanager
from pathlib import PureWindowsPath
from typing import Any, Callable, Iterator, Protocol

from . import ledger as L
from .errors import GuardRefusal
from .policy import EXPORT, NEW, SAVE, SWITCH, WRITE, Plan, classify

IDLE_RELEASE_SECONDS = 2 * 60 * 60
FOREIGN_IDLE_SECONDS = 30 * 60
STALLED_SECONDS = 180
QUIT_WAIT_SECONDS = 60
MUTEX_WAIT_SECONDS = 10
DWG_2018 = 64  # SaveAs type that ZWCAD 2025 writes as an AC1032 DWG (probed 2026-10-10)
STOCK_EXCEL_DEFAULT = "drawing_data.xlsx"
_TITLE_PATH = re.compile(r"\[([A-Za-z]:\\[^\]]+\.(?:dwg|dxf))\]\s*$", re.IGNORECASE)
_SESSION_FREE = {"status", "list_supported"}
_RELEASABLE = (L.READY, L.OPENING, L.CLOSING, L.HANDED_OVER)


class Platform(Protocol):
    def processes(self) -> list[dict]: ...
    def birth(self, pid: int) -> int | None: ...
    def window_state(self, pid: int) -> dict: ...
    def launch(self, exe: str, args: list[str], cwd: str, on_created: Callable[[int, int], None]) -> dict: ...
    def window_mutex(self, name: str, timeout: float) -> Any: ...
    def decline_crash_prompt(self, pid: int) -> bool: ...
    def helpers(self) -> list[dict]: ...
    def resolve(self, pid: int, birth: int, monikers: list[str]) -> Any: ...
    def release_com(self) -> None: ...
    def pump(self) -> None: ...


class Stock(Protocol):
    def parse(self, tool: str, arguments: dict) -> list[dict] | None: ...
    def run(self, tool: str, arguments: dict, application: Any) -> Any: ...
    def last_document(self) -> Any: ...
    def drop(self) -> None: ...


def norm(path: str) -> str:
    return ntpath.normcase(ntpath.normpath(path)) if path else ""


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def doc_names(document: Any) -> dict:
    """Name and path: the parts of a drawing ZWCAD reports reliably whether or not it is active."""
    return {"name": str(document.Name), "fullName": str(document.FullName or "")}


def is_dwg_file(path: str) -> bool:
    try:
        with open(path, "rb") as handle:
            return handle.read(4) == b"AC10"
    except OSError:
        return False


def doc_info(document: Any) -> dict:
    """Name, path and the unsaved flags; the flags are trustworthy only for the active drawing."""
    return {
        "name": str(document.Name),
        "fullName": str(document.FullName or ""),
        "saved": bool(document.Saved),
        "dbmod": int(document.GetVariable("DBMOD")),
    }


class Guard:
    def __init__(self, platform: Platform, stock: Stock, ledger: L.Ledger, *, sandbox: str, executable: str,
                 sentinel_template: str, opener: str, clock: Callable[[], float] = time.time,
                 new_id: Callable[[], str] = lambda: "w" + uuid.uuid4().hex[:12], sleep: Callable[[float], None] = time.sleep,
                 new_token: Callable[[], str] = lambda: secrets.token_hex(16)) -> None:
        self.platform = platform
        self.stock = stock
        self.ledger = ledger
        self.sandbox = sandbox
        self.executable = executable
        self.sentinel_template = sentinel_template
        self.opener = opener
        self.clock = clock
        self.new_id = new_id
        self.sleep = sleep
        self.new_token = new_token
        self.selection: str | None = None
        # Release tokens of the system windows this session opened or was handed; only their hashes are stored.
        self.tokens: dict[str, str] = {}
        self.last_incidents: list[dict] = []

    # ----- ownership --------------------------------------------------------------------------------------------
    def in_sandbox(self, path: str) -> bool:
        if not path:
            return False
        return norm(path).startswith(norm(self.sandbox).rstrip("\\") + "\\")

    def owned(self, record: dict, doc: dict) -> bool:
        """A drawing is the system's only if this window's record lists it as guard-created and it is still where the
        guard put it (under the sandbox) or still untitled under its recorded name."""
        if record.get("kind") != L.SYSTEM:
            return False
        for drawing in record.get("drawings", []):
            if drawing.get("fullName"):
                if doc["fullName"] and norm(doc["fullName"]) == norm(drawing["fullName"]) and self.in_sandbox(doc["fullName"]):
                    return True
            elif not doc["fullName"] and doc["name"] == drawing.get("name"):
                return True
        return False

    def token_ok(self, record: dict, token: str | None = None) -> bool:
        candidate = token or self.tokens.get(record["windowId"])
        return bool(candidate) and bool(record.get("tokenHash")) and secrets.compare_digest(record["tokenHash"], token_hash(candidate))

    # ----- cad_window -------------------------------------------------------------------------------------------
    def classify_process(self, process: dict, records: dict) -> str:
        for record in records.values():
            if record.get("pid") == process["pid"] and record.get("birth") == process["birth"] and record.get("state") not in (L.CLOSED, L.FAILED):
                return record["kind"]
        command = process.get("commandLine", "").lower()
        if "\\gotzji\\cad-sessions\\" in command:
            return "foreign-system"
        if self.in_sandbox_command(command):
            return "untracked-system"
        if "/automation" in command and "-embedding" in command:
            return "orphan-candidate"
        return L.OWNER

    def in_sandbox_command(self, command: str) -> bool:
        return norm(self.sandbox).rstrip("\\") + "\\" in norm(command.replace('"', ""))

    def _live_record(self, records: dict, process: dict) -> dict | None:
        return next((r for r in records.values() if r.get("pid") == process["pid"] and r.get("birth") == process["birth"]
                     and r.get("state") not in (L.CLOSED, L.FAILED)), None)

    def list(self) -> dict:
        records = self.ledger.snapshot()
        windows = []
        for process in self.platform.processes():
            kind = self.classify_process(process, records)
            match = _TITLE_PATH.search(process.get("title", ""))
            record = self._live_record(records, process)
            windows.append({
                "pid": process["pid"], "kind": kind, "title": process.get("title", ""), "visible": process.get("visible", False),
                "activeDrawing": match.group(1) if match else None,
                "windowId": record["windowId"] if record else None,
                "state": record["state"] if record else None,
                "opener": record.get("opener") if record else None,
                "selectable": (kind == L.SYSTEM and record is not None and record["state"] == L.READY) or (kind == L.OWNER and match is not None),
                "selected": record is not None and record["windowId"] == self.selection,
            })
        return {"success": True, "windows": windows}

    def open(self, tag: str | None = None, select: bool = True) -> dict:
        window_id = self.new_id()
        token = self.new_token()
        folder = os.path.join(self.sandbox, "windows", window_id)
        os.makedirs(folder, exist_ok=False)
        sentinel = os.path.join(folder, f"{window_id}.dwg")
        shutil.copyfile(self.sentinel_template, sentinel)
        now = self.clock()

        def record(pid: int, birth: int) -> None:
            # Written while ZWCAD is still suspended: a guard that dies here leaves a record, never an unknown window.
            self.ledger.put({
                "windowId": window_id, "kind": L.SYSTEM, "pid": pid, "birth": birth, "exe": self.executable,
                "sentinel": sentinel, "opener": self.opener, "tag": tag, "tokenHash": token_hash(token), "state": L.OPENING,
                "createdAt": now, "lastActivity": now, "drawings": [], "monikers": [sentinel], "incidents": [],
            })

        try:
            launched = self.platform.launch(self.executable, [sentinel], folder, record)
        except BaseException:
            # Nothing started (launch ends a suspended process it cannot record), so its folder goes too.
            shutil.rmtree(folder, ignore_errors=True)
            raise
        self.tokens[window_id] = token
        if select:
            self.selection = window_id
        return {"success": True, "windowId": window_id, "state": L.OPENING, "pid": launched["pid"], "inJob": launched.get("inJob", False),
                "releaseToken": token,
                "nextStep": "Poll cad_window 'status' with this windowId until state is 'ready'; ZWCAD takes about a minute to start. "
                            "Keep releaseToken: pass it to 'select' or 'release' if this guard restarts."}

    def status(self, window_id: str, wait_seconds: float = 0) -> dict:
        record = self.ledger.get(window_id)
        if record is None:
            raise GuardRefusal("CAD_WINDOW_NOT_SELECTED", f"unknown window {window_id}")
        deadline = self.clock() + max(0.0, min(float(wait_seconds), 20.0))
        while True:
            record = self.ledger.get(window_id) or record
            alive = self.platform.birth(record["pid"]) == record["birth"]
            if record["state"] == L.OPENING:
                if alive and record["kind"] == L.SYSTEM and self.platform.decline_crash_prompt(record["pid"]):
                    # ZWCAD asks after any unclean exit and waits forever; only in a window the guard started, and
                    # never with "remember my choice" (the provider in gotzji does the same for its owned sessions).
                    record = self._transition(window_id, (L.OPENING,), crashPromptDeclined=True) or record
                if not alive:
                    record = self._transition(window_id, (L.OPENING,), state=L.FAILED) or record
                elif self.platform.window_state(record["pid"]).get("visible") and self.platform.resolve(record["pid"], record["birth"], [record["sentinel"]]) is not None:
                    self.platform.release_com()
                    record = self._transition(window_id, (L.OPENING,), state=L.READY, lastActivity=self.clock(),
                                              drawings=[{"name": ntpath.basename(record["sentinel"]), "fullName": record["sentinel"], "origin": "sentinel"}]) or record
                else:
                    self.platform.release_com()
            elif record["state"] in (L.CLOSING, L.READY, L.HANDED_OVER) and not alive:
                record = self._transition(window_id, (L.CLOSING, L.READY, L.HANDED_OVER), state=L.CLOSED) or record
            if record["state"] != L.OPENING or self.clock() >= deadline:
                break
            self.sleep(1)
        result = {"success": True, "windowId": window_id, "state": record["state"], "pid": record["pid"], "kind": record["kind"]}
        if record.get("crashPromptDeclined"):
            result["crashPromptDeclined"] = True
        if record["state"] == L.CLOSING and self.clock() - record.get("closingAt", self.clock()) > QUIT_WAIT_SECONDS:
            result["quitPending"] = True
        if record["state"] == L.OPENING:
            dialogs = self.platform.window_state(record["pid"]).get("dialogs", [])
            if dialogs:
                result["dialogs"] = dialogs
            if self.clock() - record["createdAt"] > STALLED_SECONDS:
                result["stalled"] = True
        return result

    def _transition(self, window_id: str, expected: tuple[str, ...], **fields: object) -> dict | None:
        """Change a record only if it is still in an expected state (another guard may have moved it meanwhile)."""
        def change(windows: dict) -> dict | None:
            record = windows.get(window_id)
            if record is not None and record.get("state") in expected:
                record.update(fields)
            return record
        return self.ledger.update(change)  # type: ignore[return-value]

    def select(self, window_id: str | None = None, pid: int | None = None, token: str | None = None) -> dict:
        records = self.ledger.snapshot()
        if window_id is not None:
            record = records.get(window_id)
            if record is None or record["state"] != L.READY:
                raise GuardRefusal("CAD_WINDOW_NOT_READY" if record and record["state"] == L.OPENING else "CAD_WINDOW_NOT_SELECTABLE", str(window_id))
            if token and record["kind"] == L.SYSTEM:
                if not self.token_ok(record, token):
                    raise GuardRefusal("CAD_WINDOW_NOT_OWNER", "that releaseToken does not belong to this window")
                self.tokens[window_id] = token
            self.selection = window_id
            writable = record["kind"] == L.SYSTEM and self.token_ok(record)
            return {"success": True, "selected": window_id, "kind": record["kind"], "readOnly": not writable}
        process = next((p for p in self.platform.processes() if p["pid"] == pid), None)
        if process is None:
            raise GuardRefusal("CAD_WINDOW_GONE", str(pid))
        kind = self.classify_process(process, records)
        if kind == L.SYSTEM:
            record = self._live_record(records, process)
            return self.select(window_id=record["windowId"], token=token)  # type: ignore[index]
        match = _TITLE_PATH.search(process.get("title", ""))
        if kind != L.OWNER or match is None:
            raise GuardRefusal("CAD_WINDOW_NOT_SELECTABLE", f"pid {pid} is {kind}")
        window_id = f"owner-{L.window_key(pid, process['birth'])}"
        with self._window(pid, process["birth"]):
            application = self.platform.resolve(pid, process["birth"], [match.group(1)])
            if application is None:
                raise GuardRefusal("CAD_WINDOW_NOT_SELECTABLE", "its drawing is not registered (unsaved or not opened from a file)")
            try:
                monikers = [d["fullName"] for d in (doc_info(doc) for doc in application.Documents) if d["fullName"]]
            finally:
                del application
                self.platform.release_com()
        now = self.clock()

        def change(windows: dict) -> None:
            # Re-selecting keeps the window's incidents: they are the post-rollout record of changed owner drawings.
            previous = windows.get(window_id) or {}
            windows[window_id] = {"windowId": window_id, "kind": L.OWNER, "pid": pid, "birth": process["birth"], "state": L.READY,
                                  "opener": self.opener, "createdAt": previous.get("createdAt", now), "lastActivity": now,
                                  "drawings": [], "monikers": monikers, "incidents": previous.get("incidents", [])}

        self.ledger.update(change)
        self.selection = window_id
        return {"success": True, "selected": window_id, "kind": L.OWNER, "readOnly": True}

    def release(self, window_id: str | None = None, tag: str | None = None, token: str | None = None) -> dict:
        records = self.ledger.snapshot()
        if window_id is not None:
            record = records.get(window_id)
            if record and record.get("kind") == L.OWNER:
                # Owner windows are never closed; releasing one only drops the selection.
                if self.selection == window_id:
                    self.selection = None
                return {"success": True, "windowId": window_id, "state": "deselected"}
            targets = [record] if record and record.get("kind") == L.SYSTEM and record.get("state") in _RELEASABLE else []
            if not targets:
                raise GuardRefusal("CAD_WINDOW_NOT_SELECTABLE", f"no open system window {window_id}")
        else:
            tagged = [r for r in records.values() if r.get("kind") == L.SYSTEM and r.get("state") in _RELEASABLE and tag is not None and r.get("tag") == tag]
            targets = [r for r in tagged if self.token_ok(r, token)]
            if tagged and not targets:
                raise GuardRefusal("CAD_WINDOW_NOT_OWNER", f"{len(tagged)} window(s) with tag {tag!r}; pass their releaseToken")
        results = []
        for record in targets:
            try:
                results.append(self._release_one(record, authorized=self.token_ok(record, token)))
            except GuardRefusal as refusal:
                results.append({"windowId": record["windowId"], **refusal.as_result()})
        return {"success": all(r.get("success") for r in results), "windows": results}

    def _release_one(self, record: dict, authorized: bool, idle_at_least: float = 0) -> dict:
        window_id, pid, birth = record["windowId"], record["pid"], record["birth"]
        if not authorized:
            idle_at_least = max(idle_at_least, FOREIGN_IDLE_SECONDS)
        if idle_at_least and self.clock() - record.get("lastActivity", 0) < idle_at_least:
            raise GuardRefusal("CAD_WINDOW_NOT_OWNER", window_id)
        if self.platform.birth(pid) != birth:
            self._transition(window_id, _RELEASABLE, state=L.CLOSED)
            return {"success": True, "windowId": window_id, "state": L.CLOSED}
        with self._window(pid, birth):
            current = self.ledger.get(window_id) or record
            if idle_at_least and self.clock() - current.get("lastActivity", 0) < idle_at_least:
                # Used while we waited for the mutex: it is no longer idle.
                raise GuardRefusal("CAD_WINDOW_NOT_OWNER", window_id)
            if current.get("state") == L.OPENING:
                # It never finished starting: nothing to save, and the guard never kills. It is reported until it is ready.
                raise GuardRefusal("CAD_WINDOW_NOT_READY", window_id)
            state = self.platform.window_state(pid)
            if state.get("dialogs"):
                raise GuardRefusal("CAD_WINDOW_DIALOG_OPEN", ", ".join(state["dialogs"]))
            if not state.get("enabled", False):
                raise GuardRefusal("CAD_WINDOW_BLOCKED", window_id)
            application = self.platform.resolve(pid, birth, current.get("monikers") or [current["sentinel"]])
            if application is None:
                raise GuardRefusal("CAD_WINDOW_RESELECT_REQUIRED", window_id)
            try:
                saved_as = self._close_locked(current, application)
            finally:
                del application
                self.platform.release_com()
        if self.selection == window_id:
            self.selection = None
        return {"success": True, "windowId": window_id, "state": L.CLOSING, "savedAs": saved_as,
                "nextStep": "Poll cad_window 'status' until state is 'closed'."}

    def _close_locked(self, record: dict, application: Any) -> list[str]:
        """Save every system drawing into the sandbox as a new DWG, close it, and quit; the window mutex is held.

        ZWCAD 2025 reports Saved and DBMOD unreliably for a drawing that is not active, and SaveAs on an inactive drawing
        writes a file without renaming the drawing (observed 2026-10-10). So no decision here rests on those flags: each
        drawing is activated, saved unconditionally, and its file checked on disk before it is closed."""
        window_id = record["windowId"]
        documents = list(application.Documents)
        if len(documents) != int(application.Documents.Count):
            raise GuardRefusal("CAD_GUARD_INTERNAL", "ZWCAD listed fewer drawings than it counts; nothing was closed")
        names = [doc_names(doc) for doc in documents]
        # Kept with the window as evidence of what was open at the moment of closing (flags are ZWCAD's word only).
        snapshot = [{**doc_info(doc), "entities": int(doc.ModelSpace.Count)} for doc in documents]
        self.ledger.update(lambda windows: windows[window_id].update(closeSnapshot={"at": self.clock(), "drawings": snapshot}))
        foreign = [info["fullName"] or info["name"] for info in names if not self.owned(record, info)]
        if foreign:
            self._transition(window_id, _RELEASABLE, state=L.HANDED_OVER)
            raise GuardRefusal("CAD_WINDOW_FOREIGN_DOCUMENT", ", ".join(foreign))
        if int(application.ActiveDocument.GetVariable("CMDACTIVE")) != 0:
            raise GuardRefusal("CAD_WINDOW_COMMAND_ACTIVE", window_id)
        sentinel = norm(record.get("sentinel", ""))
        # The starting drawing goes last and stays open for Quit, so ZWCAD never creates an empty drawing in between.
        order = sorted(zip(documents, names), key=lambda pair: norm(pair[1]["fullName"]) == sentinel)
        saved_as = []
        for position, (doc, before) in enumerate(order):
            self._activate(application, doc, before)
            # Never Save(): it follows the profile's default type, which on the owner's machine is DXF, and writes
            # "<name>.dwg.dxf" while renaming the drawing. SaveAs with an explicit DWG type writes a real DWG.
            target = self._unique_drawing_path(window_id)
            application.ActiveDocument.SaveAs(target, DWG_2018)
            after = doc_names(application.ActiveDocument)
            # Recorded before the next step, so a retry after a failure here still knows the drawing is the system's.
            self._follow_rename(window_id, before, after)
            if norm(after["fullName"]) != norm(target) or not is_dwg_file(target):
                self._transition(window_id, _RELEASABLE, state=L.HANDED_OVER)
                raise GuardRefusal("CAD_WINDOW_FOREIGN_DOCUMENT", f"could not save {before['name']}")
            saved_as.append(target)
            self.ledger.update(lambda windows: windows[window_id].setdefault("savedAs", []).append(target))
            if int(application.ActiveDocument.GetVariable("DBMOD")) != 0:
                # Changed after the save (the owner typed into it, or the save did not take): never closed unsaved.
                self._transition(window_id, _RELEASABLE, state=L.HANDED_OVER)
                raise GuardRefusal("CAD_WINDOW_FOREIGN_DOCUMENT", f"{after['name']} has changes the save did not cover")
            if position < len(order) - 1:
                # Saved a moment ago and still the active drawing: closing it loses nothing.
                application.ActiveDocument.Close(False)
        remaining = [doc_names(doc) for doc in list(application.Documents)]
        if len(remaining) != (1 if order else 0) or any(not self.owned(self.ledger.get(window_id) or record, info) for info in remaining):
            self._transition(window_id, _RELEASABLE, state=L.HANDED_OVER)
            raise GuardRefusal("CAD_WINDOW_FOREIGN_DOCUMENT", "a drawing appeared while closing")
        self._transition(window_id, _RELEASABLE, state=L.CLOSING, closingAt=self.clock())
        application.Quit()
        return saved_as

    def _activate(self, application: Any, doc: Any, expected: dict) -> None:
        if doc_names(application.ActiveDocument) != expected:
            doc.Activate()
            self.platform.pump()
        if doc_names(application.ActiveDocument) != expected:
            raise GuardRefusal("CAD_GUARD_INTERNAL", f"could not make {expected['name']} the active drawing; nothing more was closed")

    def _follow_rename(self, window_id: str, before: dict, after: dict) -> None:
        def change(windows: dict) -> None:
            record = windows.get(window_id)
            if record is None:
                return
            for drawing in record.setdefault("drawings", []):
                if (drawing.get("fullName") and norm(drawing["fullName"]) == norm(before["fullName"])) or (not drawing.get("fullName") and drawing.get("name") == before["name"]):
                    drawing.update(name=after["name"], fullName=after["fullName"])
            if after["fullName"] and self.in_sandbox(after["fullName"]) and after["fullName"] not in record.setdefault("monikers", []):
                record["monikers"].append(after["fullName"])
        self.ledger.update(change)

    def _unique_drawing_path(self, window_id: str) -> str:
        folder = os.path.join(self.sandbox, "drawings")
        os.makedirs(folder, exist_ok=True)
        for index in range(1, 10_000):
            path = os.path.join(folder, f"{window_id}-{index}.dwg")
            if not os.path.exists(path):
                return path
        raise GuardRefusal("CAD_SAVE_TARGET_REFUSED", "no free name")

    def report(self) -> dict:
        records = self.ledger.snapshot()
        unknown = []
        for process in self.platform.processes():
            kind = self.classify_process(process, records)
            if kind in ("orphan-candidate", "untracked-system", "foreign-system"):
                match = _TITLE_PATH.search(process.get("title", ""))
                # A hidden ZWCAD still answers Explorer's DDE "open": a double-clicked drawing can land in it unseen.
                unknown.append({"pid": process["pid"], "kind": kind, "commandLine": process.get("commandLine", ""),
                                "visible": process.get("visible", False), "activeDrawing": match.group(1) if match else None})
        incidents = [{"windowId": r["windowId"], **i} for r in records.values() for i in r.get("incidents", [])]
        stuck = [{"windowId": r["windowId"], "pid": r["pid"], "state": r["state"]} for r in records.values()
                 if r.get("kind") == L.SYSTEM and r.get("state") in (L.OPENING, L.HANDED_OVER, L.CLOSING) and self.platform.birth(r["pid"]) == r["birth"]]
        system_pids = {r["pid"] for r in records.values() if r.get("kind") == L.SYSTEM}
        # ZWCAD starts its updater (ZwUpdHost.exe /mode auto) about 30 s in, and it outlives ZWCAD; the guard reports
        # the ones its windows started and never ends them itself.
        updaters = [helper for helper in self.platform.helpers() if helper["parentPid"] in system_pids]
        return {"success": True, "unknown": unknown, "incidents": incidents, "systemWindowsNeedingAttention": stuck, "leftoverHelpers": updaters}

    def sweep(self) -> list[dict]:
        """Release system windows idle for two hours; one window's failure never stops the others or the caller."""
        released = []
        for record in self.ledger.snapshot().values():
            if record.get("kind") != L.SYSTEM or record.get("state") not in (L.READY, L.CLOSING, L.HANDED_OVER):
                continue
            if self.clock() - record.get("lastActivity", 0) <= IDLE_RELEASE_SECONDS:
                continue
            try:
                released.append(self._release_one(record, authorized=True, idle_at_least=IDLE_RELEASE_SECONDS))
            except GuardRefusal as refusal:
                released.append({"windowId": record["windowId"], **refusal.as_result()})
            except Exception as error:  # noqa: BLE001 - recorded, and the next window still gets its turn
                self._incident(record["windowId"], "sweepFailed", f"{type(error).__name__}: {error}"[:300])
                released.append({"windowId": record["windowId"], "success": False, "code": "CAD_GUARD_INTERNAL"})
        return released

    def _incident(self, window_id: str, kind: str, detail: str) -> None:
        def change(windows: dict) -> None:
            if window_id in windows:
                windows[window_id].setdefault("incidents", []).append({"at": self.clock(), "kind": kind, "detail": detail})
        self.ledger.update(change)

    # ----- stock calls ------------------------------------------------------------------------------------------
    @contextmanager
    def _window(self, pid: int, birth: int) -> Iterator[None]:
        """Hold the window's machine-wide mutex: guards of every host serialize on it, and Windows frees it if we die."""
        with ExitStack() as stack:
            try:
                stack.enter_context(self.platform.window_mutex(f"Local\\cad-guard-window-{L.window_key(pid, birth)}", MUTEX_WAIT_SECONDS))
            except TimeoutError as error:
                raise GuardRefusal("CAD_WINDOW_BUSY") from error
            yield

    def plan(self, tool: str, arguments: dict) -> tuple[Plan, list[dict]]:
        specs = self.stock.parse(tool, arguments) if tool.startswith("manage_") else []
        actions = None if specs is None else [str(spec.get("action")).lower() if isinstance(spec, dict) and isinstance(spec.get("action"), str) else "" for spec in specs]
        if actions is not None and "" in actions:
            actions = None
        return classify(tool, actions, arguments), specs or []

    def call(self, tool: str, arguments: dict) -> Any:
        self.last_incidents = []
        plan, specs = self.plan(tool, arguments)
        if plan.refused:
            raise GuardRefusal(plan.reason or "CAD_ACTION_REFUSED", ", ".join(plan.actions))
        if tool == "manage_session" and set(plan.actions) <= _SESSION_FREE:
            return self.stock.run(tool, arguments, None)
        if self.selection is None:
            raise GuardRefusal("CAD_WINDOW_NOT_SELECTED")
        record = self.ledger.get(self.selection)
        if record is None or record["state"] != L.READY:
            raise GuardRefusal("CAD_WINDOW_NOT_READY" if record and record["state"] == L.OPENING else "CAD_WINDOW_GONE", self.selection)
        pid, birth = record["pid"], record["birth"]
        with self._window(pid, birth):
            # Re-read under the mutex: another host's guard may have changed this window while we waited.
            record = self.ledger.get(record["windowId"]) or record
            if record["state"] != L.READY:
                raise GuardRefusal("CAD_WINDOW_GONE", record["windowId"])
            if self.platform.birth(pid) != birth:
                self._transition(record["windowId"], (L.READY,), state=L.CLOSED)
                raise GuardRefusal("CAD_WINDOW_GONE", record["windowId"])
            state = self.platform.window_state(pid)
            if not state.get("visible", False):
                raise GuardRefusal("CAD_WINDOW_CLOSED_BY_USER", record["windowId"] + self._after_user_closed(record))
            if not state.get("enabled", False):
                raise GuardRefusal("CAD_WINDOW_BLOCKED", record["windowId"])
            if state.get("dialogs"):
                raise GuardRefusal("CAD_WINDOW_DIALOG_OPEN", ", ".join(state["dialogs"]))
            application = self.platform.resolve(pid, birth, record.get("monikers") or [])
            if application is None:
                raise GuardRefusal("CAD_WINDOW_RESELECT_REQUIRED", record["windowId"])
            try:
                return self._call_bound(record, plan, specs, tool, arguments, application)
            finally:
                del application
                self.stock.drop()
                self.platform.release_com()

    def _after_user_closed(self, record: dict) -> str:
        """The owner closed a window ZWCAD kept alive hidden; a system window with only system drawings is released."""
        if record["kind"] != L.SYSTEM:
            return ""
        state = self.platform.window_state(record["pid"])
        if state.get("dialogs") or not state.get("enabled", False):
            return " (left open: ZWCAD is showing a dialog or not accepting input)"
        application = self.platform.resolve(record["pid"], record["birth"], record.get("monikers") or [])
        if application is None:
            return ""
        try:
            self._close_locked(record, application)
            return " (its system drawings were saved into the sandbox and it was closed)"
        except GuardRefusal as refusal:
            return f" ({refusal.code})"
        except Exception as error:  # noqa: BLE001 - the caller still gets CLOSED_BY_USER
            self._incident(record["windowId"], "closeAfterUserFailed", f"{type(error).__name__}: {error}"[:300])
            return " (CAD_GUARD_INTERNAL)"
        finally:
            del application
            self.platform.release_com()

    def _call_bound(self, record: dict, plan: Plan, specs: list[dict], tool: str, arguments: dict, application: Any) -> Any:
        documents = list(application.Documents)
        before = [doc_info(doc) for doc in documents]
        active = doc_info(application.ActiveDocument)
        if plan.writes:
            if record["kind"] != L.SYSTEM:
                raise GuardRefusal("CAD_DRAWING_READ_ONLY", active["fullName"] or active["name"])
            foreign = [info["fullName"] or info["name"] for info in before if not self.owned(record, info)]
            if foreign:
                # A drawing the owner opened here (for example by double-clicking a file) makes every write a race
                # with the owner's tab switching; the whole window turns read-only.
                raise GuardRefusal("CAD_WINDOW_HOLDS_OWNER_DRAWING", ", ".join(foreign))
            if not self.token_ok(record):
                raise GuardRefusal("CAD_WINDOW_NOT_OWNER", "pass this window's releaseToken to cad_window select to write in it")
            if plan.kinds & {WRITE, SAVE} and not self.owned(record, active):
                raise GuardRefusal("CAD_DRAWING_READ_ONLY", active["fullName"] or active["name"])
            if SWITCH in plan.kinds:
                target = next((info for info in before if info["name"] == specs[0].get("drawing_name")), None)
                if target is None or not self.owned(record, target):
                    raise GuardRefusal("CAD_DRAWING_READ_ONLY", f"switch target {specs[0].get('drawing_name')!r} is not a system drawing")
            if SAVE in plan.kinds:
                if norm(active["fullName"]) == norm(record.get("sentinel", "")):
                    raise GuardRefusal("CAD_SAVE_TARGET_REFUSED", "the window's starting drawing is never renamed; save a drawing made with 'new'")
                target = self.save_target(specs[0], active["name"])
                if target is None or os.path.exists(target):
                    raise GuardRefusal("CAD_SAVE_TARGET_REFUSED", str(target))
            if int(application.ActiveDocument.GetVariable("CMDACTIVE")) != 0:
                raise GuardRefusal("CAD_WINDOW_COMMAND_ACTIVE", record["windowId"])
        if EXPORT in plan.kinds:
            targets = self.excel_targets(arguments, active["name"])
            if targets is None or any(os.path.exists(path) for path in targets):
                raise GuardRefusal("CAD_SAVE_TARGET_REFUSED", "an Excel export needs a new .xlsx file name without folders")

        active_entities = int(application.ActiveDocument.ModelSpace.Count)
        result = self.stock.run(tool, arguments, application)

        created = None
        if NEW in plan.kinds:
            last = self.stock.last_document()
            created = doc_info(last) if last is not None else None
        after = [doc_info(doc) for doc in list(application.Documents)]
        now_active = {**doc_info(application.ActiveDocument), "entities": int(application.ActiveDocument.ModelSpace.Count)}
        self._record_after(record, before, after, {**active, "entities": active_entities}, now_active, created, plan)
        return result

    def save_target(self, spec: dict, active_name: str) -> str | None:
        """The path stock's save_drawing writes (file_mixin.py:56-83, allow_arbitrary_paths false), or None if it would
        not be a file under the sandbox's drawings folder."""
        fmt = spec.get("format", "dwg")
        filepath, filename = spec.get("filepath", ""), spec.get("filename", "")
        if not isinstance(fmt, str) or not isinstance(filepath, str) or not isinstance(filename, str):
            return None
        # Stock: Path(filepath).name, which drops "." parts and trailing separators exactly as PureWindowsPath does.
        name = PureWindowsPath(filepath).name if filepath else filename
        if not name:
            name = active_name
        if not name:
            return None
        if not name.lower().endswith(f".{fmt}"):
            name = f"{name}.{fmt}"
        drawings = os.path.join(self.sandbox, "drawings")
        # Stock: (output_dir / "drawings" / filename).resolve(); an absolute or rooted filename replaces the folder.
        target = os.path.normpath(str(PureWindowsPath(drawings) / name).replace("\\", os.sep))
        return target if norm(target).startswith(norm(drawings) + "\\") else None

    def excel_targets(self, arguments: dict, active_name: str) -> list[str] | None:
        """Where stock's Excel export may write (export.py:52-71 for a selection, sheets\\ for everything)."""
        filename = arguments.get("filename", STOCK_EXCEL_DEFAULT)
        if not isinstance(filename, str):
            return None
        if filename in ("", STOCK_EXCEL_DEFAULT):
            filename = f"{PureWindowsPath(active_name).stem or 'drawing'}_data.xlsx"
        if any(separator in filename for separator in "/\\:") or not filename.lower().endswith(".xlsx") or filename.strip(". ") != filename:
            return None
        return [os.path.join(self.sandbox, filename), os.path.join(self.sandbox, "sheets", filename)]

    def _record_after(self, record: dict, before: list[dict], after: list[dict], active: dict, now_active: dict, created: dict | None, plan: Plan) -> None:
        window_id = record["windowId"]
        now = self.clock()
        incidents = []
        before_by_key = {(b["fullName"] or b["name"]): b for b in before}
        # Stock acts on the active drawing, and only the active drawing's flags are reliable: an owner drawing that was
        # active before and after the call must have the same unsaved flag and entity count.
        if (active["name"], active["fullName"]) == (now_active["name"], now_active["fullName"]) and not self.owned(record, active) and (active["dbmod"], active["entities"]) != (now_active["dbmod"], now_active["entities"]):
            incidents.append({"at": now, "kind": "ownerDrawingChanged", "drawing": active["fullName"] or active["name"], "before": active, "after": now_active})
        self.last_incidents = incidents

        def change(windows: dict) -> None:
            current = windows.get(window_id)
            if current is None:
                return
            drawings = current.setdefault("drawings", [])
            if created is not None and record["kind"] == L.SYSTEM and created["name"] not in [b["name"] for b in before]:
                drawings.append({"name": created["name"], "fullName": created["fullName"], "origin": "new"})
            if SAVE in plan.kinds and self.owned(record, active):
                # SaveAs renamed the active system drawing; follow it to its new place in the sandbox.
                renamed = next((info for info in after if info["fullName"] and self.in_sandbox(info["fullName"])
                                and info["fullName"] not in before_by_key), None)
                if renamed is not None:
                    for drawing in drawings:
                        if (drawing.get("fullName") and norm(drawing["fullName"]) == norm(active["fullName"])) or (not drawing.get("fullName") and drawing.get("name") == active["name"]):
                            drawing.update(name=renamed["name"], fullName=renamed["fullName"])
            titled = [info["fullName"] for info in after if info["fullName"]]
            if record["kind"] == L.SYSTEM:
                # Only the guard's own sandbox drawings: an owner drawing here may later live in another ZWCAD.
                titled = [path for path in titled if self.in_sandbox(path)]
            sentinel = current.get("sentinel")
            current["monikers"] = ([sentinel] if sentinel else []) + [p for p in titled if not sentinel or norm(p) != norm(sentinel)]
            current["lastActivity"] = now
            current.setdefault("incidents", []).extend(incidents)

        self.ledger.update(change)
