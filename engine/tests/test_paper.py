from __future__ import annotations

from io import StringIO
import json
import sys

import pytest

from conftest import outline, q
from tutor_engine.__main__ import main
from tutor_engine.models import TutorError


def point(name: str, ids: list[str]) -> dict:
    return {"name": name, "objective": f"Apply {name}", "question_ids": ids}


def test_paper_groups_types_and_numbers_knowledge_coverage_without_keys(make_tutor):
    tutor = make_tutor([
        q("b", difficulty=3, subject="math", answer=["SECRET_BLANK"], paper="Source paper"),
        q("s1", difficulty=1, type="single", options=["first", "second"], answer="B", subject="math"),
        q("s2", difficulty=2, type="single", options=["one", "two"], answer="A", subject="math"),
        q("m", type="multi", options=["one", "two", "three"], answer="AC", subject="math"),
        q("j", difficulty=1, type="judge", answer="T", subject="math"),
        q("o", type="open", material="<p>Shared diagram and context</p>", answer="SECRET_OPEN",
          explanation="SECRET_EXPLANATION", subject="math"),
    ])
    paper = tutor.paper("章末测试", "第一章", [point("P1", ["o", "s2", "b"]), point("P2", ["m", "s1", "j"])],
                        subject="math", grade="七年级", count=6, duration_minutes=40)
    questions = paper["questions"]
    assert [p["question_id"] for p in questions] == ["s2", "s1", "m", "j", "b", "o"]
    assert [p["number"] for p in questions] == [1, 2, 3, 4, 5, 6]
    assert questions[0]["options"] == {"A": "one", "B": "two"}
    assert questions[4]["blanks"] == 1 and questions[4]["paper"] == "Source paper"
    assert questions[5]["material"] == "<p>Shared diagram and context</p>"
    assert paper["knowledge_points"][0]["question_numbers"] == [1, 5, 6]
    assert paper["knowledge_points"][1]["question_numbers"] == [2, 3, 4]
    assert paper["type_counts"] == {"single": 2, "multi": 1, "judge": 1, "blank": 1, "open": 1}
    assert paper["knowledge_points"][0]["type_counts"] == {
        "single": 1, "multi": 0, "judge": 0, "blank": 1, "open": 1,
    }
    assert paper["difficulty_counts"] == {"1": 2, "2": 3, "3": 1}
    assert paper["count"] == paper["requested_count"] == 6
    assert paper["grade"] == "七年级" and paper["duration_minutes"] == 40
    assert paper["warnings"] == []
    encoded = json.dumps(paper)
    assert "SECRET_" not in encoded
    assert all("answer" not in p and "explanation" not in p for p in questions)


def test_paper_reports_shortage_and_keeps_uncovered_points(make_tutor):
    tutor = make_tutor([q("q1")])
    paper = tutor.paper("Test", "Scope", [point("Covered", ["q1"]), point("Missing", [])], count=3)
    assert paper["count"] == 1 and paper["requested_count"] == 3
    assert paper["knowledge_points"][1]["question_numbers"] == []
    assert not any(paper["knowledge_points"][1]["type_counts"].values())
    assert len(paper["warnings"]) == 2
    empty = tutor.paper("Test", "Scope", [point("Missing", [])])
    assert empty["questions"] == [] and empty["count"] == 0
    assert not any(empty["type_counts"].values())
    assert len(empty["warnings"]) == 2


@pytest.mark.parametrize(("changes", "match"), [
    ({"title": " "}, "title"),
    ({"title": "x" * 201}, "title"),
    ({"scope": ""}, "scope"),
    ({"scope": "x" * 2001}, "scope"),
    ({"subject": ["math"]}, "subject"),
    ({"grade": "x" * 81}, "grade"),
    ({"count": 0}, "count"),
    ({"count": 51}, "count"),
    ({"count": 1.5}, "count"),
    ({"count": True}, "count"),
    ({"duration_minutes": 0}, "duration_minutes"),
    ({"duration_minutes": 361}, "duration_minutes"),
    ({"duration_minutes": True}, "duration_minutes"),
    ({"knowledge_points": []}, "knowledge_points"),
    ({"knowledge_points": [None]}, "object"),
    ({"knowledge_points": [point("", [])]}, "name"),
    ({"knowledge_points": [{"name": "P", "objective": "", "question_ids": []}]}, "objective"),
    ({"knowledge_points": [{"name": "P", "objective": "Apply", "question_ids": "q1"}]}, "question_ids"),
    ({"knowledge_points": [point("P", ["unknown"])]}, "unknown question"),
    ({"knowledge_points": [point("P", [{}])]}, "unknown question"),
    ({"knowledge_points": [point("P", ["q1", "q1"])]}, "Duplicate question"),
    ({"knowledge_points": [point("P1", ["q1"]), point("P2", ["q1"])]}, "Duplicate question"),
    ({"knowledge_points": [point("P", []), point("P", [])]}, "Duplicate knowledge"),
    ({"knowledge_points": [point("P", ["q1", "q2"])], "count": 1}, "exceeds"),
    ({"subject": "physics"}, "subject"),
])
def test_paper_rejects_invalid_specs_and_cross_subject_questions(make_tutor, changes, match):
    tutor = make_tutor([q("q1", subject="math"), q("q2", subject="math")])
    params = {"title": "Test", "scope": "Scope", "knowledge_points": [point("P", ["q1"])]}
    with pytest.raises(TutorError, match=match):
        tutor.paper(**(params | changes))


def test_paper_refuses_unverified_sources_but_accepts_verified_questions(make_tutor):
    tutor = make_tutor([
        q("bad", source={"path": "geo.txt", "quote": "Lyon is the capital"}),
        q("good", source={"path": "geo.txt", "quote": "Paris is the capital of France."}),
    ])
    with pytest.raises(TutorError, match="unverified"):
        tutor.paper("Test", "Scope", [point("P", ["bad"])])
    assert tutor.paper("Test", "Scope", [point("P", ["good"])], count=1)["count"] == 1


def test_search_detail_exposes_complete_material_and_options_without_answer(make_tutor):
    prompt = "<p>" + "Long stem " * 30 + "the final condition</p>"
    tutor = make_tutor([q("q1", type="single", content=prompt, material="Shared context",
                         options=["First option", "Second option"], answer="B",
                         explanation="SECRET_EXPLANATION", origin={"file": "private/source"})])
    summary = tutor.bank_search(query="condition")["questions"][0]
    assert "prompt" not in summary and len(summary["text"]) == 120
    detailed = tutor.bank_search(query="condition", detail=True)["questions"][0]
    assert detailed["prompt"] == prompt and detailed["material"] == "Shared context"
    assert detailed["options"] == {"A": "First option", "B": "Second option"}
    assert detailed["question_type"] == "single" and detailed["id"] == detailed["question_id"] == "q1"
    assert not {"answer", "explanation", "origin", "source"} & detailed.keys()


def test_paper_does_not_mutate_progress_or_replace_an_open_quiz(make_tutor):
    tutor = make_tutor([q("q1"), q("q2"), q("q3")])
    tutor.build(outline(["q1", "q2", "q3"]))
    tutor.profile({"prior_knowledge": "My foundation", "preferences": "Examples"})
    tutor.quiz()
    tutor.grade(blanks=["Paris"])
    pending = tutor.quiz()
    before_status = tutor.status()
    with tutor.store._connect() as connection:
        before_rows = connection.execute("SELECT * FROM progress").fetchall()
    paper = tutor.paper("Test", "Scope", [point("P", ["q1", "q2"])], count=2)
    assert paper["count"] == 2
    assert tutor.status() == before_status
    assert tutor.quiz()["question"] == pending["question"]
    with tutor.store._connect() as connection:
        assert connection.execute("SELECT * FROM progress").fetchall() == before_rows


def test_cli_paper_command_returns_the_safe_result(make_tutor, tmp_path, monkeypatch, capsys):
    tutor = make_tutor([q("q1")])
    monkeypatch.setattr(sys, "stdin", StringIO(json.dumps({
        "title": "Test", "scope": "Scope", "knowledge_points": [point("P", ["q1"])], "count": 1,
    })))
    code = main(["--db", str(tmp_path / "cli.db"), "--bank", str(tutor.bank_path),
                 "--learner", "ada", "--course", "c", "paper"])
    reply = json.loads(capsys.readouterr().out)
    assert code == 0 and reply["ok"]
    assert reply["result"]["questions"][0]["question_id"] == "q1"
    assert "answer" not in reply["result"]["questions"][0]
