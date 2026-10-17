"""Load the unchanged stock multiCAD, pin its COM binding to the guard's chosen window, and run its tools.

Stock looks up `win32com.client.GetActiveObject` and `Dispatch` at call time (connection_mixin.py:72,100), so replacing
the module attributes takes effect for every later call; no stock file is edited.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
from typing import Any

import pythoncom
import pywintypes
import win32com.client

from .errors import GuardRefusal

STOCK_COMMIT = "360ec77"
CAD_PROGIDS = {"zwcad.application", "zwcad.application.2025"}
CAD_CLSIDS = {"{2F671EA1-669F-11E7-91B7-BC5FF42AC839}", "{2F671EB4-669F-11E7-91B7-BC5FF42AC839}"}
MK_E_UNAVAILABLE = -2147221021
E_FAIL = -2147467259
PINNED_PACKAGES = {"pywin32": "311", "fastmcp": "3.1.0", "anyio": "4.12.1"}
PARSERS = {
    "manage_layers": "parse_layer_ops_input",
    "manage_blocks": "parse_block_ops_input",
    "manage_entities": "parse_entity_ops_input",
    "manage_files": "parse_file_ops_input",
}


def tree_hashes(root: str) -> dict[str, str]:
    """SHA-256 of every file under stock `src`, except bytecode caches."""
    hashes = {}
    for directory, folders, files in os.walk(root):
        folders[:] = sorted(f for f in folders if f != "__pycache__")
        for name in sorted(files):
            path = os.path.join(directory, name)
            with open(path, "rb") as handle:
                hashes[os.path.relpath(path, root).replace("\\", "/")] = hashlib.sha256(handle.read()).hexdigest()
    return hashes


def verify_environment(stock_src: str, expected: dict[str, str]) -> None:
    from importlib.metadata import version
    for package, wanted in PINNED_PACKAGES.items():
        if version(package) != wanted:
            raise GuardRefusal("CAD_GUARD_INTEGRITY", f"{package} {version(package)} != {wanted}")
    actual = tree_hashes(stock_src)
    if actual != expected:
        changed = sorted(set(actual) ^ set(expected) | {k for k in actual.keys() & expected.keys() if actual[k] != expected[k]})
        raise GuardRefusal("CAD_GUARD_INTEGRITY", "stock multiCAD changed: " + ", ".join(changed[:5]))


def _is_cad_class(value: Any) -> bool:
    if isinstance(value, str):
        if value.lower() in CAD_PROGIDS:
            return True
        try:
            return str(pywintypes.IID(value)).upper() in CAD_CLSIDS
        except pywintypes.com_error:
            return False
    try:
        return str(value).upper() in CAD_CLSIDS
    except Exception:  # noqa: BLE001
        return False


def _names_drawing(name: Any) -> bool:
    return isinstance(name, str) and re.search(r"\.(dwg|dxf|dwt|dws)(\W|$)", name.lower()) is not None


def _refuse(what: str) -> None:
    sys.stderr.write(f"HOST_BIND_REFUSED: {what}\n")
    raise pywintypes.com_error(E_FAIL, f"HOST_BIND_REFUSED: {what}", None, None)


class Binding:
    """Holds the one Application a stock call may reach; everything else fails closed."""

    def __init__(self) -> None:
        self.application: Any = None
        self.refusals: list[str] = []
        self._wrap = getattr(win32com.client, "__WrapDispatch")
        self._dispatch = win32com.client.Dispatch
        self._dispatch_ex = win32com.client.DispatchEx
        self._get_object = win32com.client.GetObject
        self._co_create = pythoncom.CoCreateInstance
        self._co_create_ex = pythoncom.CoCreateInstanceEx
        self._parse_display_name = pythoncom.MkParseDisplayName
        self._co_get_object = pythoncom.CoGetObject
        self._moniker = win32com.client.Moniker

    def install(self) -> None:
        binding = self

        def get_active_object(Class: Any, clsctx: int = pythoncom.CLSCTX_ALL) -> Any:
            if not _is_cad_class(Class) or binding.application is None:
                binding.refusals.append(f"GetActiveObject({Class!r})")
                raise pywintypes.com_error(MK_E_UNAVAILABLE, "Operation unavailable", None, None)
            dispatch = binding.application._oleobj_.QueryInterface(pythoncom.IID_IDispatch)
            return binding._wrap(dispatch, Class, resultCLSID=pywintypes.IID(Class), clsctx=clsctx)

        def dispatch(target: Any, *args: Any, **kwargs: Any) -> Any:
            if isinstance(target, str):
                binding.refusals.append(f"Dispatch({target!r})")
                _refuse(f"Dispatch({target!r})")
            return binding._dispatch(target, *args, **kwargs)

        def dispatch_ex(clsid: Any, *args: Any, **kwargs: Any) -> Any:
            binding.refusals.append(f"DispatchEx({clsid!r})")
            _refuse(f"DispatchEx({clsid!r})")

        def get_object(Pathname: Any = None, Class: Any = None, clsctx: Any = None) -> Any:
            if Class is not None:
                return get_active_object(Class)
            if _names_drawing(Pathname):
                binding.refusals.append(f"GetObject({Pathname!r})")
                _refuse(f"GetObject({Pathname!r})")
            return binding._get_object(Pathname, Class, clsctx)

        def co_create(clsid: Any, *args: Any, **kwargs: Any) -> Any:
            if _is_cad_class(clsid):
                binding.refusals.append(f"CoCreateInstance({clsid!r})")
                _refuse(f"CoCreateInstance({clsid!r})")
            return binding._co_create(clsid, *args, **kwargs)

        def co_create_ex(clsid: Any, *args: Any, **kwargs: Any) -> Any:
            if _is_cad_class(clsid):
                binding.refusals.append(f"CoCreateInstanceEx({clsid!r})")
                _refuse(f"CoCreateInstanceEx({clsid!r})")
            return binding._co_create_ex(clsid, *args, **kwargs)

        def by_name(original: Any, label: str) -> Any:
            # Binding a drawing's display name starts the server registered for that file when it is not running.
            def guarded(name: Any, *args: Any, **kwargs: Any) -> Any:
                if _names_drawing(name):
                    binding.refusals.append(f"{label}({name!r})")
                    _refuse(f"{label}({name!r})")
                return original(name, *args, **kwargs)
            return guarded

        def connect(clsid: Any, *args: Any, **kwargs: Any) -> Any:
            binding.refusals.append(f"pythoncom.connect({clsid!r})")
            raise pywintypes.com_error(MK_E_UNAVAILABLE, "Operation unavailable", None, None)

        win32com.client.GetActiveObject = get_active_object
        win32com.client.Dispatch = dispatch
        win32com.client.DispatchEx = dispatch_ex
        win32com.client.GetObject = get_object
        pythoncom.CoCreateInstance = co_create
        pythoncom.connect = connect
        pythoncom.GetActiveObject = lambda *a, **k: connect(*a)
        pythoncom.CoCreateInstanceEx = co_create_ex
        pythoncom.MkParseDisplayName = by_name(binding._parse_display_name, "MkParseDisplayName")
        pythoncom.CoGetObject = by_name(binding._co_get_object, "CoGetObject")
        win32com.client.Moniker = by_name(binding._moniker, "Moniker")


class StockMultiCad:
    """The guard's view of stock multiCAD: its parsers, its tools, and its cached adapter."""

    def __init__(self, binding: Binding) -> None:
        from fastmcp import FastMCP
        from fastmcp.tools.function_tool import FunctionTool
        from fastmcp.utilities.types import get_cached_typeadapter
        from fastmcp.server.dependencies import without_injected_parameters
        import mcp_tools.shorthand as shorthand
        import mcp_tools.tools as tools
        import mcp_tools.decorators as decorators
        from adapters import adapter_manager
        from adapters.mixins import utility_mixin

        self.binding = binding
        self._shorthand = shorthand
        self._decorators = decorators
        self._registry = adapter_manager._registry
        # Stock clicks the centre of an AutoCAD-class window after each draw; it never matches ZWCAD but would click AutoCAD.
        utility_mixin.UtilityMixin._simulate_autocad_click = lambda self, *args, **kwargs: False
        inner = FastMCP("stock-multicad")
        for register in (tools.register_session_tools, tools.register_drawing_tools, tools.register_layer_tools, tools.register_file_tools,
                         tools.register_entity_tools, tools.register_block_tools, tools.register_export_tools):
            register(inner)
        self.tools: dict[str, FunctionTool] = {tool.name: tool for tool in asyncio.run(inner.list_tools())}
        self._adapters = {name: get_cached_typeadapter(without_injected_parameters(tool.fn)) for name, tool in self.tools.items()}

    def parse(self, tool: str, arguments: dict) -> list[dict] | None:
        operations = arguments.get("operations")
        try:
            if tool == "manage_session":
                # Stock's own path (session.py:309-314): json.loads without strip, one object becomes a list.
                specs = json.loads(operations) if isinstance(operations, str) else operations
                specs = specs if isinstance(specs, list) else [specs]
            elif tool in PARSERS:
                specs = getattr(self._shorthand, PARSERS[tool])(operations)
            else:
                return []
        except Exception:  # noqa: BLE001 - stock reports these as an input error and runs nothing
            return None
        return specs if isinstance(specs, list) and all(isinstance(spec, dict) for spec in specs) else None

    def run(self, tool: str, arguments: dict, application: Any) -> Any:
        self.binding.application = application
        try:
            self.drop()
            # FunctionTool.run validates and calls through this adapter (function_tool.py:253-298), minus the thread hop.
            return self._adapters[tool].validate_python(arguments)
        finally:
            self.binding.application = None

    def last_document(self) -> Any:
        adapter = self._registry._adapter
        return getattr(adapter._local, "document", None) if adapter is not None else None

    def drop(self) -> None:
        """Forget every COM reference stock cached: the registry adapter, its thread-local objects, the current one."""
        with self._registry._instance_lock:
            adapter, self._registry._adapter, self._registry._cad_type = self._registry._adapter, None, None
        if adapter is not None:
            adapter._local.__dict__.clear()
        self._decorators.set_current_adapter(None)
