"""Run inside the stock multiCAD venv by test_stock_contract.py: load real stock through the guard's binding, report.

Never launches ZWCAD: the probe's whole point is that stock cannot start or attach to one while nothing is bound."""
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
stock_src = sys.argv[1]
work = tempfile.mkdtemp(prefix="cadguard-probe-")
sys.pycache_prefix = os.path.join(work, "cache")

from cadguard import runtime  # noqa: E402
from cadguard.stock import Binding, StockMultiCad  # noqa: E402
from cadguard.winapi import WindowsPlatform  # noqa: E402

sandbox = os.path.join(work, "sandbox")
os.makedirs(sandbox)
with open(os.path.join(work, "config.json"), "w", encoding="utf-8") as handle:
    json.dump(runtime.stock_config(sandbox), handle)
os.chdir(work)
sys.path.insert(0, stock_src)
binding = Binding()
binding.install()
stock = StockMultiCad(binding)
from core import get_config  # noqa: E402

config = get_config()
before = {p["pid"] for p in WindowsPlatform().processes()}
started = time.monotonic()
try:
    unbound = stock.run("manage_layers", {"operations": json.dumps([{"action": "list"}])}, None)
except Exception as error:  # noqa: BLE001 - cad_tool raises CADOperationError when nothing can be reached
    unbound = f"{type(error).__name__}: {error}"
elapsed = time.monotonic() - started
import win32com.client  # noqa: E402

try:
    win32com.client.Dispatch("ZWCAD.Application")
    dispatch = "allowed"
except Exception as error:  # noqa: BLE001
    dispatch = str(error)
import asyncio  # noqa: E402

from cadguard.server import build_server  # noqa: E402


class _Guard:
    def __init__(self, stock):
        self.stock = stock


served = asyncio.run(build_server(_Guard(stock)).list_tools())
served_schemas = {tool.name: tool.parameters for tool in served}
import pythoncom  # noqa: E402
import win32com.client.dynamic  # noqa: E402

CLSID = "{2F671EA1-669F-11E7-91B7-BC5FF42AC839}"
DRAWING = r"C:\cadguard-probe-missing\y.DWG "
entry_points = {
    "GetActiveObject(CLSID)": lambda: win32com.client.GetActiveObject(CLSID),
    "GetObject(Class)": lambda: win32com.client.GetObject(Class="ZWCAD.Application"),
    "GetObject(path)": lambda: win32com.client.GetObject(DRAWING),
    "DispatchEx": lambda: win32com.client.DispatchEx("ZWCAD.Application"),
    "dynamic.Dispatch": lambda: win32com.client.dynamic.Dispatch("ZWCAD.Application"),
    "CoCreateInstance": lambda: pythoncom.CoCreateInstance(CLSID, None, pythoncom.CLSCTX_LOCAL_SERVER, pythoncom.IID_IDispatch),
    "connect": lambda: pythoncom.connect("ZWCAD.Application"),
    "pythoncom.GetActiveObject": lambda: pythoncom.GetActiveObject(CLSID),
    "MkParseDisplayName": lambda: pythoncom.MkParseDisplayName(DRAWING),
    "CoGetObject": lambda: pythoncom.CoGetObject(DRAWING, None, pythoncom.IID_IDispatch),
    "Moniker": lambda: win32com.client.Moniker(DRAWING),
}
entry_results = {}
for label, attempt in entry_points.items():
    try:
        attempt()
        entry_results[label] = "allowed"
    except Exception as error:  # noqa: BLE001
        entry_results[label] = "refused" if ("HOST_BIND_REFUSED" in str(error) or "-2147221021" in str(error)) else f"other: {error}"[:120]
entry_results["CoCreateInstanceEx is patched"] = pythoncom.CoCreateInstanceEx is not binding._co_create_ex

from mcp_tools.tools import blocks, entities, files, layers, session  # noqa: E402
from cadguard.policy import KNOWN  # noqa: E402

stock_tables = {"manage_session": session.SESSION_DISPATCH, "manage_files": files.FILE_DISPATCH, "manage_layers": layers.LAYER_DISPATCH,
                "manage_blocks": blocks.BLOCK_DISPATCH, "manage_entities": entities.ENTITY_DISPATCH}
known_matches = {tool: sorted(KNOWN[tool]) == sorted(table) for tool, table in stock_tables.items()}

from adapters import AutoCADAdapter  # noqa: E402
from cadguard.core import Guard  # noqa: E402

adapter = AutoCADAdapter("zwcad")
guard = Guard(None, None, None, sandbox=sandbox, executable="", sentinel_template="", opener="probe")
save_matches = {}
for name in ["plain.dwg", "sub/a.dwg", "x.dxf"]:
    stock_path = os.path.normcase(adapter.resolve_export_path(name, "drawings"))
    guard_path = os.path.normcase(guard.save_target({"action": "save", "filename": name, "format": name.rsplit(".", 1)[1]}, "active.dwg") or "")
    save_matches[name] = stock_path == guard_path
time.sleep(3)
after = {p["pid"] for p in WindowsPlatform().processes()}
print(json.dumps({
    "tools": sorted(stock.tools),
    "schemas": {name: sorted(tool.parameters.get("properties", {})) for name, tool in stock.tools.items()},
    "configCad": sorted(config.cad), "arbitrary": config.output.allow_arbitrary_paths, "output": config.output.directory,
    "parse": {
        "close": stock.parse("manage_files", {"operations": '[{"action":"close"}]'}),
        "shorthand": stock.parse("manage_layers", {"operations": "list"}),
        "sessionStripped": stock.parse("manage_session", {"operations": ' [{"action":"status"}]'}),
        "garbage": stock.parse("manage_files", {"operations": "{"}),
    },
    "unboundResult": unbound if isinstance(unbound, str) else repr(unbound),
    "unboundSeconds": round(elapsed, 2),
    "refusals": binding.refusals,
    "dispatch": dispatch,
    "newZwcad": sorted(after - before),
    "served": sorted(served_schemas),
    "entryPoints": entry_results,
    "knownMatchesStock": known_matches,
    "saveTargetMatchesStock": save_matches,
    "sameSchemas": all(served_schemas[name] == tool.parameters for name, tool in stock.tools.items()),
}))
