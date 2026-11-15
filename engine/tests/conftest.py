from __future__ import annotations

import json
from pathlib import Path

import pytest

from tutor_engine.service import Tutor
from tutor_engine.store import Store


def outline(fact_ids: list[str], idea_ids: list[str] | None = None) -> list[dict]:
    return [
        {
            "id": "m0",
            "name": "Basics",
            "objective": "Use the basic facts",
            "knowledge_points": [
                {"id": "fact", "name": "Capital facts", "type": "memory", "question_ids": fact_ids},
                {"id": "idea", "name": "Why capitals exist", "type": "concept", "question_ids": idea_ids or []},
            ],
        }
    ]


class Clock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def make_tutor(tmp_path: Path):
    sources = tmp_path / "sources"
    sources.mkdir()
    (sources / "geo.txt").write_text("Paris is the capital\nof France.", encoding="utf-8")
    bank = tmp_path / "bank.jsonl"
    clock = Clock()

    def make(rows: list[dict]) -> Tutor:
        bank.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
        tutor = Tutor(Store(tmp_path / "t.db"), bank, sources, "ada", "geo", clock)
        tutor.clock_ref = clock  # type: ignore[attr-defined]
        return tutor

    return make


def q(qid: str, difficulty: int = 2, **extra) -> dict:
    return {
        "id": qid,
        "type": "blank",
        "content": f"<p>prompt {qid} [[_]]</p>",
        "answer": ["Paris"],
        "explanation": "It says so.",
        "difficulty": difficulty,
        **extra,
    }
