"""Evidence-backed teaching notes. Ported from DeepTutor ``learning/teaching.py``.

The tutor interprets the conversation; this layer checks structure, scope and
provenance. It never infers understanding and never awards mastery.
"""

from __future__ import annotations

import re
import time
from typing import Any

from tutor_engine.models import Profile, TeachingObservation, TeachingPreference, TutorError
from tutor_engine.text import contains_quote

_KEY = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_PREFERENCES = 6
MAX_OBSERVATIONS = 12


def _text(item: dict[str, Any], name: str, limit: int) -> str:
    value = str(item.get(name, "") or "").strip()
    if len(value) > limit:
        raise TutorError(f"{name} is longer than {limit} characters")
    return value


def apply_updates(
    profile: Profile, raw: list[dict[str, Any]], learner_message: str, objective_ids: set[str]
) -> None:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 6:
        raise TutorError("updates must hold 1 to 6 operations")
    seen: set[tuple[str, str]] = set()
    prefs = dict(profile.teaching_preferences)
    obs = dict(profile.teaching_observations)
    for item in raw:
        kind, op, key = item.get("kind"), item.get("op"), str(item.get("key", ""))
        if kind not in {"preference", "observation"} or op not in {"upsert", "remove"}:
            raise TutorError("kind must be preference|observation and op upsert|remove")
        if not _KEY.match(key):
            raise TutorError("key must be 1-64 chars of letters, digits, _ or -")
        if (kind, key) in seen:
            raise TutorError("update each teaching key only once per batch")
        seen.add((kind, key))
        target: dict[str, Any] = prefs if kind == "preference" else obs
        if op == "remove":
            target.pop(key, None)
            continue

        text = _text(item, "text", 400)
        evidence = _text(item, "evidence", 300)
        basis = item.get("basis", "tentative")
        if not text:
            raise TutorError("upsert needs text")
        if basis not in {"learner_report", "tentative"}:
            raise TutorError("basis must be learner_report or tentative")
        if evidence and not contains_quote(learner_message, evidence):
            raise TutorError("evidence must be a literal quote from the current learner message")
        if basis == "learner_report" and not evidence:
            raise TutorError("learner_report needs a quoted learner statement as evidence")

        if kind == "preference":
            if basis != "learner_report":
                raise TutorError("a preference requires an explicit learner request")
            target[key] = TeachingPreference(text=text, evidence=evidence)
            continue

        kp_id = _text(item, "knowledge_point_id", 200)
        strategy = _text(item, "strategy", 300)
        outcome = item.get("outcome", "unknown")
        if kp_id not in objective_ids:
            raise TutorError("an observation must name a knowledge_point_id in the outline")
        if outcome not in {"unknown", "helped", "not_helped"}:
            raise TutorError("outcome must be unknown, helped or not_helped")
        if outcome != "unknown" and (basis != "learner_report" or not strategy):
            raise TutorError("a strategy outcome needs the strategy and learner evidence")
        target[key] = TeachingObservation(
            knowledge_point_id=kp_id,
            text=text,
            basis=basis,
            strategy=strategy,
            outcome=outcome,
            evidence=evidence,
            updated_at=time.time(),
        )
    if len(prefs) > MAX_PREFERENCES or len(obs) > MAX_OBSERVATIONS:
        raise TutorError(
            f"limit is {MAX_PREFERENCES} preferences and {MAX_OBSERVATIONS} observations; "
            "remove obsolete entries"
        )
    profile.teaching_preferences = prefs
    profile.teaching_observations = obs


def guidance(profile: Profile | None, kp_id: str) -> dict[str, Any]:
    """Explicit preferences plus the three freshest notes for the current objective."""
    if profile is None:
        return {}
    notes = sorted(
        (
            (key, item)
            for key, item in profile.teaching_observations.items()
            if item.knowledge_point_id == kp_id
        ),
        key=lambda pair: pair[1].updated_at,
        reverse=True,
    )[:3]
    return {
        "teaching_preferences": {
            key: item.text for key, item in profile.teaching_preferences.items()
        },
        "objective_notes": [
            {
                "key": key,
                "text": item.text,
                "basis": item.basis,
                "strategy": item.strategy,
                "outcome": item.outcome,
            }
            for key, item in notes
        ],
    }
