# cad-guard

Stock multiCAD MCP, pinned to one chosen ZWCAD window per call, for every MCP host on the machine (lnwjud, Claude,
Codex, Cursor) and for gotzji's one-shot native operations.

Stock multiCAD attaches through `GetActiveObject("ZWCAD.Application")`, which every running ZWCAD registers under the
same name, and starts a hidden ZWCAD when that fails. A call killed by its host's timeout then leaves a hidden ZWCAD
nobody owns. cad-guard keeps stock multiCAD's files byte-identical and verified, and changes only where it attaches.

## What it does

- Serves the 7 stock tools with their own names and input schemas, plus `cad_window`
  (`list`, `open`, `status`, `select`, `release`, `report`).
- Every stock call runs on one COM thread, one at a time, in the window selected with `cad_window`, which is found
  through the drawings it registered in the running-object table and checked by PID and process start time.
- Nothing can start or attach to another ZWCAD: string-ProgID `Dispatch`, `DispatchEx`, `GetObject` on drawings,
  `CoCreateInstance` and `pythoncom.connect` are refused.
- Rights are per drawing: drawings the guard created are writable; every other drawing is read-only, in any window.
- `open` returns at once (ZWCAD needs 35–60 s to start) and `status` is polled. ZWCAD is started with the user's logon
  environment and the desktop shell as its parent, so a host killing the guard cannot take ZWCAD with it.
- `release` (end of task, with the `releaseToken` that `open` returned) makes each of the window's drawings active in
  turn, saves it into the sandbox as a new DWG file, checks that file on disk, closes it, and quits that ZWCAD. Every
  drawing is saved, because ZWCAD 2025 reports the unsaved state of an inactive drawing wrongly. A window holding a
  drawing the guard did not create is never closed. Windows idle for 2 hours are released automatically; a window
  without its token can be released by anyone after 30 minutes idle. ZWCAD is never killed.
- A window's starting drawing is never renamed by a save: drawings saved under a new name are not entered in the
  running-object table, so it is the only way back into that window.
- Refusals carry a code and the next step.

Design and review record: `references/DESIGN-2026-10-10-cad-guard.md` in the owner's Investment Library.

## Install

Run with the stock multiCAD venv's Python (it pins pywin32 311, fastmcp 3.1.0, anyio 4.12.1):

```
E:\Tools\multiCAD-mcp-upstream\.venv\Scripts\python.exe install.py --stock E:\Tools\multiCAD-mcp-upstream --zwcad "E:\Program Files\ZWSOFT\ZWCAD 2025\ZWCAD.exe"
```

It refuses unless stock multiCAD is a clean checkout of `360ec77`, copies the guard to
`%LOCALAPPDATA%\cad-guard\<version>\` (an existing version is never overwritten), uses ZWCAD's own shipped
`zwcadiso.dwt` as the blank drawing for new windows, writes `manifest.json` with every fingerprint, and prints the
MCP entry. Hosts run the installed copy, never this checkout.

## Register as `zwcad`

```json
{ "zwcad": { "command": "E:\\Tools\\multiCAD-mcp-upstream\\.venv\\Scripts\\python.exe",
             "args": ["-X", "utf8", "C:\\Users\\<user>\\AppData\\Local\\cad-guard\\<version>\\cadguard_mcp.py"] } }
```

One-shot use (gotzji): `python.exe -X utf8 <install>\cadguard_cli.py` with one JSON request on stdin, for example
`{"action":"call","opener":"gotzji","windowId":"w…","tool":"manage_layers","arguments":{"operations":"[{\"action\":\"list\"}]"}}`.

## State

`%LOCALAPPDATA%\cad-guard\`: `state\ledger.json` (windows, openers, drawings, incidents; named mutex
`Local\cad-guard-ledger`), `sandbox\` (new windows and saved drawings), `runtime\config.json` (stock's config:
ZWCAD only, sandbox output, no arbitrary paths), `cache\` (bytecode, never next to pinned sources).

## Tests

`python -m unittest discover -s tests -t tests` runs anywhere (fakes for COM and Win32). On Windows with the stock venv
present, `tests/test_stock_contract.py` also loads real stock multiCAD through the guard's binding and proves it can
neither attach to nor start a ZWCAD while nothing is selected.
