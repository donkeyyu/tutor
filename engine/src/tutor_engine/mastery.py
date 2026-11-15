"""Mastery score. Ported from DeepTutor ``deeptutor/learning/mastery.py``.

Recency-weighted accuracy over the last five attempts, capped while evidence
is thin so one or two lucky answers cannot master a point. Replace this one
function to plug in a richer model (BKT, IRT); callers do not change.
"""

from __future__ import annotations

_RECENCY_WEIGHTS: tuple[float, ...] = (0.5, 0.7, 0.85, 0.95, 1.0)
_CONFIDENCE_CAP: dict[int, float] = {1: 0.5, 2: 0.8}


def compute_mastery(scores: list[float]) -> float:
    if not scores:
        return 0.0
    recent = scores[-len(_RECENCY_WEIGHTS) :]
    weights = _RECENCY_WEIGHTS[-len(recent) :]
    value = sum(w * max(0.0, min(1.0, float(s))) for s, w in zip(recent, weights)) / sum(weights)
    return min(value, _CONFIDENCE_CAP.get(len(recent), 1.0))
