"""Question bank: load, search, and pick the next question.

Format: JSON Lines, one gradable question per line (``import_jby.py`` writes it)::

    {"id": "q_<12 hex>",                 # stable content hash
     "type": "single" | "multi" | "judge" | "blank" | "open",
     "subject": "math", "paper": "...", "question_type": "单选题", "knowledge": "...",
     "difficulty": 1 | 2 | 3,
     "material": "<html>",              # shared stem of a group question, may be ""
     "content": "<html>",               # HTML; LaTeX as \\( \\); blanks as [[_]]
     "options": ["<html>", ...],        # labels are A, B, C... by position
     "answer": "B" | "AC" | "T" | ["blank 1", "blank 2"] | "<html reference answer>",
     "explanation": "<html>",
     "origin": {"file": "...", "path": "3.sub_questions.1"},  # provenance only
     "source": {"path": "...", "quote": "..."}}              # optional, see below

Questions are linked to outline objectives by id in ``tutor_build``. A question
with a ``source.quote`` not literally found in ``sources_dir/<path>`` is
``unverified`` and never posed: ungraded beats wrongly graded.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any

from tutor_engine.models import TutorError
from tutor_engine.text import contains_quote, html_to_text

TYPES = ("single", "multi", "judge", "blank", "open")
AUTO_GRADED = frozenset({"single", "multi", "judge", "blank"})


@dataclass
class Question:
    id: str
    type: str
    content: str
    answer: str | list[str]
    material: str = ""
    options: list[str] = field(default_factory=list)
    explanation: str = ""
    difficulty: int = 2
    subject: str = ""
    paper: str = ""
    question_type: str = ""
    knowledge: str = ""
    origin: dict[str, Any] = field(default_factory=dict)
    source: dict[str, str] | None = None
    key_status: str = "no_source"  # verified | unverified | no_source

    @property
    def labels(self) -> list[str]:
        return [chr(ord("A") + i) for i in range(len(self.options))]

    def summary(self) -> dict[str, Any]:
        text = html_to_text(self.content) or html_to_text(self.material)
        return {
            "id": self.id,
            "type": self.type,
            "subject": self.subject,
            "question_type": self.question_type,
            "difficulty": self.difficulty,
            "knowledge": self.knowledge,
            "paper": self.paper,
            "text": text[:120],
        }

    def public(self) -> dict[str, Any]:
        """Complete question for inspection or a paper, without its answer key."""
        return {
            "question_id": self.id,
            "question_type": self.type,
            "material": self.material,
            "prompt": self.content,
            "options": dict(zip(self.labels, self.options)),
            "blanks": len(self.answer) if self.type == "blank" else 0,
            "difficulty": self.difficulty,
        }


def _parse(raw: dict[str, Any], line_no: int) -> Question:
    try:
        answer = raw["answer"]
        q = Question(
            id=str(raw["id"]),
            type=str(raw["type"]),
            content=str(raw.get("content", "")),
            answer=[str(a) for a in answer] if isinstance(answer, list) else str(answer),
            material=str(raw.get("material", "")),
            options=[str(o) for o in raw.get("options", [])],
            explanation=str(raw.get("explanation", "")),
            difficulty=int(raw.get("difficulty", 2)),
            subject=str(raw.get("subject", "")),
            paper=str(raw.get("paper", "")),
            question_type=str(raw.get("question_type", "")),
            knowledge=str(raw.get("knowledge", "")),
            origin=dict(raw.get("origin", {})),
            source=raw.get("source"),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise TutorError(f"bank line {line_no}: invalid question ({exc})") from exc
    if q.type not in TYPES:
        raise TutorError(f"bank line {line_no}: type must be one of {TYPES}")
    if q.type == "blank" and not (isinstance(q.answer, list) and q.answer):
        raise TutorError(f"bank line {line_no}: blank answer must be a non-empty list")
    if q.type in {"single", "multi"} and isinstance(q.answer, str):
        allowed = set(q.labels) if q.options else None
        if not q.answer or (allowed is not None and not set(q.answer) <= allowed):
            raise TutorError(f"bank line {line_no}: answer {q.answer!r} is not an option label")
    if not 1 <= q.difficulty <= 3:
        raise TutorError(f"bank line {line_no}: difficulty must be 1, 2 or 3")
    return q


def _verify(q: Question, sources_dir: Path | None) -> None:
    if not q.source:
        return
    q.key_status = "unverified"
    path, quote = q.source.get("path", ""), q.source.get("quote", "")
    if sources_dir is None or not path or not quote:
        return
    file = (sources_dir / path).resolve()
    if not file.is_relative_to(sources_dir.resolve()) or not file.is_file():
        return
    if contains_quote(file.read_text(encoding="utf-8", errors="replace"), quote):
        q.key_status = "verified"


def load_bank(path: Path, sources_dir: Path | None) -> dict[str, Question]:
    """Questions by id."""
    if not path.exists():
        return {}
    questions: dict[str, Question] = {}
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            q = _parse(json.loads(line), line_no)
            if q.id in questions:
                raise TutorError(f"bank line {line_no}: duplicate question id {q.id!r}")
            _verify(q, sources_dir)
            questions[q.id] = q
    return questions


def search(
    bank: dict[str, Question],
    query: str = "",
    subject: str = "",
    types: Collection[str] = (),
    difficulty: int | None = None,
    limit: int = 20,
    detail: bool = False,
) -> dict[str, Any]:
    """Find questions to link to an objective. ``query`` words must all appear."""
    words = [w.casefold() for w in query.split()]
    hits = []
    for q in bank.values():
        if q.key_status == "unverified":
            continue
        if subject and q.subject != subject:
            continue
        if types and q.type not in types:
            continue
        if difficulty is not None and q.difficulty != difficulty:
            continue
        if words:
            haystack = " ".join(
                (html_to_text(q.material), html_to_text(q.content), q.knowledge, q.question_type, q.paper)
            ).casefold()
            if not all(w in haystack for w in words):
                continue
        hits.append(q)
    limit = max(1, min(limit, 50))
    return {
        "total": len(hits),
        "questions": [q.summary() | (q.public() if detail else {}) for q in hits[:limit]],
    }


def poseable(bank: dict[str, Question], ids: Collection[str], qualitative: bool) -> list[Question]:
    """Linked questions that can move this objective.

    Memory/procedure objectives clear only through code-graded questions, so
    open questions are left out for them.
    """
    found = [bank[i] for i in ids if i in bank and bank[i].key_status != "unverified"]
    return found if qualitative else [q for q in found if q.type in AUTO_GRADED]


def pick(
    candidates: list[Question],
    history: list[tuple[str, float]],
    avoid: Collection[str] = (),
    prefer_open: bool = False,
) -> Question:
    """Choose the next question from ``candidates``.

    ``history`` is this objective's ``(question_id, score)`` attempts, oldest
    first. Target difficulty steps up after a right answer and down after a
    wrong one; unseen questions win, then the least recently seen. ``avoid``
    (skipped questions) goes last.
    """
    if not candidates:
        raise TutorError(
            "No poseable bank question is linked to this objective. Link some with "
            "tutor_bank_search + tutor_build, teach it and use tutor_assess, or tutor_defer it."
        )
    target = 2
    if history:
        target = 3 if history[-1][1] >= 1.0 else 1
    last_seen = {qid: i for i, (qid, _) in enumerate(history)}
    return min(
        candidates,
        key=lambda q: (
            q.id in avoid,
            q.id in last_seen,
            last_seen.get(q.id, -1),
            prefer_open and q.type != "open",
            abs(q.difficulty - target),
            q.id,
        ),
    )
