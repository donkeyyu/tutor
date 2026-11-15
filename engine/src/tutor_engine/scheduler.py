"""Spaced-repetition review timing.

Uses DeepTutor's per-type interval ladders (``learning/scheduler.py``), but not
its stability/difficulty model. Memory's 0-day first rung is dropped so a
just-mastered fact is not reviewed in the same breath.
"""

from __future__ import annotations

from tutor_engine.models import KnowledgeType, ReviewState

DAY = 86400.0

INTERVAL_DAYS: dict[KnowledgeType, tuple[int, ...]] = {
    KnowledgeType.MEMORY: (1, 3, 7, 14, 30, 60),
    KnowledgeType.CONCEPT: (3, 7, 14, 30),
    KnowledgeType.PROCEDURE: (3, 7, 14),
    KnowledgeType.DESIGN: (14, 28),
}


def schedule(
    state: ReviewState | None, kp_type: KnowledgeType, passed: bool, now: float
) -> ReviewState:
    """Next review state after one assessed outcome on a mastered objective.

    A pass before the item is due refreshes nothing: repetition in one sitting
    must not push the next review out. A pass when due climbs one rung. A miss
    drops back to the first rung.
    """
    ladder = INTERVAL_DAYS[kp_type]
    if state is None:
        return ReviewState(0, now + ladder[0] * DAY, now)
    if not passed:
        return ReviewState(0, now + ladder[0] * DAY, now)
    if now < state.due_at:
        return state
    index = min(state.interval_index + 1, len(ladder) - 1)
    return ReviewState(index, now + ladder[index] * DAY, now)
