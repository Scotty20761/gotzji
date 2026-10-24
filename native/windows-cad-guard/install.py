"""Install the guard to %LOCALAPPDATA%\\cad-guard\\<version>\\ with a fingerprint manifest.

Run with the stock multiCAD venv's Python:
    E:\\Tools\\multiCAD-mcp-upstream\\.venv\\Scripts\\python.exe install.py --stock E:\\Tools\\multiCAD-mcp-upstream --zwcad "E:\\Program Files\\ZWSOFT\\ZWCAD 2025\\ZWCAD.exe"

Hosts then run the installed copy, never this checkout. An existing version folder is never overwritten.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from cadguard import __version__  # noqa: E402
from cadguard.stock import PINNED_PACKAGES, STOCK_COMMIT, tree_hashes  # noqa: E402

SHIPPED = ["cadguard_mcp.py", "cadguard_cli.py"] + [f"cadguard/{name}" for name in sorted(os.listdir(os.path.join(HERE, "cadguard"))) if name.endswith(".py")]


def sha256(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stock", required=True)
    parser.add_argument("--zwcad", required=True)
    parser.add_argument("--template", help="blank drawing for new windows; default: ZWCAD's own shipped zwcadiso.dwt")
    options = parser.parse_args()
    from importlib.metadata import version
    for package, wanted in PINNED_PACKAGES.items():
        if version(package) != wanted:
            raise SystemExit(f"{package} {version(package)} is not the pinned {wanted}; run with the stock multiCAD venv")
    head = subprocess.run(["git", "-C", options.stock, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", options.stock, "status", "--porcelain", "--", "src"], capture_output=True, text=True, check=True).stdout.strip()
    if not head.startswith(STOCK_COMMIT) or dirty:
        raise SystemExit(f"stock multiCAD must be a clean {STOCK_COMMIT} (HEAD {head[:7]}, changes: {bool(dirty)})")
    target = os.path.join(os.environ["LOCALAPPDATA"], "cad-guard", __version__)
    if os.path.exists(target):
        raise SystemExit(f"{target} exists; bump cadguard.__version__ for a new install")
    files = {}
    for relative in SHIPPED:
        source = os.path.join(HERE, relative)
        destination = os.path.join(target, relative)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        shutil.copyfile(source, destination)
        files[relative] = sha256(destination)
    # A DWT is a DWG; copied under a .dwg name it opens as a saved drawing, which registers in the running-object
    # table. The vendor's shipped template carries no user data, so nothing personal goes into the sentinel.
    template = options.template or os.path.join(os.path.dirname(os.path.abspath(options.zwcad)), "UserDataCache", "en-US", "Template", "zwcadiso.dwt")
    sentinel = os.path.join(target, "assets", "sentinel.dwg")
    os.makedirs(os.path.dirname(sentinel), exist_ok=True)
    shutil.copyfile(template, sentinel)
    files["assets/sentinel.dwg"] = sha256(sentinel)
    stock_src = os.path.join(os.path.abspath(options.stock), "src")
    manifest = {
        "version": __version__,
        "files": files,
        "stock": {"src": stock_src, "commit": head, "files": tree_hashes(stock_src)},
        "zwcad": {"path": os.path.abspath(options.zwcad), "sha256": sha256(options.zwcad)},
        "python": sys.executable,
    }
    with open(os.path.join(target, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1, sort_keys=True)
    entry = {"command": sys.executable, "args": ["-X", "utf8", os.path.join(target, "cadguard_mcp.py")]}
    print(json.dumps({"installed": target, "manifestSha256": sha256(os.path.join(target, "manifest.json")), "mcpServer": {"zwcad": entry}}, indent=1))


if __name__ == "__main__":
    main()
