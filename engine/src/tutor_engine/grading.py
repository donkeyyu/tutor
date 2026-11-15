"""Deterministic grading against the server-held answer key.

Returns a 0..1 score. ``open`` questions are never graded here: the tutor
judges them against the reference answer (see ``Tutor.grade``).
"""

from __future__ import annotations

import unicodedata

from tutor_engine.models import PendingQuestion
from tutor_engine.text import normalize_answer

_TRUE = {"t", "true", "√", "✓", "对", "正确", "是", "yes", "y"}
_FALSE = {"f", "false", "×", "✗", "x", "错", "错误", "否", "no", "n"}


def _letters(text: str) -> set[str]:
    plain = unicodedata.normalize("NFKC", text).upper()
    return {c for c in plain if "A" <= c <= "Z"}


def _choice(question: PendingQuestion, answer: str) -> set[str]:
    """Labels the learner chose: by letter, or by the full text of one option."""
    given = normalize_answer(answer)
    for i, body in enumerate(question.options):
        if given and given == normalize_answer(body):
            return {chr(ord("A") + i)}
    return _letters(answer)


def _judge(text: str) -> str:
    value = normalize_answer(text)
    return "T" if value in _TRUE else "F" if value in _FALSE else ""


def grade(question: PendingQuestion, answer: str, blanks: list[str]) -> float:
    key = question.answer
    if question.question_type == "single":
        chosen = _choice(question, answer)
        return 1.0 if chosen == {str(key).strip().upper()} else 0.0
    if question.question_type == "multi":
        return 1.0 if _choice(question, answer) == _letters(str(key)) else 0.0
    if question.question_type == "judge":
        given = _judge(answer)
        return 1.0 if given and given == _judge(str(key)) else 0.0
    if question.question_type == "blank":
        keys = key if isinstance(key, list) else [key]
        given = blanks or ([answer] if len(keys) == 1 else [])
        right = sum(
            1
            for i, k in enumerate(keys)
            if i < len(given) and normalize_answer(given[i]) == normalize_answer(k)
        )
        return right / len(keys)
    raise ValueError(f"{question.question_type!r} questions are judged, not graded")
