from __future__ import annotations

import json
from pathlib import Path

from tutor_engine.bank import load_bank
from tutor_engine.import_jby import convert


def test_import_flattens_trees_and_skips_missing_keys(tmp_path: Path):
    paper = [
        {"logic_type": "单选", "content": "<p>Q1</p>", "options": ["a", "b"], "answer": "b",
         "difficulty": "较难题", "fallback": {"content": "display copy"}},
        {"logic_type": "组题", "content": "<p>Shared passage</p>", "sub_questions": [
            {"logic_type": "填空", "content": "<p>x[[_]]y[[_]]</p>", "answer": ["1", "2"],
             "answer_explanation": ["<p>why</p>"]},
            {"logic_type": "解答", "content": "<p>Explain</p>", "answer": "", "answer_explanation": "<p>ref</p>"},
            {"logic_type": "单选", "content": "<p>no key</p>", "options": ["a", "b"], "answer": ""},
            {"logic_type": "填空", "content": "<p>why[[_]]</p>", "answer": ["加快溶解(或“均匀受热”)"]},
        ]},
        {"logic_type": "多选多", "content": "<p>Pool</p>", "options": ["p", "q", "r"], "sub_questions": [
            {"logic_type": "多选多", "content": "", "options": [], "answer": "C"},
        ]},
        {"logic_type": "判断", "content": "<p>T?</p>", "answer": "×"},
    ]
    folder = tmp_path / "subject" / "math"
    folder.mkdir(parents=True)
    (folder / "math-1.json").write_text(json.dumps(paper, ensure_ascii=False), encoding="utf-8")

    rows, stats = convert(tmp_path)
    at = {r["origin"]["path"]: r for r in rows}
    assert stats["skip: single without usable answer"] == 1
    assert (at["0"]["answer"], at["0"]["difficulty"]) == ("B", 3)
    assert at["1.sub_questions.0"]["material"] == "<p>Shared passage</p>"
    assert at["1.sub_questions.1"]["answer"] == "<p>ref</p>"  # reference falls back to explanation
    assert at["3"]["answer"] == "F"
    assert (at["1.sub_questions.3"]["type"], at["1.sub_questions.3"]["answer"]) == ("open", "加快溶解(或“均匀受热”)")
    assert (at["2.sub_questions.0"]["options"], at["2.sub_questions.0"]["answer"]) == (["p", "q", "r"], "C")
    assert all(r["subject"] == "math" for r in rows)

    bank_file = tmp_path / "bank.jsonl"
    bank_file.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
    assert len(load_bank(bank_file, None)) == len(rows)  # output passes bank validation
