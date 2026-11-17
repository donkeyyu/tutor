from __future__ import annotations

import hashlib
import json
from pathlib import Path
import stat

import pytest

from tutor_engine.models import TutorError
from tutor_engine.service import Tutor
from tutor_engine.store import Store
from tutor_engine.textbook import Library


def test_bundled_textbook_pdf_and_notes_match_the_index(tmp_path: Path):
    vault = Path(__file__).resolve().parents[2] / "data" / "textbooks"
    books = Library(vault, "教材索引", tmp_path / "cache").books()
    assert len(books) == 1
    book = next(iter(books.values()))
    assert hashlib.sha256(book.pdf.read_bytes()).hexdigest() == book.sha256
    assert (vault / "教材索引" / f"{book.sha256}.json").is_file()
    chapter_ids = {c.id for c in book.chapters}
    for chapter in book.chapters:
        assert 1 <= chapter.first <= chapter.last <= book.page_count
        assert not chapter.parent or chapter.parent in chapter_ids
    assert book.notes
    for note in book.notes:
        assert 1 <= note.page <= book.page_count
        assert note.chapter_id in chapter_ids
        assert not note.section_id or note.section_id in chapter_ids
        assert note.text and "[[" not in note.text
    zero = next(n for n in book.notes if n.title == "0 既不是正数，也不是负数")
    assert zero.page == 2 and zero.section_id == "1.1"
    opposites = next(n for n in book.notes if n.title == "相反数说的是两个数的关系")
    assert opposites.page == 12 and opposites.section_id == "1.2"


@pytest.fixture
def library(tmp_path: Path) -> Library:
    vault = tmp_path / "vault"
    (vault / "索引").mkdir(parents=True)
    pdf = vault / "book.pdf"
    pdf.write_bytes(b"%PDF fake")
    sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
    (vault / "索引" / f"{sha}.json").write_text(json.dumps({
        "version": 1, "textbook_id": "book_x", "pdf_sha256": sha, "pdf_path": "book.pdf",
        "page_count": 3,
        "chapters": [
            {"id": "ch1", "title": "第一章", "level": 1, "parent_id": None,
             "start": {"page": 1, "y": 0}, "end": {"page": 3, "y": 1}},
            {"id": "1.1", "title": "1.1 正数和负数", "level": 2, "parent_id": "ch1",
             "start": {"page": 2, "y": 0.25}, "end": {"page": 3, "y": 0}},
        ],
    }), encoding="utf-8")
    (vault / "notes").mkdir()
    (vault / "notes" / "相反意义的量.md").write_text(
        "---\ntextbook_id: book_x\npdf_page: 2\nchapter_id: ch1\nsection_id: \"1.1\"\n"
        "content_type: 知识点\n---\n[[book.pdf#page=2|返回教材原文]]\n\n"
        "> [!explanation] 理解\n> 零上与零下是[[notes/量|相反意义]]的量。\n",
        encoding="utf-8",
    )
    (vault / "notes" / "plain.md").write_text("no frontmatter", encoding="utf-8")
    fake = tmp_path / "pdftotext"
    # Full-width text, as in real textbooks; pages separated by form feeds.
    fake.write_text(
        "#!/bin/sh\nprintf '封面\\f１．１ 正数\\n和负数 －３℃\\f习题\\f'\n", encoding="utf-8"
    )
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    return Library(vault, "索引", tmp_path / "cache", str(fake))


def test_list_search_and_read(library: Library):
    chapters = library.list()["textbooks"][0]["chapters"]
    # end at y=0 excludes that page
    assert [(c["ref"], c["pages"], c["notes"]) for c in chapters] == [
        ("book_x/ch1", [1, 3], 1), ("book_x/1.1", [2, 2], 1),
    ]

    found = library.search("正数和负数")  # NFKC + line breaks ignored
    assert [(h["kind"], h["page"], h["ref"]) for h in found["hits"]] == [("page", 2, "book_x/1.1")]
    assert library.search("相反意义")["hits"][0]["title"] == "相反意义的量"

    read = library.read("book_x/1.1")
    assert read["shown"] == [2, 2] and read["next_page"] is None
    assert "－３℃" in read["text"][0]["text"]
    note = read["notes"][0]["text"]
    assert "返回教材原文" not in note and "[[" not in note and "相反意义的量" in note

    with pytest.raises(TutorError):
        library.read("book_x/1.1", page=3)
    with pytest.raises(TutorError):
        library.read("book_x/nope")


def test_read_renders_page_images_cropped_to_the_chapter(library: Library, tmp_path: Path):
    assert library.read("book_x/1.1")["images"] == []  # no pdftoppm: text only
    log = tmp_path / "pdftoppm.log"
    tools = {
        "pdfinfo": "#!/bin/sh\nprintf 'Page    2 size: 500 x 720 pts\\n'\n",
        # Logs its arguments and writes <root>.jpg like the real tool.
        "pdftoppm": f'#!/bin/sh\necho "$@" >> "{log}"\neval root=\\${{$#}}\nprintf jpg > "$root.jpg"\n',
    }
    for name, script in tools.items():
        (tmp_path / name).write_text(script, encoding="utf-8")
        (tmp_path / name).chmod(0o755)

    for _ in range(2):
        images = library.read("book_x/1.1")["images"]
        assert [i["page"] for i in images] == [2] and Path(images[0]["path"]).read_text() == "jpg"
    # Starts at y=0.25 on page 2 (8 px margin), runs to the page bottom: 720 pt at 130 dpi = 1300 px.
    assert log.read_text().count("\n") == 1  # second read hits the cache
    assert "-x 0 -y 317 -W 0 -H 983" in log.read_text()


def test_changed_pdf_is_refused(library: Library):
    (library.vault / "book.pdf").write_bytes(b"%PDF edited")
    with pytest.raises(TutorError, match="no longer matches"):
        library.read("book_x/ch1")


def test_build_links_chapters(library: Library, tmp_path: Path):
    bank = tmp_path / "bank.jsonl"
    bank.write_text(json.dumps({"id": "q1", "type": "judge", "content": "x", "answer": "A"}))
    tutor = Tutor(Store(tmp_path / "t.db"), bank, None, "ada", "c", library=library)
    point = {"id": "kp", "name": "Signs", "type": "memory", "question_ids": ["q1"]}
    with pytest.raises(TutorError, match="Unknown chapter"):
        tutor.build([{"name": "M", "knowledge_points": [point | {"chapter": "book_x/9.9"}]}])
    tutor.build([{"name": "M", "knowledge_points": [point | {"chapter": "book_x/1.1"}]}])
    status = tutor.status()
    assert status["next"]["chapter"] == "book_x/1.1"
    assert status["outline"][0]["knowledge_points"][0]["chapter"] == "book_x/1.1"
    assert tutor.textbook("read", ref="book_x/1.1")["title"] == "1.1 正数和负数"
