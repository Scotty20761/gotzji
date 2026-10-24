"""One machine-wide record of the ZWCAD windows the guard opened or was pointed at.

Every host's guard (lnwjud, Claude, Codex, gotzji) reads and writes the same file under one named mutex, so a window
opened by one host is visible to the others. Writes replace the file atomically.
"""
from __future__ import annotations

import json
import os
import tempfile
from contextlib import AbstractContextManager
from typing import Callable

from .errors import GuardRefusal

SYSTEM = "system"
OWNER = "owner"

# Window states.
OPENING = "opening"
READY = "ready"
CLOSING = "closing"
CLOSED = "closed"
HANDED_OVER = "handed_over"
FAILED = "failed"


def window_key(pid: int, birth: int) -> str:
    return f"{pid}-{birth}"


class Ledger:
    def __init__(self, path: str, lock: Callable[[], AbstractContextManager]) -> None:
        self._path = path
        self._lock = lock

    def _read(self) -> dict:
        try:
            with open(self._path, encoding="utf-8") as handle:
                data = json.load(handle)
        except FileNotFoundError:
            return {"version": 1, "windows": {}}
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GuardRefusal("CAD_GUARD_LEDGER_INVALID", type(error).__name__) from None
        if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("windows"), dict):
            raise GuardRefusal("CAD_GUARD_LEDGER_INVALID", "unexpected structure")
        return data

    def _write(self, data: dict) -> None:
        directory = os.path.dirname(self._path)
        os.makedirs(directory, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix="ledger-", suffix=".tmp", dir=directory)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                json.dump(data, out, ensure_ascii=False, indent=1, sort_keys=True)
            os.replace(temporary, self._path)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def snapshot(self) -> dict:
        with self._lock():
            return self._read()["windows"]

    def get(self, window_id: str) -> dict | None:
        return self.snapshot().get(window_id)

    def update(self, change: Callable[[dict], object]) -> object:
        """Run `change(windows)` on the current records under the lock and persist them; returns its result."""
        with self._lock():
            data = self._read()
            result = change(data["windows"])
            self._write(data)
            return result

    def put(self, record: dict) -> None:
        def change(windows: dict) -> None:
            windows[record["windowId"]] = record
        self.update(change)

    def patch(self, window_id: str, **fields: object) -> dict | None:
        def change(windows: dict) -> dict | None:
            record = windows.get(window_id)
            if record is not None:
                record.update(fields)
            return record
        return self.update(change)  # type: ignore[return-value]
