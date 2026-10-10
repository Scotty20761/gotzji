"""Refusals the guard returns instead of guessing. Every code names the caller's next step."""
from __future__ import annotations

NEXT_STEP = {
    "CAD_WINDOW_NOT_SELECTED": "Call cad_window with action 'list', then 'select' a windowId, or 'open' a new window and poll 'status' until it is ready.",
    "CAD_WINDOW_NOT_READY": "The window is still starting. Poll cad_window 'status' with this windowId until state is 'ready'.",
    "CAD_WINDOW_GONE": "That ZWCAD process has ended. Call cad_window 'list' and select another window, or 'open' a new one.",
    "CAD_WINDOW_CLOSED_BY_USER": "The owner closed this window. Call cad_window 'list' and select another window, or 'open' a new one.",
    "CAD_WINDOW_BLOCKED": "ZWCAD is not accepting input (its window is disabled). Ask the owner to finish what is open in ZWCAD, then retry.",
    "CAD_WINDOW_DIALOG_OPEN": "A ZWCAD dialog is open in this window. Ask the owner to answer it, then retry. The guard never clicks it.",
    "CAD_WINDOW_BUSY": "Another call is using this window. Retry after it finishes.",
    "CAD_WINDOW_RESELECT_REQUIRED": "The drawings recorded for this window are no longer open. Call cad_window 'list', then 'select' it again.",
    "CAD_WINDOW_NOT_SELECTABLE": "This ZWCAD has no saved drawing active, or belongs to another system. Ask the owner to save or activate a saved drawing, or 'open' a new window.",
    "CAD_WINDOW_FOREIGN_DOCUMENT": "This system window holds a drawing the guard did not create, so it was not closed. The owner decides what to do with it.",
    "CAD_WINDOW_COMMAND_ACTIVE": "A ZWCAD command is still running in this window. Retry when it has finished.",
    "CAD_WINDOW_NOT_OWNER": "This system window belongs to the session that opened it. Pass its releaseToken (returned by 'open') to cad_window 'select' or 'release'. Idle windows are released automatically after 2 hours.",
    "CAD_WINDOW_HOLDS_OWNER_DRAWING": "The owner opened a drawing in this window, so it is read-only now. Use cad_window 'open' for a new window.",
    "CAD_WINDOW_CALL_TIMEOUT": "The call is still running inside ZWCAD. Every zwcad and cad_window call is refused with CAD_GUARD_BUSY until it finishes; retry in a minute.",
    "CAD_DRAWING_READ_ONLY": "The active drawing belongs to the owner and is read-only. Use cad_window 'open' to get a system window and draw there.",
    "CAD_SAVE_TARGET_REFUSED": "Saves go only to new files in the guard's sandbox. Choose a filename that does not exist yet.",
    "CAD_ACTION_REFUSED": "This action is never forwarded. Window rebinding, launching, closing drawings, the clipboard and screen capture are handled by cad_window or not at all.",
    "CAD_ACTION_UNKNOWN": "This action is not one stock multiCAD supports. Check the tool description.",
    "CAD_TOOL_UNKNOWN": "Unknown tool.",
    "CAD_INPUT_UNREADABLE": "The guard reads input exactly as stock multiCAD does, and could not read this. Send valid JSON operations.",
    "CAD_INPUT_EMPTY": "No operations were given.",
    "CAD_FILE_ACTION_ALONE": "Send new, switch and save each as the only operation of its call.",
    "CAD_GUARD_LEDGER_INVALID": "The guard's window record is unreadable. Nothing was changed; the owner must check ledger.json in the guard's state folder under LOCALAPPDATA.",
    "CAD_GUARD_INTERNAL": "The guard hit an unexpected error; nothing further was attempted. The detail names it.",
    "CAD_GUARD_BUSY": "An earlier call is still running inside ZWCAD. Retry when it has finished.",
    "CAD_GUARD_INTEGRITY": "The guard, its Python packages or stock multiCAD do not match the installed fingerprints. Reinstall the guard.",
    "HOST_BIND_REFUSED": "multiCAD tried to attach to or start a ZWCAD the guard did not select. Nothing was started.",
}


class GuardRefusal(Exception):
    """A typed refusal: nothing was changed unless `effect` says otherwise."""

    def __init__(self, code: str, detail: str = "", effect: str = "none") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail
        self.effect = effect

    def as_result(self) -> dict:
        return {"success": False, "refused": True, "code": self.code, "detail": self.detail, "effect": self.effect, "nextStep": NEXT_STEP.get(self.code, "")}
