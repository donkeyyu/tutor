from __future__ import annotations

import json
import subprocess
import sys

import pytest

from conftest import outline, q
from tutor_engine import bank
from tutor_engine.mastery import compute_mastery
from tutor_engine.models import TutorError
from tutor_engine.scheduler import DAY

OPEN = {"id": "o1", "type": "open", "content": "Why do capitals exist?", "answer": "To seat government."}


def test_mastery_needs_three_answers_to_clear_the_gate():
    assert compute_mastery([1.0]) == 0.5
    assert compute_mastery([1.0, 1.0]) == 0.8
    assert compute_mastery([1.0, 1.0, 1.0]) >= 0.9
    assert compute_mastery([1.0, 1.0, 0.0]) < 0.9


def test_full_loop_quiz_grade_master_then_review(make_tutor):
    tutor = make_tutor([q("q1", difficulty=1), q("q2"), q("q3", difficulty=3)])
    assert tutor.status()["next"]["action"] == "outline"
    tutor.build(outline(["q1", "q2", "q3"]))
    assert tutor.status()["next"]["action"] == "probe"

    posed = tutor.quiz()
    assert "Paris" not in json.dumps(posed)  # the key never leaves the engine
    assert posed["question"]["blanks"] == 1
    assert tutor.quiz()["reposed"] is True  # an open question cannot be swapped

    for _ in range(3):
        if tutor.status()["next"]["action"] != "answer_pending":
            tutor.quiz()
        result = tutor.grade(blanks=[" <p>paris.</p> "])
        assert result["correct"]
    assert result["mastered"] is True
    assert result["next"]["knowledge_point_id"] == "idea"

    tutor.clock_ref.now += 2 * DAY
    step = tutor.status()["next"]
    assert (step["action"], step["knowledge_point_id"]) == ("review", "fact")


@pytest.mark.parametrize(
    ("row", "answer", "blanks", "score"),
    [
        ({"type": "single", "options": ["Lyon", "Paris"], "answer": "B"}, "b", None, 1.0),
        ({"type": "single", "options": ["Lyon", "Paris"], "answer": "B"}, "<p>Paris</p>", None, 1.0),
        ({"type": "single", "options": ["Lyon", "Paris"], "answer": "B"}, "A", None, 0.0),
        ({"type": "multi", "options": ["a", "b", "c", "d"], "answer": "AC"}, "C、A", None, 1.0),
        ({"type": "multi", "options": ["a", "b", "c", "d"], "answer": "AC"}, "A", None, 0.0),
        ({"type": "judge", "answer": "F"}, "错误", None, 1.0),
        ({"type": "judge", "answer": "F"}, "√", None, 0.0),
        ({"type": "blank", "answer": ["收缩", "舒张"]}, "", ["收缩", "收缩"], 0.5),
    ],
)
def test_code_grading_by_type(make_tutor, row, answer, blanks, score):
    tutor = make_tutor([{"id": "x", "content": "?", **row}])
    tutor.build(outline(["x"]))
    tutor.quiz()
    assert tutor.grade(answer=answer, blanks=blanks)["score"] == score


def test_open_question_is_judged_in_two_steps_and_skips_numeric_gate(make_tutor):
    tutor = make_tutor([q("q1"), OPEN])
    tutor.build(outline(["q1", "o1"], ["o1"]))
    tutor.defer("fact")
    posed = tutor.quiz()["question"]
    assert posed["question_id"] == "o1" and "government" not in json.dumps(posed)
    with pytest.raises(TutorError, match="answer first"):
        tutor.grade(verdict="correct")
    reveal = tutor.grade(answer="So the government has a home")
    assert reveal["needs_judgement"] and reveal["reference_answer"] == "To seat government."
    result = tutor.grade(verdict="correct")
    assert result["mastered"] is True  # concept objective: a judged pass counts

    # On a memory objective, judged verdicts never count toward the 0.9 gate.
    assert [c.id for c in bank.poseable(tutor._bank(), ["q1", "o1"], qualitative=False)] == ["q1"]


def test_qualitative_gate_needs_assess_with_literal_quote(make_tutor):
    tutor = make_tutor([q("q1")])
    tutor.build(outline(["q1"]))
    with pytest.raises(TutorError, match="literal quote"):
        tutor.assess("idea", True, "made up", "capitals hold government")
    with pytest.raises(TutorError, match="tutor_quiz"):
        tutor.assess("fact", True, "x", "x")
    assert tutor.assess("idea", True, "hold government", "capitals hold government")["mastered"]


def test_step_order_teach_first_and_defer(make_tutor):
    tutor = make_tutor([q("q1")])
    tutor.build(outline(["q1"]))
    tutor.profile({"teaching_strategy": "teach_first"})
    assert tutor.status()["next"]["action"] == "teach"
    tutor.defer("fact")
    assert tutor.status()["next"]["knowledge_point_id"] == "idea"
    tutor.assess("idea", True, "ok", "ok")
    assert tutor.status()["next"]["knowledge_point_id"] == "fact"  # deferred comes back last


def test_unverified_bank_question_is_never_posed(make_tutor):
    tutor = make_tutor(
        [
            q("bad", source={"path": "geo.txt", "quote": "Lyon is the capital"}),
            q("good", source={"path": "geo.txt", "quote": "Paris is the capital of France."}),
        ]
    )
    tutor.build(outline(["bad", "good"]))
    assert tutor.status()["unverified_bank_questions"] == 1
    assert tutor.quiz()["question"]["question_id"] == "good"
    tutor.grade(blanks=["Lyon"])
    assert tutor.quiz()["question"]["question_id"] == "good"  # only poseable one


def test_question_answered_right_is_not_reposed_until_mastered(make_tutor):
    tutor = make_tutor([q("q1"), q("q2")])
    tutor.build(outline(["q1", "q2"]))
    first = tutor.quiz()["question"]["question_id"]
    tutor.grade(blanks=["Lyon"])
    assert tutor.quiz()["question"]["question_id"] != first
    tutor.grade(blanks=["Paris"])
    assert tutor.quiz()["question"]["question_id"] == first  # a miss may be retried
    tutor.grade(blanks=["Paris"])
    with pytest.raises(TutorError, match="Link more"):
        tutor.quiz()


def test_picker_prefers_unseen_and_adapts_difficulty(make_tutor):
    rows = [q("easy", difficulty=1), q("mid"), q("hard", difficulty=3), q("easy2", difficulty=1)]
    tutor = make_tutor(rows)
    tutor.build(outline([r["id"] for r in rows]))
    assert tutor.quiz()["question"]["question_id"] == "mid"
    tutor.grade(blanks=["wrong"])
    assert tutor.quiz()["question"]["difficulty"] == 1
    tutor.skip()
    assert tutor.quiz()["question"]["question_id"] == "easy2"


def test_build_checks_links_and_keeps_mastered_work(make_tutor):
    tutor = make_tutor([q("q1")])
    with pytest.raises(TutorError, match="unknown question ids"):
        tutor.build(outline(["nope"]))
    assert tutor.build(outline(["q1"]))["without_poseable_questions"] == ["idea"]
    tutor.assess("idea", True, "ok", "ok")
    with pytest.raises(TutorError, match="mastered"):
        tutor.build([{"name": "New", "knowledge_points": [{"name": "Other", "type": "memory"}]}])


def test_bank_search_filters_and_matches_all_words(make_tutor):
    tutor = make_tutor(
        [
            q("v1", subject="math", content="<p>向量 \\(a\\) 与 b 共线</p>"),
            q("v2", subject="math", content="<p>向量的模</p>"),
            q("p1", subject="physics", content="<p>向量 共线</p>"),
        ]
    )
    found = tutor.bank_search(query="向量 共线", subject="math")
    assert found["total"] == 1 and found["questions"][0]["id"] == "v1"


def test_teaching_notes_require_learner_evidence(make_tutor):
    tutor = make_tutor([q("q1")])
    tutor.build(outline(["q1"]))
    pref = {"kind": "preference", "op": "upsert", "key": "examples", "text": "Use examples"}
    with pytest.raises(TutorError, match="explicit learner request"):
        tutor.note([pref], "please use examples")
    with pytest.raises(TutorError, match="literal quote"):
        tutor.note([{**pref, "basis": "learner_report", "evidence": "I love maps"}], "use examples")
    tutor.note([{**pref, "basis": "learner_report", "evidence": "use examples"}], "please use examples")
    obs = {"kind": "observation", "op": "upsert", "key": "o1", "text": "t", "knowledge_point_id": "nope"}
    with pytest.raises(TutorError, match="outline"):
        tutor.note([obs], "")
    assert tutor.status()["teaching"]["teaching_preferences"] == {"examples": "Use examples"}


def test_cli_round_trip(tmp_path):
    bank = tmp_path / "bank.jsonl"
    bank.write_text(json.dumps(q("q1")), encoding="utf-8")
    base = [sys.executable, "-m", "tutor_engine", "--db", str(tmp_path / "t.db"),
            "--bank", str(bank), "--learner", "a", "--course", "c"]

    def run(cmd: str, params: dict) -> dict:
        out = subprocess.run([*base, cmd], input=json.dumps(params), capture_output=True, text=True)
        return json.loads(out.stdout)

    assert run("build", {"modules": outline(["q1"])})["ok"]
    assert run("quiz", {})["result"]["question"]["question_id"] == "q1"
    assert run("grade", {"blanks": ["Paris"]})["result"]["correct"] is True
    assert run("grade", {"answer": "Paris"}) == {"ok": False, "error": "No open question to grade."}
