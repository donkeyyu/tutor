# Demo data

## Question bank

`bank.jsonl` is included in the repository and is the plugin's default bank.
The demo reads it directly. A separate parser checkout is not needed.
Learner progress stays in the ignored `tutor.db` file.

The snapshot was imported on 2026-11-17 from
`D:/jby_work/question_bank/word_parse/outputs` with
`tutor_engine.import_jby`. It contains 14,599 questions:

| Type | Count |
| --- | ---: |
| Single choice | 7,353 |
| Fill in the blank | 2,638 |
| Open response | 4,152 |
| Multiple choice | 326 |
| True or false | 130 |

The import skipped 1,825 questions without usable answers and 562 duplicates.
It kept each question's original ID and source location in `origin`.
Source locations use `/` and serve as provenance; the engine does not open them.

All 33 local images are embedded as data URLs. These came from the parser's
HTML assets and three original English DOCX files. The snapshot retains
4,982 remote image URLs, which need internet access. Existing parser data URLs
are preserved. The snapshot is about 37 MB.

To refresh the text and answers, run the import command in `CLAUDE.md` against
the parser's `outputs` folder. That command produces raw rows. Before sharing
a refreshed snapshot, embed its relative image references from the matching
`outputs/html` assets or the original DOCX `word/media` entries. Apply image
changes after import so that question IDs stay stable.

The question bank is a fixed demo snapshot. Changes in the parser folder take
effect after a new import.

## Textbook sample

`textbooks/` is the plugin's default textbook vault. It includes the first
chapter, **第一章 有理数**, from the 人民教育出版社 *数学 七年级上册*
textbook, plus 12 study notes. A separate Obsidian vault is not needed.
The sample adds about 2.7 MB and supports `tutor_textbook` list, search, read,
page images, and chapter links in course outlines.

The snapshot was copied on 2026-11-17 from `~/dev/textbook-study-vault`:

- `数学七上.pdf`, physical PDF pages 8–30 (23 pages), extracted without
  rasterizing the original text or images.
- The three chapter entries `chapter-1`, `1.1`, and `1.2` from
  `教材索引/6f2a471b07f44a4985756affed9c3c58da7232d205317b1f643b1a865e4e7249.json`.
- Twelve concept and worked-example notes from
  `课本解读笔记/数学·七年级上册/第一章 有理数/`, covering positive and negative
  numbers, rational numbers, the number line, opposites, and absolute value.
  These are study notes from the vault, not publisher text.

The original book and chapter IDs are preserved so chapter refs stay stable.
PDF pages are rebased by subtracting 7 in the index and notes: demo page 1 is
source PDF page 8. Each note keeps `source_pdf_page` for the original location.
The excerpt has its own SHA-256 index. Notes retain their readable body and
the frontmatter used by the tutor; vault-only metadata and return links are
omitted, and links to other notes become plain labels.

Text extraction and page images need Poppler (`pdftotext`, `pdftoppm`, and
`pdfinfo`) on `PATH`. Alternatively, set the plugin's `pdftotext` option to
its absolute path; the image tools must be beside it. On macOS, install with
`brew install poppler`. The engine creates its ignored cache on first use.

To use a full library, set `vault` and, if needed, `indexFolder` in the tutor
plugin settings. An empty `vault` turns textbook access off. To refresh this
fixed sample, extract the same source page range, recompute its PDF hash,
and rebase the matching index entries and selected notes together.
