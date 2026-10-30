"""Find one ZWCAD instance through the drawings it registered in the running-object table.

Every ZWCAD registers the same `!{CLSID}` entries, so `GetActiveObject` cannot choose between them. Every drawing it
opens from a file registers a file moniker under the drawing's full path, and that drawing's Application is the
instance holding it. Only the paths the caller recorded for this instance are bound, so no other ZWCAD is called into.
"""
from __future__ import annotations

import ntpath

import pythoncom
import pywintypes
import win32com.client
import win32process

from .winapi import process_birth


def _norm(path: str) -> str:
    return ntpath.normcase(ntpath.normpath(path))


def resolve_application(pid: int, birth: int, monikers: list[str]) -> object | None:
    """The Application of the instance (pid, birth) reached through one of its recorded drawings, or None.

    Never BindToObject/MkParseDisplayName/GetObject(path): binding a path that is not running starts a server."""
    wanted = [_norm(path) for path in monikers if path]
    if not wanted:
        return None
    table = pythoncom.GetRunningObjectTable()
    context = pythoncom.CreateBindCtx(0)
    registered = {}
    for moniker in table.EnumRunning():
        try:
            if moniker.IsSystemMoniker() != pythoncom.MKSYS_FILEMONIKER:
                continue
            registered.setdefault(_norm(moniker.GetDisplayName(context, None)), moniker)
        except pywintypes.com_error:
            continue
    for path in wanted:
        moniker = registered.get(path)
        if moniker is None:
            continue
        try:
            document = win32com.client.Dispatch(table.GetObject(moniker).QueryInterface(pythoncom.IID_IDispatch))
            application = document.Application
            hwnd = int(application.HWND) & 0xFFFFFFFF
        except pywintypes.com_error:
            continue
        if win32process.GetWindowThreadProcessId(hwnd)[1] == pid and process_birth(pid) == birth:
            return application
    return None
