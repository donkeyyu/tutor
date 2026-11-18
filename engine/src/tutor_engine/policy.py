"""Pure decisions over ``Progress``. Ported from DeepTutor ``learning/policy.py``.

No I/O, no model calls. Answers: is this objective mastered (a hard per-type
gate), and what should the learner do next. Advancement is computed from
evidence on every call, never stored as a cursor.
"""

from __future__ import annotations

from typing import Any

from tutor_engine.mastery import compute_mastery
from tutor_engine.models import QUALITATIVE_TYPES, KnowledgePoint, KnowledgeType, Progress

QUANTITATIVE_GATE: dict[KnowledgeType, float] = {
    KnowledgeType.MEMORY: 0.9,
    KnowledgeType.PROCEDURE: 0.9,
}


def mastery(progress: Progress, kp: KnowledgePoint) -> float:
    if kp.type in QUALITATIVE_TYPES and progress.qualitative.get(kp.id):
        return 1.0
    return compute_mastery(progress.scores(kp.id))


def is_mastered(progress: Progress, kp: KnowledgePoint) -> bool:
    """MEMORY/PROCEDURE: score >= gate. CONCEPT/DESIGN: a recorded assess pass."""
    if kp.type in QUALITATIVE_TYPES:
        return bool(progress.qualitative.get(kp.id))
    return compute_mastery(progress.scores(kp.id)) >= QUANTITATIVE_GATE[kp.type]


def status(progress: Progress, kp: KnowledgePoint) -> str:
    if is_mastered(progress, kp):
        return "mastered"
    seen = any(a.knowledge_point_id == kp.id for a in progress.attempts)
    return "learning" if seen else "new"


def due_reviews(progress: Progress, now: float) -> list[str]:
    """Mastered objectives whose review is due, most overdue first."""
    due = []
    for kp_id, state in progress.reviews.items():
        found = progress.find(kp_id)
        if found and is_mastered(progress, found[0]) and state.due_at <= now:
            due.append((state.due_at, kp_id))
    return [kp_id for _, kp_id in sorted(due)]


def _step(progress: Progress, kp: KnowledgePoint, action: str, reason: str) -> dict[str, Any]:
    _, module = progress.find(kp.id)  # type: ignore[misc]
    gate = "qualitative" if kp.type in QUALITATIVE_TYPES else "quantitative"
    return {
        "action": action,
        "module_id": module.id,
        "module_name": module.name,
        "module_objective": module.objective,
        "knowledge_point_id": kp.id,
        "knowledge_point_name": kp.name,
        "knowledge_point_type": kp.type.value,
        "status": status(progress, kp),
        "gate": gate,
        "mastery": round(mastery(progress, kp), 3),
        "threshold": QUANTITATIVE_GATE.get(kp.type, 1.0),
        "reason": reason,
    }


def next_step(progress: Progress, now: float, demo: bool = False) -> dict[str, Any]:
    """Precedence: open question > due review > first unmastered objective > complete."""
    if demo:
        return {
            "action": "demo",
            "reason": "Follow the current request. Reuse matching material; after grading, give brief feedback and wait unless another step was requested.",
            **({"pending_question": progress.pending.public()} if progress.pending else {}),
        }
    if not progress.modules:
        return {"action": "outline", "reason": "No outline yet; agree one with tutor_build."}

    if progress.pending is not None:
        kp, _ = progress.find(progress.pending.knowledge_point_id)  # type: ignore[misc]
        step = _step(progress, kp, "answer_pending", "A posed question awaits an answer; grade it.")
        step["pending_question"] = progress.pending.public()
        return step

    deferred = set(progress.deferred)
    for kp_id in due_reviews(progress, now):
        if kp_id not in deferred:
            kp, _ = progress.find(kp_id)  # type: ignore[misc]
            return _step(progress, kp, "review", "Spaced-repetition review is due.")

    fallback: dict[str, Any] | None = None
    for module in progress.modules:
        for kp in module.knowledge_points:
            if is_mastered(progress, kp):
                continue
            state = status(progress, kp)
            if state == "new":
                teach_first = (
                    progress.profile is not None
                    and progress.profile.teaching_strategy == "teach_first"
                )
                action = "teach" if teach_first else "probe"
                reason = (
                    "Untouched objective; teach before assessing, as the learner asked."
                    if teach_first
                    else "Untouched objective; probe first so the learner can test out."
                )
            elif kp.type in QUALITATIVE_TYPES:
                action, reason = "assess", "Below the gate; ask for an own-words explanation."
            else:
                action, reason = "practice", "Below the gate; keep working it until it clears."
            step = _step(progress, kp, action, reason)
            if kp.id in deferred:
                fallback = fallback or step
                continue
            return step

    if fallback is not None:
        return fallback
    return {"action": "complete", "reason": "All objectives are mastered and no reviews are due."}


def map_summary(progress: Progress) -> list[dict[str, Any]]:
    return [
        {
            "id": m.id,
            "name": m.name,
            "objective": m.objective,
            "knowledge_points": [
                {
                    "id": kp.id,
                    "name": kp.name,
                    "type": kp.type.value,
                    "status": status(progress, kp),
                    "mastery": round(mastery(progress, kp), 3),
                }
                | ({"chapter": kp.chapter} if kp.chapter else {})
                for kp in m.knowledge_points
            ],
        }
        for m in progress.modules
    ]
