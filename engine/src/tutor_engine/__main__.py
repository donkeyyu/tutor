"""JSON CLI used by the DSH plugin.

    python -m tutor_engine --db D --bank B [--sources S] [--vault V [--index-folder F]
        [--pdftotext P]] --learner L --course C <command>

Reads the command's JSON arguments from stdin and prints one JSON line:
``{"ok": true, "result": ...}`` or ``{"ok": false, "error": "..."}`` (exit 1).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from tutor_engine.models import TutorError
from tutor_engine.service import Tutor
from tutor_engine.store import Store
from tutor_engine.textbook import Library

COMMANDS = ("status", "bank_search", "build", "quiz", "grade", "assess", "skip", "defer", "profile", "note", "textbook", "paper")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tutor_engine")
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--bank", required=True, type=Path)
    parser.add_argument("--sources", type=Path)
    parser.add_argument("--vault", type=Path, help="textbook-study Obsidian vault")
    parser.add_argument("--index-folder", default="教材索引", help="chapter index folder in the vault")
    parser.add_argument("--pdftotext", default="pdftotext")
    parser.add_argument("--learner", required=True)
    parser.add_argument("--course", required=True)
    parser.add_argument("--demo", action="store_true", help="allow replaying bank questions and switching an unanswered demo")
    parser.add_argument("command", choices=COMMANDS)
    args = parser.parse_args(argv)

    try:
        raw = sys.stdin.read().strip()
        params = json.loads(raw) if raw else {}
        if not isinstance(params, dict):
            raise TutorError("stdin must be a JSON object")
        library = (
            Library(args.vault, args.index_folder, args.db.parent / "textbook_cache", args.pdftotext)
            if args.vault
            else None
        )
        tutor = Tutor(
            Store(args.db), args.bank, args.sources, args.learner, args.course, library=library, demo=args.demo
        )
        result = getattr(tutor, args.command)(**params)
    except (TutorError, json.JSONDecodeError, TypeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
