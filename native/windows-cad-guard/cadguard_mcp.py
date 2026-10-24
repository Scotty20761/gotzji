r"""Entry for MCP hosts (lnwjud, Claude, Codex): <stock venv>\Scripts\python.exe -X utf8 cadguard_mcp.py"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Before any import from the guard or stock: bytecode is never read from or written next to pinned sources.
sys.pycache_prefix = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local"), "cad-guard", "cache")
sys.path.insert(0, HERE)

from cadguard.server import main  # noqa: E402

main(HERE)
