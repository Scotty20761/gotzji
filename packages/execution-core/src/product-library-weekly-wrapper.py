#!/usr/bin/env python3
"""Frozen gotzji wrapper around weekly-reading selection/format functions.

It deliberately never calls weekly_reading_synthesis.main() or self_commit().
"""
from __future__ import annotations
import importlib.util
import json
import re
import sys
from datetime import datetime
from pathlib import Path

root = Path(sys.argv[1]).resolve()
source = root / "scripts" / "weekly_reading_synthesis.py"
spec = importlib.util.spec_from_file_location("gotzji_weekly_source", source)
if spec is None or spec.loader is None:
    raise SystemExit(2)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

action = sys.argv[2]
if action == "select":
    original_save = module.save_seen
    module.save_seen = lambda _seen: None
    try:
        articles, overflow = module.pick_articles()
    finally:
        module.save_seen = original_save
    print(json.dumps({"articles": articles, "overflow": overflow}, ensure_ascii=False))
elif action == "brief":
    selected = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    module.write_brief(selected["articles"])
    print(module.PROMPT.format(brief=module.BRIEF_PATH.name))
elif action == "write":
    selected = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    raw = Path(sys.argv[4]).read_text(encoding="utf-8")
    body = module.clean_body(raw)
    if len(body) < 400 or not re.search(r"[\u0E00-\u0E7F]", body):
        raise SystemExit(5)
    today = datetime.now().strftime("%Y-%m-%d")
    output = module.DIGEST_DIR / f"{today}-weekly-reading.md"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(module.frontmatter(selected["articles"], today) + body + module.handoff(selected["articles"], selected["overflow"]), encoding="utf-8")
    module.save_seen((module.load_seen() or set()) | {entry["f"] for entry in selected["articles"]})
    module.BRIEF_PATH.unlink(missing_ok=True)
    print(json.dumps({"path": str(output.resolve()), "articleCount": len(selected["articles"])}, ensure_ascii=False))
else:
    raise SystemExit(2)
