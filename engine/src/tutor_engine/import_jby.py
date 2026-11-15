"""Import jby word_parse outputs into the tutor bank.

    python -m tutor_engine.import_jby ~/dev/jby_work/question_bank/word_parse/outputs data/bank.jsonl

Reads the parser's canonical JSON (a list of question trees per file) and
writes one gradable leaf per line in the ``bank.py`` format. Rules, from the
parser's public contract (docs/business-rules/03, 04):

* Native tree only. ``fallback`` is a display copy and ``fallback_flag`` is not
  a quality signal, so both are ignored.
* Shared material belongs to the parent: ancestors' ``content`` becomes the
  leaf's ``material``; a 多选多 leaf without options uses its parent's pool.
* Options keep source order; labels are A, B, C... by position.
* A leaf without a usable answer key is skipped and counted, never guessed.
* A 填空 whose key is free text (see ``_free_text``) becomes ``open``: the
  tutor judges it, because exact match would mark right answers wrong.

Re-runnable: ids are content hashes, so regenerating the parser output keeps
links in existing outlines as long as the question itself did not change.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any

from tutor_engine.text import html_to_text

FOLDERS = ("subject", "end_answer", "types", "standalone", "single-question")

TYPE_MAP = {
    "单选": "single",
    "完形": "single",
    "多选多": "single",
    "多选": "multi",
    "断句": "multi",
    "判断": "judge",
    "填空": "blank",
    "解答": "open",
}
CONTAINERS = {"组题", "完形", "多选多"}
DIFFICULTY = {"基础题": 1, "中档题": 2, "较难题": 3}
SUBJECT_NAMES = {
    "语文": "chinese", "数学": "math", "英语": "english", "物理": "physics",
    "化学": "chemistry", "生物": "biology", "地理": "geography", "历史": "history",
    "政治": "politics", "科学": "science",
}
_JUDGE = {"T": "T", "F": "F", "√": "T", "×": "F", "对": "T", "错": "F", "正确": "T", "错误": "F"}
_BRACKET = re.compile(r"【(.+?)】")


def _subject(rel: Path) -> str:
    if rel.parts[0] == "subject" and len(rel.parts) > 2:
        return rel.parts[1]
    match = _BRACKET.search(rel.name)
    return SUBJECT_NAMES.get(match.group(1), "") if match else ""


def _text(value: Any) -> str:
    if isinstance(value, list):
        return "".join(str(v) for v in value if v)
    return str(value or "")


def _answer(kind: str, raw: Any, options: list[str]) -> str | list[str] | None:
    """Normalized key, or None when the leaf has no usable key."""
    if kind == "blank":
        keys = [str(a).strip() for a in (raw if isinstance(raw, list) else [raw])]
        return keys if keys and all(keys) else None
    text = _text(raw).strip()
    if not text:
        return None
    if kind == "judge":
        return _JUDGE.get(text.upper() if len(text) == 1 else text)
    if kind in {"single", "multi"}:
        letters = "".join(sorted(set(re.sub(r"[^A-Z]", "", text.upper()))))
        labels = {chr(ord("A") + i) for i in range(len(options))}
        if not letters or (options and not set(letters) <= labels):
            return None
        if kind == "single" and (len(letters) != 1 or not options):
            return None
        return letters
    return text  # open: reference answer HTML


FREE_TEXT_CHARS = 12


def _free_text(keys: list[str]) -> bool:
    """A blank key that exact match cannot grade fairly: a sentence, an
    equation, listed alternatives (或) or "any reasonable answer" (合理)."""
    return any(
        len(html_to_text(k)) > FREE_TEXT_CHARS or "或" in k or "合理" in k for k in keys
    )


def _leaves(nodes: Any, path: str, material: list[str], pool: list[str]):
    for i, node in enumerate(nodes or []):
        if not isinstance(node, dict) or node.get("isMaterial") or node.get("isMaterialHeader"):
            continue
        here = f"{path}{i}"
        content = str(node.get("content") or "")
        options = [str(o) for o in node.get("options") or []]
        children = [c for c in node.get("sub_questions") or [] if isinstance(c, dict)]
        if children:
            shared = options or pool
            yield from _leaves(
                children, f"{here}.sub_questions.", [*material, content] if content else material, shared
            )
        elif node.get("logic_type") not in CONTAINERS or options or pool:
            yield here, node, material, options or pool


def convert(outputs: Path) -> tuple[list[dict[str, Any]], Counter]:
    rows: dict[str, dict[str, Any]] = {}
    stats: Counter = Counter()
    for folder in FOLDERS:
        for file in sorted((outputs / folder).rglob("*.json")):
            rel = file.relative_to(outputs)
            try:
                data = json.loads(file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                stats["skip: unreadable file"] += 1
                continue
            for path, node, material, options in _leaves(
                data if isinstance(data, list) else [data], "", [], []
            ):
                logic = node.get("logic_type") or ""
                kind = TYPE_MAP.get(logic)
                if kind is None:
                    stats[f"skip: logic_type {logic or 'missing'}"] += 1
                    continue
                answer = _answer(kind, node.get("answer"), options)
                explanation = _text(node.get("answer_explanation"))
                if answer is None and not (kind == "open" and explanation):
                    stats[f"skip: {kind} without usable answer"] += 1
                    continue
                if answer is None:  # open question with explanation only
                    answer = explanation
                content = str(node.get("content") or "")
                body = json.dumps([material, content, options, answer], ensure_ascii=False)
                qid = "q_" + hashlib.sha1(body.encode()).hexdigest()[:12]
                if qid in rows:
                    stats["skip: duplicate"] += 1
                    continue
                # After hashing, so tuning this rule never changes ids.
                if kind == "blank" and isinstance(answer, list) and _free_text(answer):
                    kind = "open"
                    answer = answer[0] if len(answer) == 1 else "；".join(
                        f"({i}) {key}" for i, key in enumerate(answer, 1)
                    )
                    stats["note: blank judged as open (free-text key)"] += 1
                rows[qid] = {
                    "id": qid,
                    "type": kind,
                    "subject": _subject(rel),
                    "paper": file.stem,
                    "question_type": str(node.get("question_type") or ""),
                    "knowledge": str(node.get("knowledge") or ""),
                    "difficulty": DIFFICULTY.get(str(node.get("difficulty") or ""), 2),
                    "material": "".join(material),
                    "content": content,
                    "options": options,
                    "answer": answer,
                    "explanation": explanation,
                    "origin": {"file": str(rel), "path": path},
                }
                stats[f"ok: {kind}"] += 1
    return list(rows.values()), stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tutor_engine.import_jby")
    parser.add_argument("outputs", type=Path, help="word_parse/outputs directory")
    parser.add_argument("bank", type=Path, help="bank.jsonl to write")
    args = parser.parse_args(argv)
    rows, stats = convert(args.outputs.expanduser())
    args.bank.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.bank.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as out:
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
    tmp.replace(args.bank)
    for key, value in sorted(stats.items()):
        print(f"{value:6d}  {key}", file=sys.stderr)
    print(f"{len(rows):6d}  written to {args.bank}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
