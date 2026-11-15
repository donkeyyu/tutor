"""Textbook sources from a 教材学习 (textbook-study) Obsidian vault.

Read live on every call, so edits in Obsidian show up at once:

- ``<vault>/<index_folder>/<sha256>.json``: chapter indexes written by the
  plugin (``textbook_id``, ``pdf_sha256``, ``pdf_path`` vault-relative,
  ``chapters`` with ``id``, ``title``, ``level``, ``parent_id``, and
  ``start``/``end`` as ``{page, y}`` on 1-based physical PDF pages).
- Markdown notes whose frontmatter has ``textbook_id`` and ``pdf_page``
  (box notes and imported 课本解读笔记). Only top-level scalar keys are read.
- The PDF text, extracted once with ``pdftotext`` and cached by SHA-256 in
  ``cache_dir`` (re-extracted when the file's size or mtime changes).

A chapter is addressed by ``ref`` = ``<textbook_id>/<chapter_id>``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
from pathlib import Path
import re
import subprocess
import unicodedata
from typing import Any

from tutor_engine.models import TutorError

READ_PAGES = 4  # pages per read call; keeps tool results small
_FRONT_KEY = re.compile(r"^([A-Za-z_][\w-]*):\s*(.*)$")
_WIKILINK = re.compile(r"!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]")
_CALLOUT = re.compile(r"^>\s*\[!\w+\][+-]?\s*", re.M)


@dataclass
class Chapter:
    ref: str
    id: str
    title: str
    level: int
    parent: str
    first: int
    last: int


@dataclass
class Note:
    title: str
    page: int
    chapter_id: str
    section_id: str
    content_type: str
    text: str


@dataclass
class Book:
    textbook_id: str
    sha256: str
    pdf: Path
    page_count: int
    chapters: list[Chapter]
    notes: list[Note] = field(default_factory=list)


@dataclass
class Library:
    vault: Path
    index_folder: str
    cache_dir: Path
    pdftotext: str = "pdftotext"

    # -- loading --------------------------------------------------------------

    def _index_dir(self) -> Path:
        return self.vault / self.index_folder

    def books(self) -> dict[str, Book]:
        index_dir = self._index_dir()
        if not index_dir.is_dir():
            raise TutorError(
                f"Textbook index folder {str(index_dir)!r} not found; check the vault and "
                "index folder in the tutor plugin settings."
            )
        books: dict[str, Book] = {}
        for path in sorted(index_dir.glob("*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                book = _book(raw, self.vault)
            except (OSError, ValueError, KeyError, TypeError):
                continue  # not a chapter index
            books[book.textbook_id] = book
        for note in self._notes(index_dir):
            book = books.get(note[0])
            if book is not None:
                book.notes.append(note[1])
        for book in books.values():
            book.notes.sort(key=lambda n: (n.page, n.title))
        return books

    def _notes(self, index_dir: Path):
        skip = index_dir.resolve()
        for path in self.vault.rglob("*.md"):
            rel = path.relative_to(self.vault)
            if any(part.startswith(".") for part in rel.parts) or path.resolve().is_relative_to(skip):
                continue
            try:
                parsed = _parse_note(path)
            except (OSError, UnicodeDecodeError):
                continue
            if parsed is not None:
                yield parsed

    def chapter(self, books: dict[str, Book], ref: str) -> tuple[Book, Chapter]:
        book_id, _, chapter_id = ref.partition("/")
        book = books.get(book_id)
        found = next((c for c in book.chapters if c.id == chapter_id), None) if book else None
        if book is None or found is None:
            raise TutorError(f"Unknown chapter ref {ref!r}; list chapters with tutor_textbook.")
        return book, found

    # -- pdf text -------------------------------------------------------------

    def pages(self, book: Book) -> list[str]:
        """Text of every PDF page (index 0 = page 1), cached by SHA-256."""
        try:
            stat = book.pdf.stat()
        except OSError as exc:
            raise TutorError(f"Textbook PDF {str(book.pdf)!r} is missing.") from exc
        stamp = [stat.st_size, stat.st_mtime_ns]
        cache = self.cache_dir / f"{book.sha256}.json"
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            if cached["stamp"] == stamp:
                return cached["pages"]
        except (OSError, ValueError, KeyError, TypeError):
            pass
        if hashlib.sha256(book.pdf.read_bytes()).hexdigest() != book.sha256:
            raise TutorError(
                f"{book.pdf.name} no longer matches its chapter index; re-index it in 教材学习."
            )
        try:
            out = subprocess.run(
                [self.pdftotext, "-q", "-enc", "UTF-8", str(book.pdf), "-"],
                capture_output=True, check=True, timeout=120,
            ).stdout.decode("utf-8", "replace")
        except (OSError, subprocess.SubprocessError) as exc:
            raise TutorError(
                f"Could not extract PDF text with {self.pdftotext!r} ({exc}); install poppler "
                "or set the pdftotext path in the tutor plugin settings."
            ) from exc
        pages = [p.strip() for p in out.split("\f")][: book.page_count or None]
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_suffix(".tmp")
        tmp.write_text(json.dumps({"stamp": stamp, "pages": pages}, ensure_ascii=False), encoding="utf-8")
        tmp.replace(cache)
        return pages

    # -- tool actions ---------------------------------------------------------

    def list(self) -> dict[str, Any]:
        return {
            "textbooks": [
                {
                    "textbook_id": b.textbook_id,
                    "pdf": b.pdf.name,
                    "page_count": b.page_count,
                    "notes": len(b.notes),
                    "chapters": [
                        {
                            "ref": c.ref,
                            "title": c.title,
                            "level": c.level,
                            "parent": c.parent,
                            "pages": [c.first, c.last],
                            "notes": sum(c.first <= n.page <= c.last for n in b.notes),
                        }
                        for c in b.chapters
                    ],
                }
                for b in self.books().values()
            ]
        }

    def search(self, query: str, limit: int = 10) -> dict[str, Any]:
        words = [_norm(w) for w in query.split() if _norm(w)]
        if not words:
            raise TutorError("query is empty")
        limit = max(1, min(int(limit or 10), 30))
        hits: list[dict[str, Any]] = []
        total = 0
        warnings: list[str] = []
        for book in self.books().values():
            try:
                pages = self.pages(book)
            except TutorError as exc:
                pages = []
                warnings.append(str(exc))
            units = [("page", i + 1, "", text) for i, text in enumerate(pages)]
            units += [("note", n.page, n.title, f"{n.title}\n{n.text}") for n in book.notes]
            for kind, page, title, text in units:
                flat = _norm(text)
                if not all(w in flat for w in words):
                    continue
                total += 1
                if len(hits) < limit:
                    chapter = _deepest(book, page)
                    hit = {"kind": kind, "page": page, "ref": chapter.ref if chapter else "",
                           "chapter": chapter.title if chapter else "", "snippet": _snippet(text, words[0])}
                    if title:
                        hit["title"] = title
                    hits.append(hit)
        return {"total": total, "hits": hits, **({"warnings": warnings} if warnings else {})}

    def read(self, ref: str, page: int | None = None) -> dict[str, Any]:
        books = self.books()
        book, chapter = self.chapter(books, ref)
        start = chapter.first if page is None else int(page)
        if not chapter.first <= start <= chapter.last:
            raise TutorError(f"page must be within {chapter.first}-{chapter.last} for {ref!r}")
        end = min(chapter.last, start + READ_PAGES - 1)
        pages = self.pages(book)
        return {
            "ref": chapter.ref,
            "title": chapter.title,
            "pages": [chapter.first, chapter.last],
            "shown": [start, end],
            "next_page": end + 1 if end < chapter.last else None,
            "text": [{"page": p, "text": pages[p - 1] if p <= len(pages) else ""} for p in range(start, end + 1)],
            "notes": [
                {"title": n.title, "page": n.page, "content_type": n.content_type, "text": n.text}
                for n in book.notes
                if start <= n.page <= end
            ],
        }


def _book(raw: dict[str, Any], vault: Path) -> Book:
    textbook_id = str(raw["textbook_id"])
    page_count = int(raw.get("page_count") or 0)
    chapters = []
    for c in raw["chapters"]:
        first = int(c["start"]["page"])
        end = c.get("end") or {"page": page_count or first, "y": 1}
        last = int(end["page"])
        if last > first and float(end.get("y", 1)) <= 0:
            last -= 1  # ends at the top of that page
        chapters.append(
            Chapter(f"{textbook_id}/{c['id']}", str(c["id"]), str(c.get("title", "")),
                    int(c.get("level", 1)), str(c.get("parent_id") or ""), first, max(first, last))
        )
    return Book(textbook_id, str(raw["pdf_sha256"]), vault / str(raw["pdf_path"]), page_count, chapters)


def _parse_note(path: Path) -> tuple[str, Note] | None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    meta: dict[str, str] = {}
    for line in text[4:end].splitlines():
        m = _FRONT_KEY.match(line)
        if m:
            meta[m.group(1)] = m.group(2).strip().strip("\"'")
    try:
        page = int(meta.get("pdf_page", ""))
    except ValueError:
        return None
    if not meta.get("textbook_id"):
        return None
    body = text[end + 4 :].lstrip("-\n")
    return meta["textbook_id"], Note(
        path.stem, page, meta.get("chapter_id", ""), meta.get("section_id", ""),
        meta.get("content_type", ""), _plain(body),
    )


def _plain(body: str) -> str:
    """Note body for the model: no return links, wikilinks as their labels."""
    lines = [line for line in body.splitlines() if "返回教材原文" not in line]
    text = _WIKILINK.sub(lambda m: m.group(2) or Path(m.group(1).split("#")[0]).stem, "\n".join(lines))
    text = _CALLOUT.sub("", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _norm(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text).casefold().split())


def _deepest(book: Book, page: int) -> Chapter | None:
    covering = [c for c in book.chapters if c.first <= page <= c.last]
    return max(covering, key=lambda c: c.level, default=None)


def _snippet(text: str, word: str, width: int = 60) -> str:
    plain = " ".join(unicodedata.normalize("NFKC", text).split())
    at = plain.casefold().replace(" ", "").find(word)
    if at < 0:
        return plain[: width * 2]
    # map the index in the space-free string back to ``plain``
    seen = i = 0
    while i < len(plain) and seen < at:
        seen += plain[i] != " "
        i += 1
    return plain[max(0, i - width) : i + width]
