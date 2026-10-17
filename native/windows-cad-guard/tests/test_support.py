"""Ledger, install fingerprints, the one-shot CLI contract and the CAD thread; all with fakes, on any OS."""
import asyncio
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cadguard import cli, runtime  # noqa: E402
from cadguard.errors import GuardRefusal  # noqa: E402
from cadguard.ledger import Ledger  # noqa: E402
from cadguard.policy import KNOWN, classify  # noqa: E402

try:
    import fastmcp  # noqa: F401
    HAVE_FASTMCP = True
except ImportError:
    HAVE_FASTMCP = False


class Temp(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="cadguard-support-")

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


class PolicyTest(unittest.TestCase):
    def test_file_actions_never_share_a_call_with_any_other_action(self) -> None:
        for first in sorted(KNOWN["manage_files"] - {"close"}):
            for second in sorted(KNOWN["manage_files"] - {"close"}):
                plan = classify("manage_files", [first, second], {})
                if {first, second} & {"new", "switch", "save"}:
                    self.assertEqual(plan.reason, "CAD_FILE_ACTION_ALONE", (first, second))
                else:
                    self.assertFalse(plan.refused, (first, second))

    def test_every_class_of_a_mixed_call_is_kept(self) -> None:
        plan = classify("manage_layers", ["list", "delete"], {})
        self.assertTrue(plan.writes)
        self.assertEqual(plan.kinds, frozenset({"read", "write"}))


class LedgerTest(Temp):
    def ledger(self) -> Ledger:
        lock = threading.Lock()

        @contextmanager
        def held():
            with lock:
                yield

        return Ledger(os.path.join(self.root, "ledger.json"), held)

    def test_a_corrupt_or_foreign_ledger_is_a_typed_refusal_and_is_left_untouched(self) -> None:
        for content in ["{not json", json.dumps({"version": 2, "windows": {}}), json.dumps([1, 2]), "\udcff"]:
            with self.subTest(content=content[:12]):
                with open(os.path.join(self.root, "ledger.json"), "w", encoding="utf-8", errors="surrogateescape") as out:
                    out.write(content)
                with self.assertRaises(GuardRefusal) as caught:
                    self.ledger().snapshot()
                self.assertEqual(caught.exception.code, "CAD_GUARD_LEDGER_INVALID")
                with self.assertRaises(GuardRefusal):
                    self.ledger().put({"windowId": "w1"})
                with open(os.path.join(self.root, "ledger.json"), encoding="utf-8", errors="surrogateescape") as handle:
                    self.assertEqual(handle.read(), content)

    def test_a_failed_write_keeps_the_old_file_and_leaves_no_temporary(self) -> None:
        ledger = self.ledger()
        ledger.put({"windowId": "w1", "state": "ready"})

        def explode(windows: dict) -> None:
            windows["w2"] = {"windowId": "w2", "bad": object()}

        with self.assertRaises(TypeError):
            ledger.update(explode)
        self.assertEqual(list(ledger.snapshot()), ["w1"])
        self.assertEqual(sorted(os.listdir(self.root)), ["ledger.json"])


class ManifestTest(Temp):
    def write(self, files: dict, manifest: object) -> None:
        for name, data in files.items():
            with open(os.path.join(self.root, name), "wb") as out:
                out.write(data)
        with open(os.path.join(self.root, "manifest.json"), "w", encoding="utf-8") as out:
            out.write(manifest if isinstance(manifest, str) else json.dumps(manifest))

    def test_changed_missing_or_unreadable_install_files_refuse_to_start(self) -> None:
        good = {"files": {"a.py": hashlib.sha256(b"a").hexdigest()}, "stock": {"src": "s", "files": {}}, "zwcad": {"path": "z", "sha256": "0" * 64}}
        self.write({"a.py": b"a"}, good)
        self.assertEqual(runtime.read_manifest(self.root)["files"], good["files"])
        for files, manifest in [({"a.py": b"changed"}, good), ({}, {**good, "files": {"missing.py": "0" * 64}}), ({}, "{broken"), ({}, {"nofiles": 1}),
                                ({"a.py": b"a"}, {**good, "zwcad": {"path": 3}})]:
            with self.subTest(manifest=str(manifest)[:30]):
                shutil.rmtree(self.root)
                os.makedirs(self.root)
                self.write(files, manifest)
                with self.assertRaises(GuardRefusal) as caught:
                    runtime.read_manifest(self.root)
                self.assertEqual(caught.exception.code, "CAD_GUARD_INTEGRITY")

    def test_the_stock_config_is_written_atomically_and_only_when_it_changes(self) -> None:
        path = os.path.join(self.root, "config.json")
        runtime.write_if_changed(path, "one")
        before = os.stat(path).st_mtime_ns
        runtime.write_if_changed(path, "one")
        self.assertEqual(os.stat(path).st_mtime_ns, before)
        runtime.write_if_changed(path, "two")
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "two")
        self.assertEqual(os.listdir(self.root), ["config.json"])


class FakeGuard:
    def __init__(self) -> None:
        self.selection = None
        self.tokens: dict = {}
        self.last_incidents: list = []
        self.opened_with = None

    def sweep(self) -> list:
        raise RuntimeError("an idle window misbehaved")

    def open(self, tag=None, select=True):
        self.opened_with = select
        return {"windowId": "w1", "releaseToken": "t"}

    def call(self, tool, arguments):
        if tool == "boom":
            raise KeyError("internal")
        self.last_incidents = [{"kind": "ownerDrawingChanged"}]
        return "{}"

    def status(self, window_id, wait):
        return {"windowId": window_id, "wait": wait}


class CliTest(unittest.TestCase):
    def run_cli(self, request: object, build=lambda opener: FakeGuard()) -> dict:
        raw = request if isinstance(request, bytes) else json.dumps(request).encode()
        output = cli.run(raw, build)
        json.dumps(output)  # always serialisable into the one output line
        return output

    def test_every_failure_is_one_coded_object(self) -> None:
        cases = [
            (b"{", "CAD_INPUT_UNREADABLE"),
            (b"\xff", "CAD_INPUT_UNREADABLE"),
            ({"action": "list"}, "CAD_INPUT_UNREADABLE"),
            ({"action": "status", "opener": "g", "windowId": "w1", "waitSeconds": "x"}, "CAD_INPUT_UNREADABLE"),
            ({"action": "call", "opener": "g", "tool": "draw_entities", "arguments": {}}, "CAD_WINDOW_NOT_SELECTED"),
            ({"action": "call", "opener": "g", "windowId": ["w"], "tool": "x", "arguments": {}}, "CAD_WINDOW_NOT_SELECTED"),
            ({"action": "call", "opener": "g", "windowId": "w1", "tool": "boom", "arguments": {}}, "CAD_GUARD_INTERNAL"),
            ({"action": "teleport", "opener": "g"}, "CAD_INPUT_UNREADABLE"),
        ]
        for request, code in cases:
            with self.subTest(request=request):
                output = self.run_cli(request)
                self.assertFalse(output["ok"])
                self.assertEqual(output["error"]["code"], code)

    def test_a_guard_that_cannot_start_is_reported_not_raised(self) -> None:
        def broken(opener):
            raise GuardRefusal("CAD_GUARD_LEDGER_INVALID", "JSONDecodeError")

        self.assertEqual(self.run_cli({"action": "list", "opener": "g"}, broken)["error"]["code"], "CAD_GUARD_LEDGER_INVALID")

        def crashing(opener):
            raise OSError("access denied")

        self.assertEqual(self.run_cli({"action": "list", "opener": "g"}, crashing)["error"]["code"], "CAD_GUARD_INTERNAL")

    def test_open_never_selects_and_call_names_its_window_and_token(self) -> None:
        guard = FakeGuard()
        self.assertTrue(self.run_cli({"action": "open", "opener": "g"}, lambda opener: guard)["ok"])
        self.assertFalse(guard.opened_with)
        output = self.run_cli({"action": "call", "opener": "g", "windowId": "w1", "releaseToken": "t", "tool": "draw_entities", "arguments": {}}, lambda opener: guard)
        self.assertEqual((guard.selection, guard.tokens), ("w1", {"w1": "t"}))
        self.assertEqual(output["incidents"], [{"kind": "ownerDrawingChanged"}])


@unittest.skipUnless(HAVE_FASTMCP, "needs fastmcp (installed in the stock multiCAD venv and in CI)")
class CadThreadTest(unittest.TestCase):
    def test_an_overrun_call_keeps_the_thread_and_refuses_new_calls_until_it_ends(self) -> None:
        from fastmcp.exceptions import ToolError
        from cadguard.server import CadThread

        release = threading.Event()
        names = []

        async def scenario() -> None:
            thread = CadThread()
            with self.assertRaises(GuardRefusal) as overrun:
                await thread.run(lambda: (names.append(threading.current_thread().name), release.wait(5)), timeout=0.2)
            self.assertEqual(overrun.exception.code, "CAD_WINDOW_CALL_TIMEOUT")
            with self.assertRaises(GuardRefusal) as busy:
                await thread.run(lambda: names.append("never"), timeout=1)
            self.assertEqual(busy.exception.code, "CAD_GUARD_BUSY")
            release.set()
            await asyncio.sleep(0.2)
            self.assertEqual(await thread.run(lambda: threading.current_thread().name, timeout=1), names[0])
            with self.assertRaises(ToolError) as refused:
                await thread.run(lambda: (_ for _ in ()).throw(GuardRefusal("CAD_WINDOW_GONE", "w1")), timeout=1)
            self.assertEqual(json.loads(str(refused.exception))["code"], "CAD_WINDOW_GONE")
            with self.assertRaises(ToolError) as internal:
                await thread.run(lambda: {}["missing"], timeout=1)
            self.assertEqual(json.loads(str(internal.exception))["code"], "CAD_GUARD_INTERNAL")
            thread.executor.shutdown()

        asyncio.run(scenario())
        self.assertNotIn("never", names)


if __name__ == "__main__":
    unittest.main()
