"""Tool-level operations. One method per plugin tool; each is one transaction."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import time
from typing import Any

from tutor_engine import bank as bank_mod
from tutor_engine import paper as paper_mod
from tutor_engine import policy, scheduler, teaching
from tutor_engine.grading import grade as grade_answer
from tutor_engine.models import (
    PROFILE_TEXT_FIELDS,
    QUALITATIVE_TYPES,
    Attempt,
    KnowledgePoint,
    KnowledgeType,
    Module,
    PendingQuestion,
    Profile,
    Progress,
    TutorError,
)
from tutor_engine.store import Store
from tutor_engine.text import contains_quote
from tutor_engine.textbook import Library

_ID = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


@dataclass
class Tutor:
    store: Store
    bank_path: Path
    sources_dir: Path | None
    learner: str
    course: str
    clock: Any = time.time
    library: Library | None = None

    def _bank(self) -> dict[str, bank_mod.Question]:
        return bank_mod.load_bank(self.bank_path, self.sources_dir)

    def _library(self) -> Library:
        if self.library is None:
            raise TutorError("No textbook vault is configured; set it in the tutor plugin settings.")
        return self.library

    def _tx(self):
        return self.store.transaction(self.learner, self.course)

    @staticmethod
    def _require_kp(progress: Progress, kp_id: str) -> KnowledgePoint:
        found = progress.find(kp_id)
        if found is None:
            raise TutorError(f"Unknown knowledge_point_id {kp_id!r}; read it from tutor_status.")
        return found[0]

    # -- read ---------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        bank = self._bank()
        with self._tx() as progress:
            step = policy.next_step(progress, self.clock())
            kp_id = step.get("knowledge_point_id", "")
            if kp_id:
                kp = self._require_kp(progress, kp_id)
                step["bank_questions"] = len(
                    bank_mod.poseable(bank, kp.question_ids, kp.type in QUALITATIVE_TYPES)
                )
                if kp.chapter:
                    step["chapter"] = kp.chapter
            return {
                "next": step,
                "intake_needed": progress.profile is None,
                "profile": None
                if progress.profile is None
                else {f: getattr(progress.profile, f) for f in PROFILE_TEXT_FIELDS}
                | {"teaching_strategy": progress.profile.teaching_strategy},
                "teaching": teaching.guidance(progress.profile, kp_id) if kp_id else {},
                "outline": policy.map_summary(progress),
                "bank_size": len(bank),
                "unverified_bank_questions": sum(
                    q.key_status == "unverified" for q in bank.values()
                ),
            }

    def bank_search(
        self,
        query: str = "",
        subject: str = "",
        types: list[str] | None = None,
        difficulty: int | None = None,
        limit: int = 20,
        detail: bool = False,
    ) -> dict[str, Any]:
        return bank_mod.search(self._bank(), query, subject, types or (), difficulty, limit, detail)

    def paper(
        self, title: str, scope: str, knowledge_points: list[dict[str, Any]],
        subject: str = "", grade: str = "", count: int = 10,
        duration_minutes: int | None = None,
    ) -> dict[str, Any]:
        return paper_mod.assemble(
            self._bank(), title, scope, knowledge_points, subject, grade, count, duration_minutes
        )

    def textbook(
        self, action: str = "list", query: str = "", ref: str = "", page: int | None = None,
        limit: int = 10,
    ) -> dict[str, Any]:
        library = self._library()
        if action == "list":
            return library.list()
        if action == "search":
            return library.search(query, limit)
        if action == "read":
            return library.read(ref, page)
        raise TutorError("action must be list, search or read")

    # -- outline ------------------------------------------------------------

    def build(self, modules: list[dict[str, Any]]) -> dict[str, Any]:
        if not isinstance(modules, list) or not modules:
            raise TutorError("modules must be a non-empty list")
        bank = self._bank()
        refs = {
            str(kp.get("chapter") or "")
            for m in modules if isinstance(m, dict)
            for kp in m.get("knowledge_points") or [] if isinstance(kp, dict)
        } - {""}
        if refs:
            library = self._library()
            books = library.books()
            for ref in sorted(refs):
                library.chapter(books, ref)
        with self._tx() as progress:
            built: list[Module] = []
            ids: set[str] = set()

            def take(requested: Any, fallback: str) -> str:
                value = str(requested or fallback)
                if not _ID.match(value) or value in ids:
                    raise TutorError(f"id {value!r} is invalid or duplicated")
                ids.add(value)
                return value

            for mi, raw in enumerate(modules):
                name = str(raw.get("name", "")).strip()
                kps = raw.get("knowledge_points")
                if not name or not isinstance(kps, list) or not kps:
                    raise TutorError(f"module {mi + 1} needs a name and knowledge_points")
                module_id = take(raw.get("id"), f"m{mi}")
                points = []
                for ki, kp in enumerate(kps):
                    kp_name = str(kp.get("name", "")).strip()
                    try:
                        kp_type = KnowledgeType(str(kp.get("type", "concept")))
                    except ValueError as exc:
                        raise TutorError(
                            f"{kp_name or 'knowledge point'}: type must be memory, "
                            "procedure, concept or design"
                        ) from exc
                    if not kp_name:
                        raise TutorError(f"module {mi + 1} point {ki + 1} needs a name")
                    linked = [str(i) for i in kp.get("question_ids") or []]
                    unknown = [i for i in linked if i not in bank]
                    if unknown:
                        raise TutorError(
                            f"{kp_name}: unknown question ids {unknown[:5]}; "
                            "find real ids with tutor_bank_search"
                        )
                    points.append(
                        KnowledgePoint(
                            take(kp.get("id"), f"{module_id}_kp{ki}"),
                            kp_name,
                            kp_type,
                            list(dict.fromkeys(linked)),
                            str(kp.get("chapter") or ""),
                        )
                    )
                built.append(
                    Module(module_id, name, str(raw.get("objective", "")).strip(), points)
                )

            new_ids = {kp.id for m in built for kp in m.knowledge_points}
            dropped = [
                kp.name
                for m in progress.modules
                for kp in m.knowledge_points
                if kp.id not in new_ids and policy.is_mastered(progress, kp)
            ]
            if dropped:
                raise TutorError(
                    f"Refusing to drop mastered objectives: {dropped}. Keep their ids, "
                    "or add new objectives instead of erasing earned work."
                )
            if progress.pending and progress.pending.knowledge_point_id not in new_ids:
                progress.pending = None
            progress.modules = built
            progress.deferred = [d for d in progress.deferred if d in new_ids]
            return {
                "outline": policy.map_summary(progress),
                "without_poseable_questions": sorted(
                    kp.id
                    for m in built
                    for kp in m.knowledge_points
                    if not bank_mod.poseable(bank, kp.question_ids, kp.type in QUALITATIVE_TYPES)
                ),
            }

    # -- assessment ---------------------------------------------------------

    def quiz(self, knowledge_point_id: str = "") -> dict[str, Any]:
        bank = self._bank()
        now = self.clock()
        with self._tx() as progress:
            if progress.pending is not None:
                return {"reposed": True, "question": progress.pending.public()}
            step = policy.next_step(progress, now)
            kp_id = knowledge_point_id or step.get("knowledge_point_id", "")
            if not kp_id:
                raise TutorError(f"Nothing to quiz: next action is {step['action']!r}.")
            kp = self._require_kp(progress, kp_id)
            history = [
                (a.question_id, a.score) for a in progress.attempts if a.knowledge_point_id == kp_id
            ]
            qualitative = kp.type in QUALITATIVE_TYPES
            candidates = bank_mod.poseable(bank, kp.question_ids, qualitative)
            if not policy.is_mastered(progress, kp):
                # A repeat of a question already answered right proves only that
                # the learner remembers that answer. Since the last miss, each
                # question counts once; a missed question may be retried.
                streak: set[str] = set()
                for a in reversed(progress.attempts):
                    if a.knowledge_point_id != kp_id or a.judged:
                        continue
                    if a.score < 1.0:
                        break
                    streak.add(a.question_id)
                fresh = [c for c in candidates if c.id not in streak]
                if candidates and not fresh:
                    raise TutorError(
                        f"All {len(candidates)} linked question(s) were answered right since the "
                        "last miss; a repeat proves nothing. Link more with tutor_bank_search + "
                        "tutor_build, or offer to tutor_defer this objective."
                    )
                candidates = fresh
            q = bank_mod.pick(
                candidates,
                history,
                set(progress.skipped),
                prefer_open=qualitative,
            )
            progress.pending = PendingQuestion(
                question_id=q.id,
                knowledge_point_id=kp.id,
                question_type=q.type,
                material=q.material,
                prompt=q.content,
                options=q.options,
                answer=q.answer,
                explanation=q.explanation,
                difficulty=q.difficulty,
                review=policy.is_mastered(progress, kp),
                created_at=now,
            )
            return {"reposed": False, "question": progress.pending.public()}

    def _after_outcome(self, progress: Progress, kp: KnowledgePoint, passed: bool, now: float):
        if policy.is_mastered(progress, kp):
            progress.reviews[kp.id] = scheduler.schedule(
                progress.reviews.get(kp.id), kp.type, passed, now
            )
            if kp.id in progress.deferred:
                progress.deferred.remove(kp.id)
        elif kp.id in progress.reviews:
            progress.reviews[kp.id] = scheduler.schedule(
                progress.reviews[kp.id], kp.type, False, now
            )

    def grade(
        self, answer: str = "", blanks: list[str] | None = None, verdict: str = ""
    ) -> dict[str, Any]:
        """Grade the open question.

        Auto-graded types are scored by code in one call. An ``open`` question
        takes two calls: first the learner's answer (the engine reveals the
        reference), then the tutor's ``verdict``. A verdict is evidence only for
        concept/design objectives; it never feeds the numeric gate.
        """
        now = self.clock()
        with self._tx() as progress:
            pending = progress.pending
            if pending is None:
                raise TutorError("No open question to grade.")
            kp = self._require_kp(progress, pending.knowledge_point_id)

            if pending.question_type == "open":
                if pending.learner_answer is None:
                    if verdict:
                        raise TutorError(
                            "Send the learner's answer first; judge only after seeing the reference."
                        )
                    if not answer.strip():
                        raise TutorError("answer is empty; pass the learner's answer verbatim.")
                    pending.learner_answer = answer
                    return {
                        "needs_judgement": True,
                        "reference_answer": pending.answer,
                        "explanation": pending.explanation,
                        "instruction": (
                            "Compare the learner's answer with the reference on substance, "
                            "then call tutor_grade with verdict correct, partial or incorrect."
                        ),
                    }
                scores = {"correct": 1.0, "partial": 0.5, "incorrect": 0.0}
                if verdict not in scores:
                    raise TutorError("verdict must be correct, partial or incorrect.")
                score = scores[verdict]
                progress.attempts.append(
                    Attempt(
                        kp.id, pending.question_id, score, pending.learner_answer,
                        pending.review, now, judged=True,
                    )
                )
                if kp.type in QUALITATIVE_TYPES:
                    progress.qualitative[kp.id] = score >= 1.0
            else:
                if verdict:
                    raise TutorError("This question is graded by code; do not pass a verdict.")
                score = grade_answer(pending, answer, blanks or [])
                given = " | ".join(blanks) if blanks else answer
                progress.attempts.append(
                    Attempt(kp.id, pending.question_id, score, given, pending.review, now)
                )

            progress.pending = None
            self._after_outcome(progress, kp, score >= 1.0, now)
            return {
                "correct": score >= 1.0,
                "score": score,
                "expected_answer": pending.answer,
                "explanation": pending.explanation,
                "mastery": round(policy.mastery(progress, kp), 3),
                "mastered": policy.is_mastered(progress, kp),
                "next": policy.next_step(progress, now),
            }

    def assess(
        self, knowledge_point_id: str, passed: bool, learner_quote: str, learner_message: str
    ) -> dict[str, Any]:
        now = self.clock()
        with self._tx() as progress:
            kp = self._require_kp(progress, knowledge_point_id)
            if kp.type not in QUALITATIVE_TYPES:
                raise TutorError(
                    f"{kp.name!r} is {kp.type.value}; its gate is tutor_quiz + tutor_grade."
                )
            if progress.pending is not None:
                raise TutorError("Grade or skip the open question first.")
            if not contains_quote(learner_message, learner_quote):
                raise TutorError("learner_quote must be a literal quote from learner_message.")
            progress.qualitative[kp.id] = bool(passed)
            progress.attempts.append(
                Attempt(kp.id, "assess", 1.0 if passed else 0.0, learner_quote, False, now)
            )
            self._after_outcome(progress, kp, bool(passed), now)
            return {"mastered": policy.is_mastered(progress, kp), "next": policy.next_step(progress, now)}

    def skip(self) -> dict[str, Any]:
        with self._tx() as progress:
            if progress.pending is None:
                raise TutorError("No open question to skip.")
            progress.skipped.append(progress.pending.question_id)
            progress.pending = None
            return {"skipped": True, "next": policy.next_step(progress, self.clock())}

    def defer(self, knowledge_point_id: str) -> dict[str, Any]:
        with self._tx() as progress:
            kp = self._require_kp(progress, knowledge_point_id)
            if policy.is_mastered(progress, kp):
                raise TutorError("Already mastered; nothing to defer.")
            if progress.pending and progress.pending.knowledge_point_id == kp.id:
                progress.pending = None
            if kp.id not in progress.deferred:
                progress.deferred.append(kp.id)
            return {"deferred": kp.id, "next": policy.next_step(progress, self.clock())}

    # -- profile ------------------------------------------------------------

    def profile(self, fields: dict[str, Any]) -> dict[str, Any]:
        with self._tx() as progress:
            current = progress.profile or Profile()
            for key, value in fields.items():
                if key in PROFILE_TEXT_FIELDS:
                    text = str(value).strip()
                    if len(text) > 500:
                        raise TutorError(f"{key} is longer than 500 characters")
                    setattr(current, key, text)
                elif key == "teaching_strategy":
                    if value not in {"probe_first", "teach_first"}:
                        raise TutorError("teaching_strategy must be probe_first or teach_first")
                    current.teaching_strategy = value
                else:
                    raise TutorError(f"Unknown profile field {key!r}")
            progress.profile = current
            return {"profile": {f: getattr(current, f) for f in PROFILE_TEXT_FIELDS}}

    def note(self, updates: list[dict[str, Any]], learner_message: str) -> dict[str, Any]:
        with self._tx() as progress:
            current = progress.profile or Profile()
            teaching.apply_updates(current, updates, learner_message, progress.kp_ids())
            progress.profile = current
            return {
                "preferences": len(current.teaching_preferences),
                "observations": len(current.teaching_observations),
            }
