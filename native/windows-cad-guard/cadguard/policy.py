"""Which stock multiCAD calls the guard forwards, and on which drawings.

The action names come from stock multiCAD's own parsers (see stock.parse); this module only decides. Rights are per
drawing: a write needs the active drawing to be one the guard created (see core.Guard).
"""
from __future__ import annotations

from dataclasses import dataclass

READ = "read"
EXPORT = "sandbox_export"
WRITE = "write"
NEW = "new"
SWITCH = "switch"
SAVE = "save"
NEVER = "never"
FILE_ACTIONS = frozenset({NEW, SWITCH, SAVE})

# Stock dispatch tables at commit 360ec77; an action outside these is unknown and refused.
KNOWN = {
    "manage_session": {"connect", "disconnect", "status", "list_supported", "check_running", "zoom_extents", "undo", "redo", "screenshot", "export_view", "open_dashboard"},
    "manage_files": {"save", "new", "close", "list", "switch"},
    "manage_layers": {"create", "rename", "delete", "turn_on", "turn_off", "set_color", "list", "is_on", "info"},
    "manage_blocks": {"create", "insert", "list", "info", "get_attrs", "set_attrs"},
    "manage_entities": {"select", "move", "rotate", "scale", "set_color", "set_layer", "set_color_bylayer", "copy", "paste", "delete"},
}

CLASS = {
    "manage_session": {
        "status": READ, "list_supported": READ,
        "zoom_extents": WRITE, "undo": WRITE, "redo": WRITE,
        # Rebinding, launching and the browser are the guard's job; screenshot and export_view look for a window class
        # ZWCAD does not have, send ESC and leave FILEDIA changed on failure.
        "connect": NEVER, "disconnect": NEVER, "check_running": NEVER, "open_dashboard": NEVER, "screenshot": NEVER, "export_view": NEVER,
    },
    "manage_files": {"list": READ, "new": NEW, "switch": SWITCH, "save": SAVE, "close": NEVER},
    "manage_layers": {"list": READ, "is_on": READ, "info": READ},
    "manage_blocks": {"list": READ, "info": READ, "get_attrs": READ},
    # select clears the drawing's current selection, so it is a write; copy and paste go through the owner's clipboard.
    "manage_entities": {"copy": NEVER, "paste": NEVER},
}


@dataclass(frozen=True)
class Plan:
    """What one call needs: every class its actions fall in, and the actions themselves."""

    tool: str
    kinds: frozenset[str]
    actions: tuple[str, ...]
    reason: str = ""

    @property
    def refused(self) -> bool:
        return NEVER in self.kinds

    @property
    def writes(self) -> bool:
        return bool(self.kinds & {WRITE, NEW, SWITCH, SAVE})


def _plan(tool: str, kinds: set[str], actions: tuple[str, ...] = (), reason: str = "") -> Plan:
    return Plan(tool, frozenset(kinds), actions, reason)


def classify(tool: str, actions: list[str] | None, arguments: dict) -> Plan:
    """Classify one call. `actions` is None when stock's parser could not read the input."""
    if tool == "draw_entities":
        return _plan(tool, {WRITE}, ("draw",))
    if tool == "export_data":
        fmt = arguments.get("format", "json")
        if not isinstance(fmt, str):
            return _plan(tool, {NEVER}, (), "CAD_INPUT_UNREADABLE")
        # Stock compares format.lower() without stripping (export.py:194).
        if fmt.lower() == "json":
            return _plan(tool, {READ}, ("export_json",))
        if fmt.lower() == "excel":
            return _plan(tool, {EXPORT}, ("export_excel",))
        return _plan(tool, {NEVER}, (), "CAD_INPUT_UNREADABLE")
    if tool not in KNOWN:
        return _plan(tool, {NEVER}, (), "CAD_TOOL_UNKNOWN")
    if actions is None:
        return _plan(tool, {NEVER}, (), "CAD_INPUT_UNREADABLE")
    if not actions:
        return _plan(tool, {NEVER}, (), "CAD_INPUT_EMPTY")
    kinds = set()
    for action in actions:
        if action not in KNOWN[tool]:
            return _plan(tool, {NEVER}, tuple(actions), "CAD_ACTION_UNKNOWN")
        kind = CLASS.get(tool, {}).get(action, WRITE)
        if kind == NEVER:
            return _plan(tool, {NEVER}, tuple(actions), "CAD_ACTION_REFUSED")
        kinds.add(kind)
    if kinds & FILE_ACTIONS and len(actions) > 1:
        # new, switch and save each change which drawing later actions address; checked one at a time, alone.
        return _plan(tool, {NEVER}, tuple(actions), "CAD_FILE_ACTION_ALONE")
    return _plan(tool, kinds, tuple(actions))
