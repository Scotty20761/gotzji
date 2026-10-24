import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("desktop_session", Path(__file__).parents[1] / "src" / "desktop_session.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class FakePortal:
    def __init__(self, remote=True):
        self.remote = remote
        self.closed = False
        self.source_type = 1
        self.stream = 42
        self.keys = set()
        self.buttons = set()
        self.properties = {"logical_size": (100, 100)}
        self.events = []

    def key(self, key, pressed):
        self.events.append((key, pressed))
        (self.keys.add if pressed else self.keys.discard)(key)

    def button(self, button, pressed):
        self.events.append((button, pressed))
        (self.buttons.add if pressed else self.buttons.discard)(button)

    def notify(self, method, signature, values):
        self.events.append((method, signature, values))

    def close(self):
        self.closed = True
        self.keys.clear()
        self.buttons.clear()


class DesktopSessionTests(unittest.TestCase):
    def assert_code(self, code, callback):
        with self.assertRaises(native.Failure) as result:
            callback()
        self.assertEqual(result.exception.code, code)

    def test_duration_and_size_inputs_fail_before_a_capture_or_file_write(self):
        for value in ("nan", "inf", "-1", "601"):
            self.assert_code("INVALID_INPUT", lambda: native.bounds(value, 60, 0.1, 600))
        self.assertEqual(native.bounds(None, 60, 0.1, 600), 60)
        self.assertEqual(native.bounds("600", 60, 0.1, 600), 600)
        self.assert_code("INVALID_INPUT", lambda: native.integer("1024.5", 1024, 1024, native.MAX_MEDIA_BYTES))

    def test_absent_dependency_does_not_erase_the_implemented_action_manifest(self):
        status = native.unavailable_status("audio")
        self.assertFalse(status["ready"])
        self.assertEqual(status["reason"], "dependency_missing")
        self.assertEqual(status["supportedActions"], ["status", "record", "play", "stop"])

    def test_unknown_key_and_button_fail_without_requesting_consent(self):
        sessions = native.DesktopSessions()
        self.assert_code("INVALID_INPUT", lambda: sessions.control("press_key", {"key": "unknown-key"}))
        self.assert_code("INVALID_INPUT", lambda: sessions.control("click", {"x": "0", "y": "0", "button": "999"}))
        self.assertEqual(sessions.portals, {})

    def test_requested_screen_region_and_fps_are_preserved_or_refused_explicitly(self):
        settings = native.video_settings({"width": "640", "height": "480", "offset_x": "10", "offset_y": "20", "fps": "30"})
        self.assertEqual(settings["source"], {"startx": 10, "starty": 20, "endx": 649, "endy": 499})
        self.assertEqual((settings["width"], settings["height"], settings["fps"]), (640, 480, 30))
        self.assert_code("INVALID_INPUT", lambda: native.video_settings({"width": "641", "height": "480"}))
        self.assert_code("INVALID_INPUT", lambda: native.video_settings({"width": "640"}))
        portal = FakePortal(False)
        portal.properties.update({"size": (100, 100), "position": (-100, 0)})
        self.assertEqual(native.video_settings({"width": "20", "height": "40", "offset_x": "-80", "offset_y": "10"}, portal)["crop"], (0.2, 0.1, 0.6, 0.5))
        self.assert_code("INVALID_INPUT", lambda: native.video_settings({"width": "120", "height": "40"}, portal))

    def test_wav_artifact_is_verified_and_existing_target_is_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            target = os.path.join(root, "ไทย.wav")
            destination, temporary = native.private_output({"output_path": target}, "wav")
            with wave.open(temporary, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(8000)
                output.writeframes(b"\0\0" * 800)
            artifact = native.publish_artifact(destination, temporary, "audio", 4096)
            self.assertTrue(artifact["verified"])
            self.assertAlmostEqual(artifact["duration_seconds"], 0.1)
            self.assertFalse(os.path.exists(temporary))
            original = Path(target).read_bytes()
            self.assert_code("CONFLICT", lambda: native.private_output({"output_path": target}, "wav"))
            self.assertEqual(Path(target).read_bytes(), original)

    def test_invalid_or_oversize_artifact_never_publishes_target(self):
        with tempfile.TemporaryDirectory() as root:
            target, temporary = native.private_output({"output_path": os.path.join(root, "capture.wav")}, "wav")
            Path(temporary).write_bytes(b"x" * 1025)
            self.assert_code("FILE_TOO_LARGE", lambda: native.publish_artifact(target, temporary, "audio", 1024))
            self.assertFalse(os.path.exists(target))
            self.assert_code("INVALID_INPUT", lambda: native.private_output({"output_path": "relative.wav"}, "wav"))

    def test_owned_helper_reuses_consent_and_rejects_an_unknown_session(self):
        sessions = native.DesktopSessions()
        portal = FakePortal()
        sessions.portals["owned"] = portal
        self.assertEqual(sessions.portal(True, {}), ("owned", portal))
        self.assert_code("FILE_NOT_FOUND", lambda: sessions.portal(True, {"session_id": "foreign"}))
        self.assertFalse(portal.closed)
        self.assertEqual(portal.events, [])

    def test_unicode_keys_round_trip_and_chord_releases_every_pressed_key(self):
        sessions = native.DesktopSessions()
        portal = FakePortal()
        sessions.portals["owned"] = portal
        receipt = sessions.control("type_text", {"text": " ไทย😀\n", "session_id": "owned"})
        self.assertEqual(receipt["permissionState"], "granted")
        self.assertEqual([event[0] for event in portal.events[::2]], [native.keysym(key) for key in " ไทย😀\n"])
        sessions.control("hotkey", {"keys": "ctrl,shift,a", "session_id": "owned"})
        self.assertFalse(portal.keys)

    def test_public_hotkey_and_nested_drag_parameters_reach_the_portal(self):
        sessions = native.DesktopSessions()
        portal = FakePortal()
        sessions.portals["owned"] = portal
        sessions.control("hotkey", {"key": "a", "modifiers": "ctrl,shift", "session_id": "owned"})
        self.assertEqual(portal.events[:3], [(native.keysym("ctrl"), True), (native.keysym("shift"), True), (native.keysym("a"), True)])
        portal.events.clear()
        sessions.control("drag", {"from.x": "10", "from.y": "20", "to.x": "30", "to.y": "40", "session_id": "owned"})
        self.assertEqual(portal.events[0][2], (42, 10, 20))
        self.assertEqual(portal.events[2][2], (42, 30, 40))
        self.assertFalse(portal.buttons)

    def test_outside_stream_coordinates_close_the_session_without_posting_input(self):
        sessions = native.DesktopSessions()
        portal = FakePortal()
        sessions.portals["owned"] = portal
        self.assert_code("INVALID_INPUT", lambda: sessions.control("click", {"x": "101", "y": "3", "session_id": "owned"}))
        self.assertTrue(portal.closed)
        self.assertEqual(portal.events, [])

    def test_stop_unknown_handle_does_not_stop_another_recording(self):
        sessions = native.DesktopSessions()
        class Recording:
            kind = "screen"
            stopped = False
            def stop(self, cancel=False):
                self.stopped = True
        recording = Recording()
        sessions.recordings["owned"] = recording
        self.assert_code("FILE_NOT_FOUND", lambda: sessions.media("screen_record", "stop", {"handle": "foreign"}))
        self.assertFalse(recording.stopped)
        self.assert_code("FILE_NOT_FOUND", lambda: sessions.media("audio", "stop", {"handle": "owned"}))
        self.assertFalse(recording.stopped)

    def test_release_closes_only_the_selected_owned_remote_session(self):
        sessions = native.DesktopSessions()
        first, second, capture = FakePortal(), FakePortal(), FakePortal(False)
        sessions.portals = {"first": first, "second": second, "capture": capture}
        self.assert_code("FILE_NOT_FOUND", lambda: sessions.control("release_all", {"session_id": "foreign"}))
        receipt = sessions.control("release_all", {"session_id": "first"})
        self.assertEqual(receipt["released_session_ids"], ["first"])
        self.assertEqual(receipt["scope"], "session")
        self.assertTrue(first.closed)
        self.assertFalse(second.closed)
        self.assertFalse(capture.closed)
        receipt = sessions.control("release_all", {})
        self.assertEqual(receipt["released_session_ids"], ["second"])
        self.assertEqual(receipt["scope"], "owner")
        self.assertFalse(capture.closed)
        self.assertEqual(sessions.control("release_all", {})["released_session_ids"], [])

    def test_capture_portal_has_explicit_stop_and_reports_revoked_status(self):
        sessions = native.DesktopSessions()
        portal = FakePortal(False)
        sessions.portals["capture"] = portal
        self.assertEqual(sessions.status("vision", {"session_id": "capture"})["permissionState"], "granted")
        portal.closed = True
        self.assertEqual(sessions.status("vision", {"session_id": "capture"})["permissionState"], "revoked")
        self.assertTrue(sessions.media("screen_record", "stop", {"session_id": "capture"})["closed"])

    def test_native_close_continues_after_one_cleanup_failure(self):
        sessions = native.DesktopSessions()
        class Broken:
            def close(self):
                raise RuntimeError("fixture cleanup failure")
        portal = FakePortal()
        sessions.portals = {"broken": Broken(), "healthy": portal}
        self.assertFalse(sessions.close())
        self.assertTrue(portal.closed)
        self.assertIn("broken", sessions.portals)
        self.assertNotIn("healthy", sessions.portals)
        self.assert_code("PROCESS_TIMEOUT", lambda: sessions.execute("host", "close", {}))

    def test_truncated_wav_with_a_valid_header_never_publishes(self):
        with tempfile.TemporaryDirectory() as root:
            target, temporary = native.private_output({"output_path": os.path.join(root, "short.wav")}, "wav")
            with wave.open(temporary, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(8000)
                output.writeframes(b"\0\0" * 800)
            content = Path(temporary).read_bytes()
            Path(temporary).write_bytes(content[:48])
            self.assert_code("INTERNAL_ERROR", lambda: native.publish_artifact(target, temporary, "audio", 4096))
            self.assertFalse(os.path.exists(target))

    def test_wrong_portal_kind_is_refused_without_status_or_close_receipt(self):
        sessions = native.DesktopSessions()
        remote, capture = FakePortal(), FakePortal(False)
        sessions.portals = {"remote": remote, "capture": capture}
        for operation, handle in (("input_event", "capture"), ("vision", "remote"), ("screen_record", "remote"), ("audio", "capture")):
            self.assert_code("FILE_NOT_FOUND", lambda: sessions.status(operation, {"session_id": handle}))
        self.assert_code("FILE_NOT_FOUND", lambda: sessions.control("release_all", {"session_id": "capture"}))
        self.assertFalse(remote.closed)
        self.assertFalse(capture.closed)

    def test_playback_enforces_the_caller_byte_limit_before_constructing_a_player(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "input.wav")
            Path(path).write_bytes(b"x" * 1025)
            sessions = native.DesktopSessions()
            with patch.object(native, "element") as make:
                self.assert_code("FILE_TOO_LARGE", lambda: sessions.media("audio", "play", {"file_path": path, "max_bytes": "1024"}))
                self.assert_code("INVALID_INPUT", lambda: sessions.media("audio", "play", {"file_path": path, "max_bytes": "1024.5"}))
                make.assert_not_called()

    def test_portal_release_failure_still_attempts_close_without_recursion(self):
        calls = []
        class Connection:
            def call_sync(self, destination, path, interface, method, *args):
                calls.append(method)
                if method.startswith("Notify"):
                    raise RuntimeError("fixture key release refused")
            def signal_unsubscribe(self, subscription):
                pass
        portal = native.PortalSession.__new__(native.PortalSession)
        portal.connection = Connection()
        portal.session = "/fixture/session"
        portal.remote = True
        portal.closed = False
        portal.keys = {42}
        portal.buttons = {272}
        portal.fd = None
        portal.subscription = None
        with patch.object(native, "Gio", SimpleNamespace(DBusCallFlags=SimpleNamespace(NONE=0))), patch.object(native, "GLib", SimpleNamespace(Variant=lambda *args: args)):
            portal.close()
        self.assertTrue(portal.closed)
        self.assertEqual(calls.count("Close"), 1)
        self.assertEqual(calls.count("NotifyKeyboardKeysym"), 1)
        self.assertEqual(calls.count("NotifyPointerButton"), 1)

    def test_failed_portal_close_retains_session_until_helper_termination(self):
        class Connection:
            def call_sync(self, *args):
                raise RuntimeError("fixture Close refused")
            def signal_unsubscribe(self, subscription):
                pass
        portal = native.PortalSession.__new__(native.PortalSession)
        portal.connection = Connection()
        portal.session = "/fixture/session"
        portal.remote = False
        portal.closed = False
        portal.keys = set()
        portal.buttons = set()
        portal.fd = None
        portal.subscription = None
        sessions = native.DesktopSessions()
        sessions.portals["capture"] = portal
        with patch.object(native, "Gio", SimpleNamespace(DBusCallFlags=SimpleNamespace(NONE=0))):
            self.assert_code("PROCESS_TIMEOUT", lambda: sessions.media("screen_record", "stop", {"session_id": "capture"}))
        self.assertFalse(portal.closed)
        self.assertIs(sessions.portals["capture"], portal)

    def test_media_cycles_remove_every_bus_watch_handler_and_timer(self):
        buses, timers, removed = [], set(), []
        class Bus:
            def __init__(self):
                self.watches = 0
                self.handlers = set()
                buses.append(self)
            def add_signal_watch(self):
                self.watches += 1
            def remove_signal_watch(self):
                self.watches -= 1
            def connect(self, name, callback):
                self.handlers.add(1)
                return 1
            def disconnect(self, handler):
                self.handlers.remove(handler)
        class Pipeline:
            def __init__(self, fail=False):
                self.bus = Bus()
                self.fail = fail
                self.state = None
            def get_bus(self):
                return self.bus
            def set_state(self, state):
                self.state = state
                return "failure" if self.fail and state == "playing" else "success"
            def get_state(self, timeout):
                return "success", self.state, None
        def timeout(*args):
            number = len(removed) + len(timers) + 1
            timers.add(number)
            return number
        def remove(number):
            timers.remove(number)
            removed.append(number)
        gst = SimpleNamespace(SECOND=1_000_000_000, State=SimpleNamespace(NULL="null", PLAYING="playing"), StateChangeReturn=SimpleNamespace(FAILURE="failure", SUCCESS="success"), MessageType=SimpleNamespace(ERROR="error", EOS="eos"), Caps=SimpleNamespace(from_string=lambda value: value))
        glib = SimpleNamespace(timeout_add=timeout, source_remove=remove, filename_to_uri=lambda value, _: value)
        with tempfile.TemporaryDirectory() as root, patch.object(native, "Gst", gst), patch.object(native, "GLib", glib):
            source = os.path.join(root, "input.wav")
            Path(source).write_bytes(b"x")
            for cycle in range(100):
                playback_pipeline = Pipeline(fail=cycle % 4 == 0)
                with patch.object(native, "element", return_value=playback_pipeline):
                    if playback_pipeline.fail:
                        self.assert_code("INTERNAL_ERROR", lambda: native.Playback({"file_path": source, "max_bytes": "1024"}))
                    else:
                        playback = native.Playback({"file_path": source, "max_bytes": "1024"})
                        self.assertEqual(playback.receipt("owned")["byte_limit"], 1024)
                        if cycle % 3 == 0:
                            playback.message(playback_pipeline.bus, SimpleNamespace(type="error"))
                        elif cycle % 3 == 1:
                            playback.message(playback_pipeline.bus, SimpleNamespace(type="eos"))
                        else:
                            playback.stop("cancelled")
                        playback.stop()
                recording_pipeline = Pipeline(fail=cycle % 4 == 0)
                with patch.object(native, "element", return_value=object()), patch.object(native, "pipeline_for", return_value=recording_pipeline):
                    input = {"output_path": os.path.join(root, str(cycle) + ".wav")}
                    if recording_pipeline.fail:
                        self.assert_code("INTERNAL_ERROR", lambda: native.Recording("audio", input))
                    else:
                        recording = native.Recording("audio", input)
                        if cycle % 3 == 0:
                            with wave.open(recording.temporary, "wb") as output:
                                output.setnchannels(1)
                                output.setsampwidth(2)
                                output.setframerate(8000)
                                output.writeframes(b"\0\0" * 800)
                            recording.message(recording_pipeline.bus, SimpleNamespace(type="eos"))
                            self.assertTrue(recording.receipt("owned")["artifact"]["verified"])
                        elif cycle % 3 == 1:
                            recording.message(recording_pipeline.bus, SimpleNamespace(type="error"))
                        else:
                            recording.stop(cancel=True)
                        recording.stop()
                self.assertFalse(timers)
                self.assertTrue(all(bus.watches == 0 and not bus.handlers for bus in buses))
            self.assertEqual(len(buses), 200)


if __name__ == "__main__":
    unittest.main()
