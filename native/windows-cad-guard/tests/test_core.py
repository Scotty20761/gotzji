import json
import ntpath
import os
import shutil
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cadguard import ledger as L  # noqa: E402
from cadguard.core import FOREIGN_IDLE_SECONDS, IDLE_RELEASE_SECONDS, QUIT_WAIT_SECONDS, Guard, norm  # noqa: E402
from cadguard.errors import GuardRefusal  # noqa: E402
from fakes import FakePlatform, FakeStock  # noqa: E402

OWNER_PATH = r"C:\Users\owner\work\plan.dwg"


def ops(*actions, **extra):
    return {"operations": json.dumps([{"action": a, **extra} for a in actions])}


def op_list(*specs):
    return {"operations": json.dumps(list(specs))}


class _Short(list):
    """ZWCAD enumerating fewer drawings than its Count says."""

    def __init__(self, documents) -> None:
        super().__init__(documents[:-1])
        self.Count = len(documents)


class Clock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


class GuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="cadguard-test-")
        self.sandbox = os.path.join(self.root, "sandbox")
        os.makedirs(self.sandbox)
        self.template = os.path.join(self.root, "blank.dwg")
        with open(self.template, "wb") as out:
            out.write(b"AC1032-blank")
        lock = threading.Lock()

        @contextmanager
        def held():
            with lock:
                yield

        self.ledger = L.Ledger(os.path.join(self.root, "state", "ledger.json"), held)
        self.platform = FakePlatform()
        self.stock = FakeStock(self.sandbox)
        self.clock = Clock()
        self.ids = iter(f"w{n:04d}" for n in range(1, 100))
        self.tokens = iter(f"token-{n}" for n in range(1, 100))
        self.on_sleep: list = []
        self.guard = self.make_guard("lnwjud-mcp-bridge")

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def make_guard(self, opener: str) -> Guard:
        return Guard(self.platform, self.stock, self.ledger, sandbox=self.sandbox, executable=r"E:\ZWCAD\ZWCAD.exe",
                     sentinel_template=self.template, opener=opener, clock=self.clock, new_id=lambda: next(self.ids),
                     sleep=self.sleep, new_token=lambda: next(self.tokens))

    def sleep(self, seconds: float) -> None:
        self.clock.now += seconds
        for hook in list(self.on_sleep):
            hook()

    def open_ready(self, guard: Guard | None = None) -> dict:
        guard = guard or self.guard
        opened = guard.open(tag="goal-1")
        self.platform.finish_startup(opened["pid"])
        self.assertEqual(guard.status(opened["windowId"])["state"], L.READY)
        return opened

    def app(self, opened: dict):
        return self.platform.procs[opened["pid"]]["app"]

    def refused(self, code: str, call, *args, **kwargs) -> GuardRefusal:
        with self.assertRaises(GuardRefusal) as caught:
            call(*args, **kwargs)
        self.assertEqual(caught.exception.code, code, caught.exception)
        return caught.exception

    def owner_window(self, pid: int = 42):
        app = self.platform.add_process(pid, birth=9, title=f"ZWCAD 2025 Professional Edition - [{OWNER_PATH}]")
        app.add("plan.dwg", OWNER_PATH)
        return pid, app

    # ----- selection and binding ------------------------------------------------------------------------------
    def test_a_call_without_a_selected_window_is_refused_without_touching_any_window(self) -> None:
        self.refused("CAD_WINDOW_NOT_SELECTED", self.guard.call, "manage_layers", ops("list"))
        self.assertFalse([c for c in self.platform.calls if c.startswith(("resolve", "mutex"))])
        self.assertEqual(self.stock.ran, [])

    def test_session_status_runs_without_a_window_and_without_binding(self) -> None:
        self.guard.call("manage_session", ops("status"))
        self.assertEqual(self.stock.ran[0][0], "manage_session")
        self.assertFalse([c for c in self.platform.calls if c.startswith("resolve")])

    def test_never_forwarded_actions_are_refused_before_any_window_is_touched(self) -> None:
        self.open_ready()
        self.platform.calls.clear()
        for tool, arguments, code in [
            ("manage_session", ops("connect"), "CAD_ACTION_REFUSED"),
            ("manage_session", ops("check_running"), "CAD_ACTION_REFUSED"),
            ("manage_session", ops("status", "open_dashboard"), "CAD_ACTION_REFUSED"),
            ("manage_session", ops("screenshot"), "CAD_ACTION_REFUSED"),
            ("manage_files", ops("close"), "CAD_ACTION_REFUSED"),
            ("manage_files", ops("list", "close"), "CAD_ACTION_REFUSED"),
            ("manage_entities", ops("copy"), "CAD_ACTION_REFUSED"),
            ("manage_entities", ops("paste"), "CAD_ACTION_REFUSED"),
            ("manage_layers", ops("teleport"), "CAD_ACTION_UNKNOWN"),
            ("manage_layers", {"operations": "{not json"}, "CAD_INPUT_UNREADABLE"),
            ("manage_files", ops("new", "new"), "CAD_FILE_ACTION_ALONE"),
            ("run_lisp", {}, "CAD_TOOL_UNKNOWN"),
        ]:
            with self.subTest(tool=tool, arguments=arguments):
                self.refused(code, self.guard.call, tool, arguments)
        self.assertFalse([c for c in self.platform.calls if c.startswith(("resolve", "mutex"))])
        self.assertEqual(self.stock.ran, [])

    def test_open_records_the_window_while_it_is_still_suspended_and_returns_before_it_is_ready(self) -> None:
        seen_at_resume = []
        self.platform.resume_hook = lambda pid: seen_at_resume.append([r["state"] for r in self.ledger.snapshot().values() if r["pid"] == pid])
        opened = self.guard.open(tag="goal-1")
        self.assertEqual(seen_at_resume, [[L.OPENING]])
        self.assertEqual(opened["state"], L.OPENING)
        self.assertEqual(opened["releaseToken"], "token-1")
        record = self.ledger.get(opened["windowId"])
        self.assertEqual((record["state"], record["opener"], record["tag"]), (L.OPENING, "lnwjud-mcp-bridge", "goal-1"))
        self.assertNotIn("token-1", json.dumps(record))
        self.assertTrue(record["sentinel"].endswith(f"{opened['windowId']}.dwg"))
        self.assertTrue(os.path.exists(record["sentinel"]))
        self.refused("CAD_WINDOW_NOT_READY", self.guard.call, "manage_layers", ops("list"))
        self.assertEqual(self.guard.status(opened["windowId"])["state"], L.OPENING)
        self.platform.finish_startup(opened["pid"])
        self.assertEqual(self.guard.status(opened["windowId"])["state"], L.READY)

    def test_a_launch_that_fails_leaves_no_record_and_no_folder(self) -> None:
        def broken(exe, args, cwd, on_created):
            raise OSError(5, "CreateProcessW")
        self.platform.launch = broken
        with self.assertRaises(OSError):
            self.guard.open()
        self.assertEqual(os.listdir(os.path.join(self.sandbox, "windows")), [])
        self.assertEqual(self.ledger.snapshot(), {})

    def test_status_waits_for_the_window_to_become_ready(self) -> None:
        opened = self.guard.open()
        self.on_sleep.append(lambda: self.platform.finish_startup(opened["pid"]))
        self.assertEqual(self.guard.status(opened["windowId"], wait_seconds=10)["state"], L.READY)
        self.assertLess(self.clock.now - 1_000_000.0, 3)

    def test_status_waits_at_most_twenty_seconds(self) -> None:
        opened = self.guard.open()
        self.assertEqual(self.guard.status(opened["windowId"], wait_seconds=600)["state"], L.OPENING)
        self.assertLessEqual(self.clock.now - 1_000_000.0, 21)

    def test_status_never_moves_a_window_back_to_ready(self) -> None:
        opened = self.open_ready()
        self.guard.call("manage_files", ops("new"))
        self.guard.status(opened["windowId"])
        self.assertEqual(len(self.ledger.get(opened["windowId"])["drawings"]), 2)

    def test_a_status_poll_never_overwrites_what_another_guard_recorded_meanwhile(self) -> None:
        opened = self.guard.open()
        self.platform.finish_startup(opened["pid"])
        real_resolve = self.platform.resolve

        def racing(pid, birth, monikers):
            # Another host's guard finished the start-up and recorded a new drawing between our read and our write.
            self.ledger.update(lambda windows: windows[opened["windowId"]].update(
                state=L.READY, drawings=[{"name": "a.dwg", "fullName": "x"}, {"name": "Drawing2.dwg", "fullName": ""}]))
            return real_resolve(pid, birth, monikers)

        self.platform.resolve = racing
        self.guard.status(opened["windowId"])
        self.assertEqual(len(self.ledger.get(opened["windowId"])["drawings"]), 2)

    def test_the_crash_report_prompt_is_declined_only_in_a_window_the_guard_started(self) -> None:
        opened = self.guard.open()
        self.platform.procs[opened["pid"]]["dialogs"] = ["crash-report"]
        self.platform.finish_startup(opened["pid"])
        status = self.guard.status(opened["windowId"])
        self.assertEqual(self.platform.declined, [opened["pid"]])
        self.assertTrue(status["crashPromptDeclined"])
        pid, _ = self.owner_window()
        self.platform.procs[pid]["dialogs"] = ["crash-report"]
        self.guard.select(pid=pid)
        self.refused("CAD_WINDOW_DIALOG_OPEN", self.guard.call, "manage_layers", ops("list"))
        self.assertEqual(self.platform.declined, [opened["pid"]])

    def test_status_names_dialogs_while_opening_and_flags_a_stall(self) -> None:
        opened = self.guard.open()
        self.platform.procs[opened["pid"]]["dialogs"] = ["Drawing Recovery"]
        self.assertEqual(self.guard.status(opened["windowId"])["dialogs"], ["Drawing Recovery"])
        self.clock.now += 200
        self.assertTrue(self.guard.status(opened["windowId"])["stalled"])

    def test_a_window_becomes_ready_only_once_its_main_window_is_visible(self) -> None:
        opened = self.guard.open()
        self.platform.procs[opened["pid"]]["visible"] = False
        self.platform.finish_startup(opened["pid"])
        self.assertEqual(self.guard.status(opened["windowId"])["state"], L.OPENING)
        self.platform.procs[opened["pid"]]["visible"] = True
        self.assertEqual(self.guard.status(opened["windowId"])["state"], L.READY)

    def test_a_window_that_dies_while_opening_is_failed(self) -> None:
        opened = self.guard.open()
        self.app(opened).quit = True
        self.assertEqual(self.guard.status(opened["windowId"])["state"], L.FAILED)

    def test_calls_land_only_in_the_selected_window_and_bind_only_its_own_drawings(self) -> None:
        first = self.open_ready()
        second = self.open_ready()
        self.guard.select(window_id=first["windowId"])
        self.platform.calls.clear()
        self.guard.call("draw_entities", {"entities": "line|0,0|1,1"})
        self.assertEqual([c for c in self.platform.calls if c.startswith("resolve")], [f"resolve:{first['pid']}"])
        self.assertEqual(self.app(first).ActiveDocument.dbmod, 1)
        self.assertEqual(self.app(second).ActiveDocument.dbmod, 0)

    def test_references_are_dropped_after_every_call_even_when_stock_fails(self) -> None:
        self.open_ready()
        self.stock.raise_on_run = RuntimeError("stock failed")
        released, dropped = self.platform.released, self.stock.dropped
        with self.assertRaises(RuntimeError):
            self.guard.call("draw_entities", {"entities": "x"})
        self.assertEqual((self.platform.released, self.stock.dropped), (released + 1, dropped + 1))

    def test_window_checks_refuse_with_the_named_reason(self) -> None:
        opened = self.open_ready()
        proc = self.platform.procs[opened["pid"]]
        for field, value, code in [("enabled", False, "CAD_WINDOW_BLOCKED"), ("dialogs", ["Save changes?"], "CAD_WINDOW_DIALOG_OPEN")]:
            with self.subTest(field=field):
                original = proc[field]
                proc[field] = value
                self.refused(code, self.guard.call, "manage_layers", ops("list"))
                proc[field] = original
        self.assertEqual(self.stock.ran, [])

    def test_a_system_window_the_owner_closed_but_zwcad_kept_hidden_is_saved_and_closed(self) -> None:
        opened = self.open_ready()
        self.guard.call("draw_entities", {"entities": "x"})
        self.platform.procs[opened["pid"]]["visible"] = False
        refusal = self.refused("CAD_WINDOW_CLOSED_BY_USER", self.guard.call, "manage_layers", ops("list"))
        self.assertIn("closed", refusal.detail)
        self.assertTrue(self.app(opened).quit)
        self.assertEqual(self.ledger.get(opened["windowId"])["state"], L.CLOSING)

    def test_a_hidden_window_showing_a_dialog_is_left_alone(self) -> None:
        opened = self.open_ready()
        self.guard.call("draw_entities", {"entities": "x"})
        proc = self.platform.procs[opened["pid"]]
        proc["visible"], proc["dialogs"] = False, ["Save changes?"]
        refusal = self.refused("CAD_WINDOW_CLOSED_BY_USER", self.guard.call, "manage_layers", ops("list"))
        self.assertIn("left open", refusal.detail)
        self.assertFalse(self.app(opened).quit)

    def test_a_busy_window_is_refused_not_waited_on_forever(self) -> None:
        opened = self.open_ready()
        self.platform.busy.add(f"Local\\cad-guard-window-{opened['pid']}-77")
        self.refused("CAD_WINDOW_BUSY", self.guard.call, "manage_layers", ops("list"))

    def test_a_dead_window_is_refused_and_recorded_closed(self) -> None:
        opened = self.open_ready()
        self.app(opened).quit = True
        self.refused("CAD_WINDOW_GONE", self.guard.call, "manage_layers", ops("list"))
        self.assertEqual(self.ledger.get(opened["windowId"])["state"], L.CLOSED)

    def test_a_window_whose_recorded_drawings_are_gone_must_be_reselected(self) -> None:
        opened = self.open_ready()
        self.platform.procs[opened["pid"]]["registered"] = False
        self.refused("CAD_WINDOW_RESELECT_REQUIRED", self.guard.call, "manage_layers", ops("list"))

    # ----- ownership ---------------------------------------------------------------------------------------------
    def test_an_owner_window_is_read_only(self) -> None:
        pid, app = self.owner_window()
        selected = self.guard.select(pid=pid)
        self.assertTrue(selected["readOnly"])
        self.guard.call("manage_layers", ops("list"))
        for tool, arguments in [("draw_entities", {"entities": "x"}), ("manage_layers", ops("create", name="A")), ("manage_session", ops("undo")),
                                ("manage_session", ops("zoom_extents")), ("manage_entities", ops("select")), ("manage_files", ops("new")),
                                ("manage_files", ops("save", filename="x.dwg")), ("manage_files", ops("switch", drawing_name="plan.dwg"))]:
            with self.subTest(tool=tool, arguments=arguments):
                self.refused("CAD_DRAWING_READ_ONLY", self.guard.call, tool, arguments)
        self.assertEqual((app.ActiveDocument.dbmod, app.ActiveDocument.Saved), (0, True))

    def test_an_untitled_owner_window_cannot_be_selected_and_an_orphan_is_never_touched(self) -> None:
        untitled = self.platform.add_process(43, birth=9, title="ZWCAD 2025 Professional Edition - [Drawing1.dwg]")
        untitled.add("Drawing1.dwg")
        self.platform.add_process(41640, birth=3, command='"E:\\ZWCAD\\ZWCAD.exe" /Automation -Embedding')
        self.refused("CAD_WINDOW_NOT_SELECTABLE", self.guard.select, pid=43)
        self.refused("CAD_WINDOW_NOT_SELECTABLE", self.guard.select, pid=41640)
        listed = {w["pid"]: w for w in self.guard.list()["windows"]}
        self.assertEqual(listed[41640]["kind"], "orphan-candidate")
        self.assertFalse(listed[43]["selectable"])
        self.assertNotIn("resolve:41640", self.platform.calls)

    def test_a_system_window_holding_an_owner_drawing_turns_read_only(self) -> None:
        opened = self.open_ready()
        app = self.app(opened)
        owner_doc = app.add("plan.dwg", OWNER_PATH, activate=False)  # the owner opened their file into the system window
        for tool, arguments in [("draw_entities", {"entities": "x"}), ("manage_session", ops("undo")), ("manage_files", ops("new")),
                                ("manage_files", ops("switch", drawing_name="plan.dwg")), ("manage_entities", ops("select"))]:
            with self.subTest(tool=tool):
                self.refused("CAD_WINDOW_HOLDS_OWNER_DRAWING", self.guard.call, tool, arguments)
        self.guard.call("manage_layers", ops("list"))
        owner_doc.Close(False)  # once the owner's drawing is gone the window is writable again
        self.guard.call("draw_entities", {"entities": "x"})

    def test_an_untitled_owner_drawing_is_never_mistaken_for_the_systems_untitled_drawing(self) -> None:
        opened = self.open_ready()
        self.guard.call("manage_files", ops("new"))  # the system's untitled Drawing2.dwg
        app = self.app(opened)
        owner_doc = app.add("Drawing3.dwg", saved=False, dbmod=1)  # the owner pressed Ctrl+N in the system window
        self.refused("CAD_WINDOW_HOLDS_OWNER_DRAWING", self.guard.call, "draw_entities", {"entities": "x"})
        result = self.guard.release(window_id=opened["windowId"])
        self.assertEqual(result["windows"][0]["code"], "CAD_WINDOW_FOREIGN_DOCUMENT")
        self.assertEqual((owner_doc.closed, owner_doc.Saved, owner_doc.FullName), (False, False, ""))
        self.assertFalse(app.quit)

    def test_new_and_switch_work_on_system_drawings_and_new_drawings_are_attributed_by_object(self) -> None:
        opened = self.open_ready()
        self.guard.call("manage_files", ops("new"))
        record = self.ledger.get(opened["windowId"])
        self.assertEqual([(d["name"], d["origin"]) for d in record["drawings"]][-1], ("Drawing2.dwg", "new"))
        self.guard.call("draw_entities", {"entities": "x"})
        sentinel = os.path.basename(record["sentinel"])
        self.guard.call("manage_files", ops("switch", drawing_name=sentinel))
        self.assertEqual(self.app(opened).ActiveDocument.Name, sentinel)

    def test_file_actions_must_each_be_alone(self) -> None:
        self.open_ready()
        for actions in [("save", "new"), ("new", "save"), ("new", "switch"), ("switch", "list"), ("save", "list"), ("new", "list")]:
            with self.subTest(actions=actions):
                self.refused("CAD_FILE_ACTION_ALONE", self.guard.call, "manage_files", op_list(*[{"action": a, "filename": "x.dwg", "drawing_name": "y"} for a in actions]))
        self.assertEqual(self.stock.ran, [])

    def test_saves_go_only_to_new_files_in_the_sandbox_and_follow_the_rename(self) -> None:
        opened = self.open_ready()
        self.refused("CAD_SAVE_TARGET_REFUSED", self.guard.call, "manage_files", ops("save", filename="first.dwg"))  # sentinel is pinned
        self.guard.call("manage_files", ops("new"))
        drawings = os.path.join(self.sandbox, "drawings")
        os.makedirs(drawings)
        with open(os.path.join(drawings, "taken.dwg"), "wb"):
            pass
        taken = os.path.join(drawings, "taken.dwg")
        for spec in [{"filename": "taken.dwg"}, {"filepath": "out/taken.dwg/."}, {"filepath": "out\\taken.dwg\\"}, {"filename": "..\\..\\escape.dwg"},
                     {"filename": "../escape.dwg"}, {"filepath": "C:taken.dwg"}, {"filename": taken}, {"filename": os.path.join(self.root, "elsewhere.dwg")}]:
            with self.subTest(spec=spec):
                self.refused("CAD_SAVE_TARGET_REFUSED", self.guard.call, "manage_files", op_list({"action": "save", **spec}))
        self.guard.call("manage_files", ops("save", filename="result.dwg"))
        record = self.ledger.get(opened["windowId"])
        saved = [d for d in record["drawings"] if d["name"] == "result.dwg"]
        self.assertEqual(len(saved), 1)
        self.assertTrue(saved[0]["fullName"].endswith(ntpath.join("drawings", "result.dwg")))
        self.guard.call("draw_entities", {"entities": "x"})  # the renamed drawing is still the system's

    def test_save_target_matches_stocks_name_rules(self) -> None:
        drawings = os.path.join(self.sandbox, "drawings")
        cases = {("filepath", "out/result.dwg/."): "result.dwg", ("filepath", "C:\\x\\y.dwg"): "y.dwg", ("filename", "plain"): "plain.dwg",
                 ("filename", "sub/a.dwg"): "sub\\a.dwg", ("filename", "sub\\b.dwg"): "sub\\b.dwg", ("filepath", "C:rel.dwg"): "rel.dwg"}
        for (key, value), expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(norm(self.guard.save_target({"action": "save", key: value}, "active.dwg")), norm(ntpath.join(drawings, expected)))
        self.assertEqual(norm(self.guard.save_target({"action": "save"}, "active.dwg")), norm(ntpath.join(drawings, "active.dwg")))
        self.assertIsNone(self.guard.save_target({"action": "save", "filename": "..\\..\\x.dwg"}, "a.dwg"))

    def test_an_excel_export_never_overwrites_and_never_leaves_the_sandbox(self) -> None:
        self.open_ready()
        os.makedirs(os.path.join(self.sandbox, "sheets"))
        with open(os.path.join(self.sandbox, "sheets", "taken.xlsx"), "wb"):
            pass
        for filename in ["taken.xlsx", "..\\x.xlsx", "drawings/w.dwg", "C:x.xlsx", "x.dwg", " .xlsx."]:
            with self.subTest(filename=filename):
                self.refused("CAD_SAVE_TARGET_REFUSED", self.guard.call, "export_data", {"format": "excel", "filename": filename})
        self.guard.call("export_data", {"format": "excel", "filename": "fresh.xlsx"})
        self.assertEqual(self.guard.excel_targets({"format": "excel"}, "w0001.dwg")[1], os.path.join(self.sandbox, "sheets", "w0001_data.xlsx"))

    def test_writes_wait_for_a_running_command_to_finish(self) -> None:
        opened = self.open_ready()
        self.app(opened).cmdactive = 1
        self.refused("CAD_WINDOW_COMMAND_ACTIVE", self.guard.call, "draw_entities", {"entities": "x"})
        self.guard.call("manage_layers", ops("list"))

    def test_an_owner_drawing_changed_by_a_call_is_returned_and_kept_across_reselection(self) -> None:
        pid, app = self.owner_window()
        self.guard.select(pid=pid)
        original = self.stock.run

        def leaky(tool, arguments, application):
            application.ActiveDocument.edit()
            return original(tool, arguments, application)

        self.stock.run = leaky
        self.guard.call("manage_layers", ops("list"))
        self.assertEqual([i["kind"] for i in self.guard.last_incidents], ["ownerDrawingChanged"])
        self.stock.run = original
        self.guard.select(pid=pid)
        self.assertEqual([i["kind"] for i in self.guard.report()["incidents"]], ["ownerDrawingChanged"])

    # ----- other sessions ----------------------------------------------------------------------------------------
    def test_another_session_writes_or_releases_only_with_the_release_token(self) -> None:
        opened = self.open_ready()
        other = self.make_guard("codex")
        self.assertTrue(other.select(window_id=opened["windowId"])["readOnly"])
        other.call("manage_layers", ops("list"))
        self.refused("CAD_WINDOW_NOT_OWNER", other.call, "draw_entities", {"entities": "x"})
        self.assertEqual(other.release(window_id=opened["windowId"])["windows"][0]["code"], "CAD_WINDOW_NOT_OWNER")
        self.refused("CAD_WINDOW_NOT_OWNER", other.release, tag="goal-1")
        self.refused("CAD_WINDOW_NOT_OWNER", other.select, window_id=opened["windowId"], token="forged")
        self.assertFalse(other.select(window_id=opened["windowId"], token=opened["releaseToken"])["readOnly"])
        other.call("draw_entities", {"entities": "x"})
        self.assertTrue(self.make_guard("third").release(window_id=opened["windowId"], token=opened["releaseToken"])["success"])

    def test_a_window_idle_for_thirty_minutes_can_be_released_by_anyone(self) -> None:
        opened = self.open_ready()
        self.clock.now += FOREIGN_IDLE_SECONDS + 1
        self.assertTrue(self.make_guard("codex").release(window_id=opened["windowId"])["success"])

    def test_release_by_tag_closes_only_this_sessions_windows_for_that_tag(self) -> None:
        mine = self.open_ready()
        other = self.make_guard("codex")
        theirs = self.open_ready(other)
        self.guard.release(tag="goal-1")
        self.assertTrue(self.app(mine).quit)
        self.assertFalse(self.app(theirs).quit)

    # ----- release ---------------------------------------------------------------------------------------------
    def test_release_saves_dirty_system_drawings_as_new_dwgs_in_the_sandbox_closes_them_and_quits(self) -> None:
        opened = self.open_ready()
        app = self.app(opened)
        self.guard.call("draw_entities", {"entities": "x"})
        self.guard.call("manage_files", ops("new"))
        self.guard.call("draw_entities", {"entities": "x"})
        sentinel_doc, new_doc = app.docs
        result = self.guard.release(window_id=opened["windowId"])
        self.assertTrue(result["success"], result)
        self.assertTrue(app.quit)
        self.assertTrue(new_doc.closed)
        self.assertFalse(sentinel_doc.closed)  # the starting drawing goes last and is closed by Quit
        drawings = os.path.join(self.sandbox, "drawings")
        for doc in (sentinel_doc, new_doc):
            self.assertTrue(doc.FullName.startswith(drawings) and doc.FullName.endswith(".dwg"), doc.FullName)
            with open(doc.FullName, "rb") as saved:
                self.assertEqual(saved.read(4), b"AC10")
        self.assertEqual(self.platform.save_types, [64, 64])
        self.assertEqual(result["windows"][0]["savedAs"], [new_doc.FullName, sentinel_doc.FullName])
        self.assertEqual(self.guard.status(opened["windowId"])["state"], L.CLOSED)
        self.assertIsNone(self.guard.selection)
        snapshot = self.ledger.get(opened["windowId"])["closeSnapshot"]["drawings"]
        self.assertEqual([d["entities"] for d in snapshot], [1, 1])

    def test_release_activates_each_drawing_before_saving_it(self) -> None:
        opened = self.open_ready()
        self.guard.call("manage_files", ops("new"))
        self.guard.call("draw_entities", {"entities": "x"})
        self.guard.call("manage_files", ops("new"))  # Drawing3 is active; Drawing2 must be activated to be saved
        app = self.app(opened)
        result = self.guard.release(window_id=opened["windowId"])
        self.assertTrue(result["success"], result)
        self.assertEqual(len(result["windows"][0]["savedAs"]), 3)
        self.assertTrue(all(doc.FullName.startswith(os.path.join(self.sandbox, "drawings")) for doc in app.docs))

    def test_a_save_that_leaves_no_file_on_disk_never_closes_the_drawing(self) -> None:
        opened = self.open_ready()
        self.guard.call("draw_entities", {"entities": "x"})
        doc = self.app(opened).docs[0]
        doc.writes_files = False  # ZWCAD renamed the drawing but nothing reached the disk
        result = self.guard.release(window_id=opened["windowId"])
        self.assertEqual(result["windows"][0]["code"], "CAD_WINDOW_FOREIGN_DOCUMENT")
        self.assertFalse(doc.closed)
        self.assertFalse(self.app(opened).quit)

    def test_release_saves_every_system_drawing_even_when_zwcad_calls_it_saved(self) -> None:
        opened = self.open_ready()
        self.guard.call("draw_entities", {"entities": "x"})
        self.guard.call("manage_files", ops("new"))  # the edited starting drawing is now inactive: ZWCAD reports it clean
        app = self.app(opened)
        sentinel_doc = app.docs[0]
        self.assertTrue(sentinel_doc.Saved)
        self.assertEqual(sentinel_doc.GetVariable("DBMOD"), 0)
        result = self.guard.release(window_id=opened["windowId"])
        self.assertTrue(result["success"], result)
        self.assertTrue(sentinel_doc.FullName.startswith(os.path.join(self.sandbox, "drawings")))
        self.assertEqual(sentinel_doc.dbmod, 0)

    def test_a_drawing_edited_while_closing_is_never_closed(self) -> None:
        opened = self.open_ready()
        self.guard.call("manage_files", ops("new"))
        self.guard.call("draw_entities", {"entities": "x"})  # saved into the sandbox at release, then kept open until Quit
        app = self.app(opened)
        sentinel_doc, new_doc = app.docs
        original_close = sentinel_doc.Close

        def close_after_owner_typed(save):
            new_doc.edit()  # the owner draws in the other drawing while the guard is closing
            original_close(save)

        original_save = new_doc.SaveAs

        def save_then_owner_types(path, file_type=None):
            original_save(path, file_type)
            new_doc.edit()  # the owner draws in it right after the guard saved it

        new_doc.SaveAs = save_then_owner_types
        result = self.guard.release(window_id=opened["windowId"])
        self.assertEqual(result["windows"][0]["code"], "CAD_WINDOW_FOREIGN_DOCUMENT")
        self.assertFalse(new_doc.closed)
        self.assertFalse(app.quit)

    def test_a_drawing_that_appears_while_closing_stops_quit(self) -> None:
        opened = self.open_ready()
        app = self.app(opened)
        sentinel_doc = app.docs[0]
        real_quit = app.Quit
        original_save = sentinel_doc.SaveAs

        def save_then_owner_opens_a_file(path, file_type=None):
            original_save(path, file_type)
            app.add("plan.dwg", OWNER_PATH, activate=False)  # Explorer routes a double-clicked drawing into it

        sentinel_doc.SaveAs = save_then_owner_opens_a_file
        result = self.guard.release(window_id=opened["windowId"])
        self.assertEqual(result["windows"][0]["code"], "CAD_WINDOW_FOREIGN_DOCUMENT")
        self.assertFalse(app.quit)
        self.assertIs(app.Quit.__func__, real_quit.__func__)

    def test_a_window_used_while_a_sweep_waited_is_not_swept(self) -> None:
        opened = self.open_ready()
        self.clock.now += IDLE_RELEASE_SECONDS + 1
        stale = self.ledger.get(opened["windowId"])
        self.ledger.update(lambda windows: windows[opened["windowId"]].update(lastActivity=self.clock.now))
        with self.assertRaises(GuardRefusal):
            self.guard._release_one(stale, authorized=True, idle_at_least=IDLE_RELEASE_SECONDS)
        self.assertFalse(self.app(opened).quit)

    def test_a_document_list_shorter_than_zwcads_count_closes_nothing(self) -> None:
        opened = self.open_ready()
        app = self.app(opened)
        real = type(app).Documents
        type(app).Documents = property(lambda self: type(real.fget(self))([]) if False else _Short(real.fget(self)))
        try:
            result = self.guard.release(window_id=opened["windowId"])
        finally:
            type(app).Documents = real
        self.assertEqual(result["windows"][0]["code"], "CAD_GUARD_INTERNAL")
        self.assertFalse(app.quit)

    def test_release_hands_a_window_with_an_owner_drawing_over_instead_of_closing_it(self) -> None:
        opened = self.open_ready()
        app = self.app(opened)
        owner_doc = app.add("plan.dwg", OWNER_PATH, saved=False, dbmod=1)
        result = self.guard.release(window_id=opened["windowId"])
        self.assertFalse(result["success"])
        self.assertEqual(result["windows"][0]["code"], "CAD_WINDOW_FOREIGN_DOCUMENT")
        self.assertFalse(app.quit)
        self.assertFalse(owner_doc.closed)
        self.assertEqual((owner_doc.Saved, owner_doc.dbmod), (False, 1))
        self.assertEqual(self.ledger.get(opened["windowId"])["state"], L.HANDED_OVER)
        owner_doc.Close(False)  # the owner deals with it; a later release finishes the job
        self.assertTrue(self.guard.release(window_id=opened["windowId"])["success"])
        self.assertTrue(app.quit)

    def test_a_drawing_that_does_not_save_hands_the_window_over_and_is_never_closed(self) -> None:
        opened = self.open_ready()
        self.guard.call("draw_entities", {"entities": "x"})
        doc = self.app(opened).docs[0]
        doc.stuck_dirty = True
        result = self.guard.release(window_id=opened["windowId"])
        self.assertEqual(result["windows"][0]["code"], "CAD_WINDOW_FOREIGN_DOCUMENT")
        self.assertFalse(doc.closed)
        self.assertFalse(self.app(opened).quit)
        record = self.ledger.get(opened["windowId"])
        self.assertEqual(record["state"], L.HANDED_OVER)
        self.assertTrue(self.guard.owned(record, {"name": doc.Name, "fullName": doc.FullName}))  # the rename was recorded first

    def test_release_waits_for_dialogs_disabled_windows_and_running_commands(self) -> None:
        opened = self.open_ready()
        proc = self.platform.procs[opened["pid"]]
        proc["dialogs"] = ["Save changes?"]
        self.assertEqual(self.guard.release(window_id=opened["windowId"])["windows"][0]["code"], "CAD_WINDOW_DIALOG_OPEN")
        proc["dialogs"] = []
        proc["enabled"] = False
        self.assertEqual(self.guard.release(window_id=opened["windowId"])["windows"][0]["code"], "CAD_WINDOW_BLOCKED")
        proc["enabled"] = True
        proc["app"].cmdactive = 1
        self.assertEqual(self.guard.release(window_id=opened["windowId"])["windows"][0]["code"], "CAD_WINDOW_COMMAND_ACTIVE")
        self.assertFalse(proc["app"].quit)

    def test_a_window_still_starting_is_not_released_and_never_killed(self) -> None:
        opened = self.guard.open()
        self.assertEqual(self.guard.release(window_id=opened["windowId"])["windows"][0]["code"], "CAD_WINDOW_NOT_READY")
        self.assertIn(opened["windowId"], [w["windowId"] for w in self.guard.report()["systemWindowsNeedingAttention"]])

    def test_a_release_that_did_not_end_zwcad_is_retried_and_reported(self) -> None:
        opened = self.open_ready()
        app = self.app(opened)
        app.Quit = lambda: None  # ZWCAD ignored Quit this time
        self.guard.release(window_id=opened["windowId"])
        self.clock.now += QUIT_WAIT_SECONDS + 1
        self.assertTrue(self.guard.status(opened["windowId"])["quitPending"])
        self.assertEqual(len(app.docs), 1)  # one saved drawing stays open, so the window is still reachable
        del app.Quit
        self.assertTrue(self.guard.release(window_id=opened["windowId"])["success"])
        self.assertTrue(app.quit)

    def test_releasing_an_owner_window_only_deselects_it(self) -> None:
        pid, app = self.owner_window()
        window_id = self.guard.select(pid=pid)["selected"]
        self.assertEqual(self.guard.release(window_id=window_id)["state"], "deselected")
        self.assertFalse(app.quit)
        self.assertIsNone(self.guard.selection)

    def test_the_sweep_releases_windows_idle_for_two_hours_and_survives_a_broken_one(self) -> None:
        broken = self.open_ready()
        opened = self.open_ready()
        self.assertEqual(self.guard.sweep(), [])
        self.clock.now += IDLE_RELEASE_SECONDS + 1
        self.platform.procs[broken["pid"]]["app"].cmdactive = "garbage"  # int("garbage") raises inside the sweep
        released = {r["windowId"]: r for r in self.guard.sweep()}
        self.assertEqual(released[broken["windowId"]]["code"], "CAD_GUARD_INTERNAL")
        self.assertTrue(released[opened["windowId"]]["success"])
        self.assertTrue(self.app(opened).quit)
        self.assertEqual([i["kind"] for i in self.ledger.get(broken["windowId"])["incidents"]], ["sweepFailed"])

    # ----- report ----------------------------------------------------------------------------------------------
    def test_report_names_every_window_no_record_explains(self) -> None:
        self.platform.add_process(41640, birth=3, command='"E:\\ZWCAD\\ZWCAD.exe" /Automation -Embedding')
        self.platform.add_process(61, birth=3, command=r'"E:\ZWCAD\ZWCAD.exe" "C:\Users\u\AppData\Local\gotzji\cad-sessions\operation-1\working.dwg" /B "x.scr"')
        self.platform.add_process(62, birth=3, command=f'"E:\\ZWCAD\\ZWCAD.exe" "{os.path.join(self.sandbox, "windows", "wlost", "wlost.dwg")}"')
        hidden = self.platform.add_process(41641, birth=3, command=r'"E:\ZWCAD\ZWCAD.exe" /Automation -Embedding',
                                           title=f"ZWCAD 2025 Professional Edition - [{OWNER_PATH}]", visible=False)
        hidden.add("plan.dwg", OWNER_PATH)
        report = self.guard.report()
        kinds = {u["pid"]: u["kind"] for u in report["unknown"]}
        self.assertEqual(kinds, {41640: "orphan-candidate", 41641: "orphan-candidate", 61: "foreign-system", 62: "untracked-system"})
        self.assertEqual({u["pid"]: u["activeDrawing"] for u in report["unknown"]}[41641], OWNER_PATH)
        self.assertNotIn("resolve:41641", self.platform.calls)
        self.refused("CAD_WINDOW_NOT_SELECTABLE", self.guard.select, pid=61)

    def test_report_names_updaters_left_behind_by_system_windows_only(self) -> None:
        opened = self.open_ready()
        self.platform.helper_rows = [{"pid": 900, "name": "ZwUpdHost.exe", "parentPid": opened["pid"]},
                                     {"pid": 901, "name": "ZwUpdHost.exe", "parentPid": 41640}]
        self.assertEqual([h["pid"] for h in self.guard.report()["leftoverHelpers"]], [900])


if __name__ == "__main__":
    unittest.main()
