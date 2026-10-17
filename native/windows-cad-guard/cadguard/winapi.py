"""Win32 facts the guard needs, without calling into ZWCAD: processes, windows, dialogs, mutexes and a launch that is
neither in the guard's process tree nor in any host's job object."""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import time
from contextlib import contextmanager
from typing import Callable, Iterator

import pythoncom
import win32api
import win32con
import win32event
import win32gui
import win32process
import win32profile
import win32security
import win32com.client

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_CREATE_PROCESS = 0x0080
CREATE_SUSPENDED = 0x00000004
CREATE_UNICODE_ENVIRONMENT = 0x00000400
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
PROC_THREAD_ATTRIBUTE_PARENT_PROCESS = 0x00020000
STARTF_USESHOWWINDOW = 0x00000001


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR), ("lpTitle", wt.LPWSTR),
                ("dwX", wt.DWORD), ("dwY", wt.DWORD), ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD),
                ("dwXCountChars", wt.DWORD), ("dwYCountChars", wt.DWORD), ("dwFillAttribute", wt.DWORD),
                ("dwFlags", wt.DWORD), ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
                ("lpReserved2", ctypes.c_void_p), ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE), ("hStdError", wt.HANDLE)]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wt.HANDLE), ("hThread", wt.HANDLE), ("dwProcessId", wt.DWORD), ("dwThreadId", wt.DWORD)]


kernel32.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, wt.DWORD, wt.DWORD, ctypes.POINTER(ctypes.c_size_t)]
kernel32.InitializeProcThreadAttributeList.restype = wt.BOOL
kernel32.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, wt.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
kernel32.UpdateProcThreadAttribute.restype = wt.BOOL
kernel32.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
kernel32.CreateProcessW.argtypes = [wt.LPCWSTR, wt.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wt.BOOL, wt.DWORD, ctypes.c_void_p, wt.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(PROCESS_INFORMATION)]
kernel32.CreateProcessW.restype = wt.BOOL
user32.GetShellWindow.restype = wt.HWND
kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
kernel32.OpenProcess.restype = wt.HANDLE
kernel32.ResumeThread.argtypes = [wt.HANDLE]
kernel32.ResumeThread.restype = wt.DWORD
kernel32.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
kernel32.CloseHandle.argtypes = [wt.HANDLE]
kernel32.IsProcessInJob.argtypes = [wt.HANDLE, wt.HANDLE, ctypes.POINTER(wt.BOOL)]
kernel32.IsProcessInJob.restype = wt.BOOL
kernel32.GetProcessTimes.argtypes = [wt.HANDLE, ctypes.POINTER(wt.FILETIME), ctypes.POINTER(wt.FILETIME), ctypes.POINTER(wt.FILETIME), ctypes.POINTER(wt.FILETIME)]
kernel32.GetProcessTimes.restype = wt.BOOL
kernel32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
kernel32.GetExitCodeProcess.restype = wt.BOOL
STILL_ACTIVE = 259
CRASH_PROMPT_TEXT = "ZWCAD Crashed in your last running, do you want to send diagnostic information back to ZWSOFT?"


def _filetime(value: wt.FILETIME) -> int:
    return (value.dwHighDateTime << 32) | value.dwLowDateTime


def process_birth(pid: int) -> int | None:
    """Creation time (100 ns ticks) of a live process, or None: the PID plus this number names exactly one process."""
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        code = wt.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != STILL_ACTIVE:
            return None
        created, exited, kernel, user = wt.FILETIME(), wt.FILETIME(), wt.FILETIME(), wt.FILETIME()
        if not kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            return None
        return _filetime(created)
    finally:
        kernel32.CloseHandle(handle)


def _windows_of(pid: int) -> list[int]:
    found: list[int] = []

    def visit(hwnd: int, _: object) -> bool:
        if win32process.GetWindowThreadProcessId(hwnd)[1] == pid:
            found.append(hwnd)
        return True

    win32gui.EnumWindows(visit, None)
    return found


def main_window(pid: int) -> int | None:
    """ZWCAD's MDI frame: a top-level `Afx:` window titled 'ZWCAD …', visible or hidden."""
    best = None
    for hwnd in _windows_of(pid):
        if win32gui.GetParent(hwnd) == 0 and win32gui.GetClassName(hwnd).startswith("Afx:") and win32gui.GetWindowText(hwnd).startswith("ZWCAD"):
            if best is None or win32gui.IsWindowVisible(hwnd):
                best = hwnd
    return best


def dialogs(pid: int) -> list[str]:
    """Visible top-level dialog boxes (#32770) the process owns; the guard never clicks them."""
    return [win32gui.GetWindowText(h) or "(untitled dialog)" for h in _windows_of(pid)
            if win32gui.GetClassName(h) == "#32770" and win32gui.IsWindowVisible(h)]


class WindowsPlatform:
    def processes(self) -> list[dict]:
        # A fresh WMI proxy per call: the CAD thread can be replaced after a stuck call, and COM proxies are per thread.
        wmi = win32com.client.GetObject("winmgmts:root\\cimv2")
        rows = []
        for row in wmi.ExecQuery("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name='ZWCAD.exe'"):
            pid = int(row.ProcessId)
            birth = process_birth(pid)
            if birth is None:
                continue
            frame = main_window(pid)
            rows.append({"pid": pid, "birth": birth, "exe": row.ExecutablePath or "", "commandLine": row.CommandLine or "",
                         "title": win32gui.GetWindowText(frame) if frame else "", **self.window_state(pid, frame)})
        return rows

    def birth(self, pid: int) -> int | None:
        return process_birth(pid)

    def helpers(self) -> list[dict]:
        """ZWCAD's updater processes with their parent PID (the field survives the parent's exit)."""
        wmi = win32com.client.GetObject("winmgmts:root\\cimv2")
        return [{"pid": int(row.ProcessId), "name": str(row.Name), "parentPid": int(row.ParentProcessId), "created": str(row.CreationDate)}
                for row in wmi.ExecQuery("SELECT ProcessId, Name, ParentProcessId, CreationDate FROM Win32_Process WHERE Name='ZwUpdHost.exe'")]

    def window_state(self, pid: int, frame: int | None = None) -> dict:
        frame = frame if frame is not None else main_window(pid)
        return {"visible": bool(frame and win32gui.IsWindowVisible(frame)), "enabled": bool(frame and win32gui.IsWindowEnabled(frame)),
                "dialogs": dialogs(pid), "title": win32gui.GetWindowText(frame) if frame else ""}

    def decline_crash_prompt(self, pid: int) -> bool:
        """Answer No to ZWCAD's crash-report prompt in this process; "Remember my choice" is left unchecked."""
        for hwnd in _windows_of(pid):
            if win32gui.GetClassName(hwnd) != "#32770" or not win32gui.IsWindowVisible(hwnd) or win32gui.GetWindowText(hwnd) != "ZWCAD":
                continue
            children: list[int] = []
            win32gui.EnumChildWindows(hwnd, lambda child, found: found.append(child) or True, children)
            texts = [win32gui.GetWindowText(child) for child in children if win32gui.GetClassName(child) == "Static"]
            buttons = {win32gui.GetWindowText(child): child for child in children if win32gui.GetClassName(child) == "Button"}
            # Exactly the prompt seen on 2026-10-10: one sentence about the diagnostic report, Yes, No and the
            # "remember" checkbox. Any other dialog is left for the owner.
            if len(texts) != 1 or not texts[0].startswith(CRASH_PROMPT_TEXT) or {"Yes", "No"} - set(buttons) or len(buttons) > 3:
                continue
            win32gui.PostMessage(buttons["No"], win32con.BM_CLICK, 0, 0)
            return True
        return False

    def launch(self, exe: str, args: list[str], cwd: str, on_created: Callable[[int, int], None]) -> dict:
        """Start ZWCAD suspended as a child of the desktop shell, record it, then let it run.

        With the shell as parent, ZWCAD inherits the shell's job (normally none) and is outside the guard's process
        tree, so a host killing the guard's tree or closing its kill-on-close job cannot end it."""
        environment = ctypes.create_unicode_buffer(user_environment())
        shell_pid = win32process.GetWindowThreadProcessId(user32.GetShellWindow())[1]
        parent = kernel32.OpenProcess(PROCESS_CREATE_PROCESS, False, shell_pid)
        if not parent:
            raise OSError(ctypes.get_last_error(), "cannot open the desktop shell as ZWCAD's parent")
        size = ctypes.c_size_t()
        kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        attributes = ctypes.create_string_buffer(size.value)
        process = PROCESS_INFORMATION()
        try:
            if not kernel32.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)):
                raise OSError(ctypes.get_last_error(), "InitializeProcThreadAttributeList")
            parent_value = wt.HANDLE(parent)
            if not kernel32.UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, ctypes.byref(parent_value), ctypes.sizeof(parent_value), None, None):
                raise OSError(ctypes.get_last_error(), "UpdateProcThreadAttribute")
            startup = STARTUPINFOEXW()
            startup.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
            startup.StartupInfo.dwFlags = STARTF_USESHOWWINDOW
            startup.StartupInfo.wShowWindow = win32con.SW_SHOWNORMAL
            startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)
            command = ctypes.create_unicode_buffer(" ".join(f'"{part}"' for part in [exe, *args]))
            if not kernel32.CreateProcessW(exe, command, None, None, False, CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                                           ctypes.cast(environment, ctypes.c_void_p), cwd, ctypes.byref(startup), ctypes.byref(process)):
                raise OSError(ctypes.get_last_error(), "CreateProcessW")
            pid = int(process.dwProcessId)
            try:
                birth = process_birth(pid)
                if birth is None:
                    raise OSError(0, "the new ZWCAD ended before it was recorded")
                on_created(pid, birth)
            except BaseException:
                # Nothing has run yet: ending a suspended process we just created loses nothing.
                kernel32.TerminateProcess(process.hProcess, 1)
                raise
            in_job = wt.BOOL()
            kernel32.IsProcessInJob(process.hProcess, None, ctypes.byref(in_job))
            if kernel32.ResumeThread(process.hThread) == 0xFFFFFFFF:
                # Still suspended, so nothing ran: ending it loses nothing and leaves no invisible ZWCAD behind.
                kernel32.TerminateProcess(process.hProcess, 1)
                raise OSError(ctypes.get_last_error(), "ResumeThread")
            return {"pid": pid, "birth": birth, "inJob": bool(in_job.value)}
        finally:
            kernel32.DeleteProcThreadAttributeList(attributes)
            kernel32.CloseHandle(parent)
            if process.hThread:
                kernel32.CloseHandle(process.hThread)
            if process.hProcess:
                kernel32.CloseHandle(process.hProcess)

    @contextmanager
    def window_mutex(self, name: str, timeout: float) -> Iterator[None]:
        with named_mutex(name, timeout):
            yield

    def resolve(self, pid: int, birth: int, monikers: list[str]) -> object:
        from .rot import resolve_application
        return resolve_application(pid, birth, monikers)

    def pump(self) -> None:
        for _ in range(5):
            pythoncom.PumpWaitingMessages()
            time.sleep(0.05)

    def release_com(self) -> None:
        import gc
        gc.collect()
        pythoncom.CoFreeUnusedLibraries()


def user_environment() -> str:
    """The user's logon environment (what Explorer gives a program), never the host's.

    MCP clients start servers with a trimmed environment (about ten variables); ZWCAD 2025 started with that
    environment hung on its splash screen without registering (observed 2026-10-10)."""
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY | win32con.TOKEN_DUPLICATE)
    try:
        variables = win32profile.CreateEnvironmentBlock(token, False)
    finally:
        token.Close()
    return "".join(f"{name}={value}\0" for name, value in sorted(variables.items(), key=lambda item: item[0].upper())) + "\0"


@contextmanager
def named_mutex(name: str, timeout: float) -> Iterator[None]:
    """A Win32 mutex owned by the calling thread; Windows releases it if the holder dies (WAIT_ABANDONED)."""
    handle = win32event.CreateMutex(None, False, name)
    try:
        result = win32event.WaitForSingleObject(handle, int(timeout * 1000))
        if result not in (win32event.WAIT_OBJECT_0, win32event.WAIT_ABANDONED):
            raise TimeoutError(name)
        try:
            yield
        finally:
            win32event.ReleaseMutex(handle)
    finally:
        win32api.CloseHandle(handle)
