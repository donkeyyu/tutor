"""Persisted learner state for one (learner, course) pair.

The whole state is one JSON document so every tool call is a single atomic
read-modify-write in ``store.py``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
import time
from typing import Any


class TutorError(Exception):
    """An expected refusal; its message is shown to the model verbatim."""


class KnowledgeType(str, Enum):
    MEMORY = "memory"  # facts
    PROCEDURE = "procedure"  # step-by-step skills
    CONCEPT = "concept"  # ideas to understand
    DESIGN = "design"  # open-ended judgement


QUALITATIVE_TYPES = frozenset({KnowledgeType.CONCEPT, KnowledgeType.DESIGN})


@dataclass
class KnowledgePoint:
    id: str
    name: str
    type: KnowledgeType
    question_ids: list[str] = field(default_factory=list)  # linked bank questions
    chapter: str = ""  # textbook chapter ref, <textbook_id>/<chapter_id>


@dataclass
class Module:
    id: str
    name: str
    objective: str = ""
    knowledge_points: list[KnowledgePoint] = field(default_factory=list)


@dataclass
class Attempt:
    knowledge_point_id: str
    question_id: str
    score: float  # 0..1
    answer: str = ""
    review: bool = False
    timestamp: float = field(default_factory=time.time)
    judged: bool = False  # verdict by the tutor model, not by code


@dataclass
class ReviewState:
    interval_index: int
    due_at: float
    last_review_at: float


@dataclass
class PendingQuestion:
    question_id: str
    knowledge_point_id: str
    question_type: str  # single | multi | judge | blank | open
    material: str
    prompt: str
    options: list[str]
    answer: str | list[str]  # server-side only; never returned before grading
    explanation: str
    difficulty: int
    review: bool = False
    created_at: float = field(default_factory=time.time)
    # Open questions: the learner's answer, held while the tutor judges it.
    learner_answer: str | None = None

    def public(self) -> dict[str, Any]:
        return {
            "question_id": self.question_id,
            "knowledge_point_id": self.knowledge_point_id,
            "question_type": self.question_type,
            "material": self.material,
            "prompt": self.prompt,
            "options": {chr(ord("A") + i): body for i, body in enumerate(self.options)},
            "blanks": len(self.answer) if self.question_type == "blank" else 0,
            "difficulty": self.difficulty,
            "awaiting_judgement": self.learner_answer is not None,
        }


@dataclass
class TeachingPreference:
    text: str
    evidence: str
    updated_at: float = field(default_factory=time.time)


@dataclass
class TeachingObservation:
    knowledge_point_id: str
    text: str
    basis: str = "tentative"  # learner_report | tentative
    strategy: str = ""
    outcome: str = "unknown"  # unknown | helped | not_helped
    evidence: str = ""
    updated_at: float = field(default_factory=time.time)


@dataclass
class Profile:
    prior_knowledge: str = ""
    target_level: str = ""
    time_budget: str = ""
    preferences: str = ""
    teaching_strategy: str = "probe_first"  # probe_first | teach_first
    notes: str = ""
    teaching_preferences: dict[str, TeachingPreference] = field(default_factory=dict)
    teaching_observations: dict[str, TeachingObservation] = field(default_factory=dict)


PROFILE_TEXT_FIELDS = (
    "prior_knowledge",
    "target_level",
    "time_budget",
    "preferences",
    "notes",
)


@dataclass
class Progress:
    modules: list[Module] = field(default_factory=list)
    attempts: list[Attempt] = field(default_factory=list)
    qualitative: dict[str, bool] = field(default_factory=dict)
    reviews: dict[str, ReviewState] = field(default_factory=dict)
    deferred: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # question ids, no credit
    profile: Profile | None = None
    pending: PendingQuestion | None = None

    def find(self, kp_id: str) -> tuple[KnowledgePoint, Module] | None:
        for module in self.modules:
            for kp in module.knowledge_points:
                if kp.id == kp_id:
                    return kp, module
        return None

    def kp_ids(self) -> set[str]:
        return {kp.id for m in self.modules for kp in m.knowledge_points}

    def scores(self, kp_id: str) -> list[float]:
        """Code-graded scores only; judged attempts never feed the numeric gate."""
        return [a.score for a in self.attempts if a.knowledge_point_id == kp_id and not a.judged]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Progress:
        profile = raw.get("profile")
        pending = raw.get("pending")
        return cls(
            modules=[
                Module(
                    id=m["id"],
                    name=m["name"],
                    objective=m.get("objective", ""),
                    knowledge_points=[
                        KnowledgePoint(
                            k["id"],
                            k["name"],
                            KnowledgeType(k["type"]),
                            k.get("question_ids", []),
                            k.get("chapter", ""),
                        )
                        for k in m["knowledge_points"]
                    ],
                )
                for m in raw.get("modules", [])
            ],
            attempts=[Attempt(**a) for a in raw.get("attempts", [])],
            qualitative=dict(raw.get("qualitative", {})),
            reviews={k: ReviewState(**v) for k, v in raw.get("reviews", {}).items()},
            deferred=list(raw.get("deferred", [])),
            skipped=list(raw.get("skipped", [])),
            profile=None
            if profile is None
            else Profile(
                **{
                    **profile,
                    "teaching_preferences": {
                        k: TeachingPreference(**v)
                        for k, v in profile.get("teaching_preferences", {}).items()
                    },
                    "teaching_observations": {
                        k: TeachingObservation(**v)
                        for k, v in profile.get("teaching_observations", {}).items()
                    },
                }
            ),
            pending=None if pending is None else PendingQuestion(**pending),
        )
