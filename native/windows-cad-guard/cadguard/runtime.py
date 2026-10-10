"""Start-up for both entry points: verify fingerprints, isolate stock multiCAD, build the Guard."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import tempfile
from contextlib import contextmanager
from typing import Any, Iterator

from .errors import GuardRefusal

LEDGER_MUTEX = "Local\\cad-guard-ledger"


def base_dir() -> str:
    return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local"), "cad-guard")


def paths() -> dict[str, str]:
    base = base_dir()
    return {name: os.path.join(base, name) for name in ("state", "sandbox", "runtime", "cache")}


def isolate_interpreter() -> None:
    """Call before importing anything from stock: bytecode never comes from or goes into the pinned stock tree."""
    sys.pycache_prefix = paths()["cache"]
    for name in [n for n in os.environ if n.startswith("COVERAGE_")]:
        del os.environ[name]


def read_manifest(install_dir: str) -> dict:
    try:
        with open(os.path.join(install_dir, "manifest.json"), encoding="utf-8") as handle:
            manifest = json.load(handle)
        files = manifest["files"]
        if not (isinstance(manifest["stock"]["src"], str) and isinstance(manifest["stock"]["files"], dict)
                and isinstance(manifest["zwcad"]["path"], str) and isinstance(manifest["zwcad"]["sha256"], str)):
            raise GuardRefusal("CAD_GUARD_INTEGRITY", "manifest fields")
        for relative, digest in files.items():
            with open(os.path.join(install_dir, relative), "rb") as handle:
                if hashlib.sha256(handle.read()).hexdigest() != digest:
                    raise GuardRefusal("CAD_GUARD_INTEGRITY", f"guard file changed: {relative}")
    except GuardRefusal:
        raise
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise GuardRefusal("CAD_GUARD_INTEGRITY", f"manifest unreadable: {type(error).__name__}") from None
    return manifest


def write_if_changed(path: str, text: str) -> None:
    """Atomic, and untouched when equal: parallel one-shot guards must never read a half-written config."""
    try:
        with open(path, encoding="utf-8") as handle:
            if handle.read() == text:
                return
    except OSError:
        pass
    handle, temporary = tempfile.mkstemp(prefix="config-", suffix=".tmp", dir=os.path.dirname(path))
    with os.fdopen(handle, "w", encoding="utf-8") as out:
        out.write(text)
    os.replace(temporary, path)


def stock_config(sandbox: str) -> dict:
    return {
        "debug": False,
        "logging_level": "INFO",
        "cad": {"zwcad": {"type": "ZWCAD", "prog_id": "ZWCAD.Application", "startup_wait_time": 15.0}},
        "output": {"directory": sandbox, "format": "dwg", "allow_arbitrary_paths": False},
        "dashboard": {"port": 8888, "host": "127.0.0.1"},
    }


@contextmanager
def ledger_lock() -> Iterator[None]:
    from .winapi import named_mutex
    with named_mutex(LEDGER_MUTEX, 10):
        yield


class LazyStock:
    """Stock multiCAD loads only when a stock tool is called (the CLI's list/open/status never need it)."""

    def __init__(self, loader: Any) -> None:
        self._loader = loader
        self._stock: Any = None

    def __getattr__(self, name: str) -> Any:
        if self._stock is None:
            self._stock = self._loader()
        return getattr(self._stock, name)


def build(install_dir: str, opener: str) -> tuple[Any, Any]:
    """Return (guard, binding). Raises GuardRefusal('CAD_GUARD_INTEGRITY') on any fingerprint or config mismatch."""
    isolate_interpreter()
    manifest = read_manifest(install_dir)
    places = paths()
    for folder in places.values():
        os.makedirs(folder, exist_ok=True)
    stock_src = manifest["stock"]["src"]
    from .stock import Binding, StockMultiCad, verify_environment
    verify_environment(stock_src, manifest["stock"]["files"])
    with open(manifest["zwcad"]["path"], "rb") as handle:
        if hashlib.sha256(handle.read()).hexdigest() != manifest["zwcad"]["sha256"]:
            raise GuardRefusal("CAD_GUARD_INTEGRITY", "ZWCAD.exe changed")
    if "coverage" in sys.modules:
        # The venv's a1_coverage.pth starts coverage when COVERAGE_PROCESS_START is set; a measured run is not stock.
        raise GuardRefusal("CAD_GUARD_INTEGRITY", "coverage is active in this interpreter")
    logging.basicConfig(filename=os.path.join(places["state"], "guard.log"), level=logging.INFO,
                        format="%(asctime)s %(process)d %(name)s %(levelname)s %(message)s")
    write_if_changed(os.path.join(places["runtime"], "config.json"), json.dumps(stock_config(places["sandbox"]), indent=1))
    # Stock reads config.json from the working directory first (core/config.py:92-93).
    os.chdir(places["runtime"])
    if stock_src not in sys.path:
        sys.path.insert(0, stock_src)
    binding = Binding()
    binding.install()

    def load_stock() -> Any:
        from core import get_config
        config = get_config()
        if set(config.cad.keys()) != {"zwcad"} or config.output.allow_arbitrary_paths or os.path.normcase(os.path.abspath(os.path.expanduser(config.output.directory))) != os.path.normcase(places["sandbox"]):
            raise GuardRefusal("CAD_GUARD_INTEGRITY", "stock did not load the guard's config.json")
        return StockMultiCad(binding)

    from .core import Guard
    from .ledger import Ledger
    from .winapi import WindowsPlatform
    guard = Guard(WindowsPlatform(), LazyStock(load_stock), Ledger(os.path.join(places["state"], "ledger.json"), ledger_lock),
                  sandbox=places["sandbox"], executable=manifest["zwcad"]["path"],
                  sentinel_template=os.path.join(install_dir, "assets", "sentinel.dwg"), opener=opener)
    return guard, binding
