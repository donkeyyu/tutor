# Demo question bank

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
