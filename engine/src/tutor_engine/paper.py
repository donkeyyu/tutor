"""Read-only paper assembly from tutor-selected, real bank questions."""

from __future__ import annotations

from typing import Any

from tutor_engine.bank import Question, TYPES
from tutor_engine.models import TutorError


def _text(value: Any, name: str, maximum: int, optional: bool = False) -> str:
    if not isinstance(value, str) or len(value.strip()) > maximum:
        raise TutorError(f"{name} must be a string of at most {maximum} characters")
    value = value.strip()
    if not optional and not value:
        raise TutorError(f"{name} must not be empty")
    return value


def assemble(
    bank: dict[str, Question],
    title: str,
    scope: str,
    knowledge_points: list[dict[str, Any]],
    subject: str = "",
    grade: str = "",
    count: int = 10,
    duration_minutes: int | None = None,
) -> dict[str, Any]:
    """Validate a blueprint and number its questions in standard type order."""
    title = _text(title, "title", 200)
    scope = _text(scope, "scope", 2000)
    subject = _text(subject, "subject", 40, optional=True)
    grade = _text(grade, "grade", 80, optional=True)
    if type(count) is not int or not 1 <= count <= 50:
        raise TutorError("count must be an integer from 1 to 50")
    if duration_minutes is not None and (
        type(duration_minutes) is not int or not 1 <= duration_minutes <= 360
    ):
        raise TutorError("duration_minutes must be an integer from 1 to 360")
    if not isinstance(knowledge_points, list) or not 1 <= len(knowledge_points) <= 50:
        raise TutorError("knowledge_points must contain 1 to 50 points")

    points: list[dict[str, Any]] = []
    selected: list[tuple[int, Question]] = []
    names: set[str] = set()
    seen: set[str] = set()
    for index, raw in enumerate(knowledge_points):
        if not isinstance(raw, dict):
            raise TutorError(f"knowledge point {index + 1} must be an object")
        name = _text(raw.get("name"), "knowledge point name", 200)
        objective = _text(raw.get("objective"), f"{name}: objective", 1000)
        if name in names:
            raise TutorError(f"Duplicate knowledge point name {name!r}")
        names.add(name)
        ids = raw.get("question_ids")
        if not isinstance(ids, list):
            raise TutorError(f"{name}: question_ids must be a list")
        points.append({
            "name": name,
            "objective": objective,
            "question_numbers": [],
            "type_counts": dict.fromkeys(TYPES, 0),
        })
        for question_id in ids:
            if not isinstance(question_id, str) or question_id not in bank:
                raise TutorError(f"{name}: unknown question id {question_id!r}")
            if question_id in seen:
                raise TutorError(f"Duplicate question id {question_id!r}; each question appears once")
            question = bank[question_id]
            if question.key_status == "unverified":
                raise TutorError(f"{name}: question {question_id!r} is unverified")
            if subject and question.subject != subject:
                raise TutorError(f"{name}: question {question_id!r} does not match subject {subject!r}")
            if not question.content.strip() and not question.material.strip():
                raise TutorError(f"{name}: question {question_id!r} has no prompt or material")
            seen.add(question_id)
            selected.append((index, question))
            if len(selected) > count:
                raise TutorError("Selected question count exceeds count")

    selected.sort(key=lambda item: TYPES.index(item[1].type))
    questions = []
    type_counts = dict.fromkeys(TYPES, 0)
    difficulty_counts = dict.fromkeys(("1", "2", "3"), 0)
    for number, (index, question) in enumerate(selected, 1):
        point = points[index]
        point["question_numbers"].append(number)
        point["type_counts"][question.type] += 1
        type_counts[question.type] += 1
        difficulty_counts[str(question.difficulty)] += 1
        questions.append(question.public() | {
            "number": number,
            "knowledge_point": point["name"],
            "paper": question.paper,
        })

    warnings = [f"知识点「{p['name']}」暂无符合要求的题目。" for p in points if not p["question_numbers"]]
    if len(questions) < count:
        warnings.append(f"计划 {count} 题，实际选入 {len(questions)} 题，缺少 {count - len(questions)} 题；未用无关题目补齐。")
    return {
        "title": title,
        "scope": scope,
        "subject": subject,
        "grade": grade,
        "count": len(questions),
        "requested_count": count,
        "duration_minutes": duration_minutes,
        "type_counts": type_counts,
        "difficulty_counts": difficulty_counts,
        "knowledge_points": points,
        "questions": questions,
        "warnings": warnings,
    }
