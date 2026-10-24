"""In-memory stand-ins for ZWCAD's COM objects, Win32 and stock multiCAD, so the guard's decisions run on any OS."""
from __future__ import annotations

import json
import ntpath
import os
import threading
from contextlib import contextmanager
from typing import Any, Callable, Iterator


class FakeCollection(list):
    @property
    def Count(self) -> int:
        return len(self)


class FakeModelSpace:
    def __init__(self) -> None:
        self.Count = 0


class FakeDoc:
    def __init__(self, app: "FakeApp", name: str, full_name: str = "", saved: bool = True, dbmod: int = 0) -> None:
        self.app, self.Name, self.FullName, self._saved, self.dbmod = app, name, full_name, saved, dbmod
        self.closed = False
        self.stuck_dirty = False
        self.writes_files = True
        self.ModelSpace = FakeModelSpace()

    @property
    def Saved(self) -> bool:
        # ZWCAD 2025 reports an inactive drawing's flags unreliably; the fake lies in the dangerous direction.
        return True if self.app.unreliable_inactive and self.app.active is not self else self._saved

    @Saved.setter
    def Saved(self, value: bool) -> None:
        self._saved = value

    def GetVariable(self, name: str) -> int:
        dbmod = 0 if self.app.unreliable_inactive and self.app.active is not self else self.dbmod
        return {"DBMOD": dbmod, "CMDACTIVE": self.app.cmdactive}[name]

    def Activate(self) -> None:
        self.app.active = self

    def edit(self) -> None:
        self.Saved, self.dbmod = False, 1
        self.ModelSpace.Count += 1

    def Save(self) -> None:
        # ZWCAD 2025 on the owner's machine: Save() follows the profile's DXF default, writes "<name>.dxf" and renames.
        self.SaveAs(self.FullName + ".dxf")

    def SaveAs(self, path: str, file_type: int | None = None) -> None:
        if file_type is not None and os.path.isdir(os.path.dirname(path)) and self.writes_files:
            with open(path, "wb") as out:
                out.write(b"AC1032-fake")
        if self.app.active is not self:
            return  # ZWCAD 2025: the file is written but the inactive drawing keeps its name
        self.FullName, self.Name = path, ntpath.basename(path)
        if not self.stuck_dirty:
            self._saved, self.dbmod = True, 0
        self.app.platform.saved_files.add(path)
        self.app.platform.save_types.append(file_type)

    def Close(self, save: bool) -> None:
        self.closed = True
        self.app.docs.remove(self)
        if self.app.active is self:
            self.app.active = self.app.docs[-1] if self.app.docs else None


class FakeApp:
    def __init__(self, platform: "FakePlatform", pid: int) -> None:
        self.platform, self.pid = platform, pid
        self.docs: list[FakeDoc] = []
        self.active: FakeDoc | None = None
        self.cmdactive = 0
        self.quit = False
        self.unreliable_inactive = True
        self.HWND = 1000 + pid

    @property
    def Documents(self) -> FakeCollection:
        return FakeCollection(self.docs)

    @property
    def ActiveDocument(self) -> FakeDoc:
        assert self.active is not None
        return self.active

    def add(self, name: str, full_name: str = "", activate: bool = True, **state: Any) -> FakeDoc:
        doc = FakeDoc(self, name, full_name, **state)
        self.docs.append(doc)
        if activate or self.active is None:
            self.active = doc
        return doc

    def Quit(self) -> None:
        self.quit = True


class FakePlatform:
    def __init__(self) -> None:
        self.procs: dict[int, dict] = {}
        self.next_pid = 500
        self.locks: dict[str, threading.Lock] = {}
        self.busy: set[str] = set()
        self.calls: list[str] = []
        self.released = 0
        self.saved_files: set[str] = set()
        self.save_types: list[int | None] = []
        self.launch_order: list[str] = []
        self.declined: list[int] = []
        self.resume_hook = None
        self.helper_rows: list[dict] = []

    def add_process(self, pid: int, *, birth: int = 1, command: str = "", title: str = "", visible: bool = True, enabled: bool = True, dialogs: list[str] | None = None) -> FakeApp:
        app = FakeApp(self, pid)
        self.procs[pid] = {"pid": pid, "birth": birth, "exe": "ZWCAD.exe", "commandLine": command, "title": title,
                           "visible": visible, "enabled": enabled, "dialogs": dialogs or [], "app": app, "registered": True}
        return app

    def processes(self) -> list[dict]:
        self.calls.append("processes")
        return [{k: v for k, v in p.items() if k not in ("app", "registered")} for p in self.procs.values() if not p["app"].quit]

    def birth(self, pid: int) -> int | None:
        proc = self.procs.get(pid)
        return None if proc is None or proc["app"].quit else proc["birth"]

    def window_state(self, pid: int) -> dict:
        proc = self.procs[pid]
        return {"visible": proc["visible"], "enabled": proc["enabled"], "dialogs": list(proc["dialogs"]), "title": proc["title"]}

    def launch(self, exe: str, args: list[str], cwd: str, on_created: Callable[[int, int], None]) -> dict:
        self.next_pid += 1
        pid = self.next_pid
        app = self.add_process(pid, birth=77, command=f'"{exe}" "{args[0]}"')
        self.procs[pid]["registered"] = False
        self.launch_order.append("created")
        on_created(pid, 77)
        if self.resume_hook is not None:
            self.resume_hook(pid)
        self.launch_order.append("resumed")
        app.add(ntpath.basename(args[0]), args[0])
        return {"pid": pid, "inJob": False}

    def finish_startup(self, pid: int) -> None:
        self.procs[pid]["registered"] = True

    @contextmanager
    def window_mutex(self, name: str, timeout: float) -> Iterator[None]:
        if name in self.busy:
            raise TimeoutError(name)
        self.calls.append(f"mutex:{name}")
        yield

    def resolve(self, pid: int, birth: int, monikers: list[str]) -> Any:
        self.calls.append(f"resolve:{pid}")
        proc = self.procs.get(pid)
        if proc is None or proc["birth"] != birth or proc["app"].quit or not proc["registered"]:
            return None
        wanted = {ntpath.normcase(m) for m in monikers}
        return proc["app"] if any(doc.FullName and ntpath.normcase(doc.FullName) in wanted for doc in proc["app"].docs) else None

    def release_com(self) -> None:
        self.released += 1

    def pump(self) -> None:
        pass

    def helpers(self) -> list[dict]:
        return list(self.helper_rows)

    def decline_crash_prompt(self, pid: int) -> bool:
        proc = self.procs[pid]
        if "crash-report" not in proc["dialogs"]:
            return False
        proc["dialogs"].remove("crash-report")
        self.declined.append(pid)
        return True


class FakeStock:
    """Parses like stock (JSON list or object) and applies a small model of each action to the bound app."""

    def __init__(self, sandbox: str) -> None:
        self.sandbox = sandbox
        self.ran: list[tuple[str, dict]] = []
        self.last: FakeDoc | None = None
        self.dropped = 0
        self.raise_on_run: Exception | None = None

    def parse(self, tool: str, arguments: dict) -> list[dict] | None:
        try:
            ops = json.loads(arguments["operations"])
        except (KeyError, TypeError, json.JSONDecodeError):
            return None
        return ops if isinstance(ops, list) else [ops]

    def run(self, tool: str, arguments: dict, application: Any) -> Any:
        self.ran.append((tool, arguments))
        if self.raise_on_run is not None:
            raise self.raise_on_run
        if tool == "draw_entities":
            application.ActiveDocument.edit()
        for spec in (self.parse(tool, arguments) or []) if tool.startswith("manage_") else []:
            action = spec["action"].lower()
            if action == "new":
                self.last = application.add(f"Drawing{len(application.docs) + 1}.dwg")
            elif action == "save":
                name = spec.get("filename") or application.ActiveDocument.Name
                application.ActiveDocument.SaveAs(ntpath.join(self.sandbox, "drawings", name))
            elif action == "switch":
                application.active = next(d for d in application.docs if d.Name == spec["drawing_name"])
            elif action in ("create", "delete"):
                application.ActiveDocument.edit()
        return json.dumps({"success": True})

    def last_document(self) -> Any:
        return self.last

    def drop(self) -> None:
        self.dropped += 1
        self.last = None
