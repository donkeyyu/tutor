# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A mastery tutor that runs as a DeepSeek Harness (DSH) plugin and teaches from our own question bank and the textbooks in the 教材学习 vault (`~/dev/textbook-study-vault`, plugin source `~/dev/textbook-study`). The bank is imported from the jby `word_parse` parser outputs (`~/dev/jby_work/question_bank/word_parse/outputs`; its contract is in that repo's `docs/business-rules/`). The core logic is ported from DeepTutor (`notes/deeptutor-pipeline.md` explains the original; `NOTICE` lists the derived files, which are Apache-2.0).

## Commands

```sh
# Engine (Python >= 3.11, stdlib only; uv manages the dev env)
cd engine && uv run pytest -q
cd engine && uv run pytest -q tests/test_engine.py::test_full_loop_quiz_grade_master_then_review

# Plugin (Node >= 24; runs .ts directly through Node type stripping)
cd plugin && npm install && npx tsc --noEmit && npm test

# Run inside DSH (published CLI, any folder; http://127.0.0.1:3080)
npx @deepseek-ai/dsh@0.2.2-rc.3 web --patch /Users/chengqiyu/dev/tutor/plugin/cordis.yml
# or from a deepseek-harness source checkout: pnpm dsh web --patch ...

# Rebuild data/bank.jsonl (generated, gitignored) from the parser outputs; prints kept/skipped counts
PYTHONPATH=engine/src python3 -m tutor_engine.import_jby ~/dev/jby_work/question_bank/word_parse/outputs data/bank.jsonl

# Call the engine by hand
echo '{}' | PYTHONPATH=engine/src python3 -m tutor_engine \
  --db data/tutor.db --bank data/bank.jsonl --sources data/sources \
  --learner default --course default status

# Read the textbook vault by hand (index folder defaults to 教材索引)
echo '{"action":"list"}' | PYTHONPATH=engine/src python3 -m tutor_engine \
  --db data/tutor.db --bank data/bank.jsonl --vault ../textbook-study-vault \
  --learner default --course default textbook
```

Before marking a plugin task done, restart DSH and test the affected behavior on its authenticated page. Unit tests and standalone browser fixtures supplement this check. If the live page check is blocked, report the blocker and keep the task incomplete.

## Architecture

The model decides **how** to teach. Deterministic code decides **what comes next** and **whether the learner may advance**. Keep that split: never let a tool argument or model judgement award mastery, except `tutor_assess` for concept/design objectives.

- `plugin/src/index.ts` is a thin DSH plugin. It registers the `tutor_*` tools and the `tutor:protocol` system-prompt section (`prompt.ts`). Each tool spawns `python -m tutor_engine <command>` once and passes JSON over stdin/stdout (`engine.ts`). Engine refusals become `TutorRefusal` (`HarnessError`, code `TUTOR_REFUSED`), and the model sees their message. Config defaults resolve `engine/` and `data/` relative to the repo root.
- `plugin/src/cards.ts` builds question, grading, and textbook cards as `{title, body}` Markdown in `output.presentationMeta`. DSH web does not call `presentResult`: `plugin/src/client.js` renders saved metadata with DSH's `MarkdownText` (including math). Successful question and textbook results become `tutor-card` Chat nodes with `groupTree: 'turn'`, keeping them visible outside both thinking disclosures. Their `tool.call.toolview` entries keep compact inspection records; grading cards and raw/error fallbacks stay in tool views. Its `dsh.client` declaration and `./client` export in `plugin/package.json` make DSH discover this browser entry; restart DSH after changing that declaration. The plain-JS module factory needs no build step. `presentResult` remains available to other clients. The model still gets raw JSON, and replay needs no engine call. For `tutor_textbook` reads the plugin removes `images` from the model's JSON (DeepSeek is text-only) and inlines them in the card meta as `data:image/jpeg` URLs, so the learner sees the cropped pages instead of the `pdftotext` text; pages without an image fall back to text.
- Historical textbook reads without card metadata are rendered from validated saved JSON; parity with `knowledgeCard` is tested. Card projection pairs root calls and results by call id and handles nested PTC results; a root result without its loaded call remains in the generic tool view. The knowledge card's `续读` button appends the next chapter/page request to the chat draft, preserving existing text and leaving sending to the learner.
- `engine/src/tutor_engine/` holds all state and decisions:
  - `service.py` has one method per tool. Each method is one `Store.transaction` (SQLite `BEGIN IMMEDIATE`, one JSON `Progress` row per `(learner, course)`).
  - `policy.next_step` is recomputed on every call, never stored. Order: open question > due review > first unmastered objective (`probe`/`teach` when new, `practice` or `assess` after) > deferred > `complete`.
  - `mastery.compute_mastery` is the recency-weighted score, capped at 0.5 after 1 attempt and 0.8 after 2. Memory/procedure pass at >= 0.9. Concept/design pass only through `tutor_assess`. Swap this one function to change the scoring model.
  - `scheduler.py` uses DeepTutor's per-type interval ladders only, not its stability/difficulty model. Only mastered objectives are scheduled.
  - `bank.py` defines the bank format (docstring) and loads `data/bank.jsonl` on every call (~0.6 s for 14.6k questions). Types are `single`/`multi`/`judge`/`blank`, graded by code in `grading.py`, and `open`, judged by the model. Questions are linked to objectives by id: the model finds them with `tutor_bank_search` and stores them as `question_ids` in `tutor_build`, and the engine rejects unknown ids. Memory/procedure objectives only pose code-graded questions. A question whose `source.quote` is not literally in `data/sources/<path>` is `unverified` and never posed. `pick` prefers unseen questions, steps difficulty (1-3) up after a right answer and down after a wrong one, and puts skipped questions last.
  - Open questions take two `grade` calls: the learner's answer (the engine reveals the reference), then the model's `verdict`. Judged attempts (`Attempt.judged`) never feed the numeric gate (`Progress.scores`). A correct verdict passes a concept/design objective.
  - `teaching.py` validates teaching notes: evidence must be a literal quote from `learner_message`, preferences need `learner_report`, and the caps are 6 preferences and 12 observations.
- `textbook.py` reads the 教材学习 vault live on every `tutor_textbook` call. Its inputs are the chapter indexes in `<vault>/<indexFolder>/<sha256>.json`, and the notes whose frontmatter has `textbook_id` + `pdf_page`. It also uses the PDF text from `pdftotext`, cached per SHA-256 in `<db dir>/textbook_cache/`. `read` also returns `images`: JPEG paths of the shown pages, rendered by `pdftoppm` (found beside `pdftotext`, with `pdfinfo`) and cropped to the chapter's start/end `y`, cached in `textbook_cache/<sha256>/`. A render failure only drops the image. A PDF that no longer matches its index hash is refused. Chapters are addressed by `ref` = `<textbook_id>/<chapter_id>`. Notes attach by `pdf_page`, not by `chapter_id`. `tutor_build` stores an optional `chapter` ref per knowledge point, and the engine rejects refs it doesn't know. `vault`, `indexFolder` and `pdftotext` are plugin config (DSH panel). An empty `vault` turns the tool off.
- `import_jby.py` maps the parser's question trees to bank rows:
  - It uses the native tree only, because `fallback` is a display copy.
  - Ancestor `content` becomes `material`, and `多选多` leaves inherit the parent's option pool.
  - Leaves with empty keys are skipped and counted, never guessed.
  - Free-text `填空` keys (over 12 chars, `或`, `合理`) become `open`.
  - Ids are content hashes taken before the free-text rule, so re-imports keep outline links unless the question changed.

## Known gaps

- When the plugin runs from outside the DSH checkout, it imports its own `node_modules` copies of `@deepseek-ai/*`. If DSH rejects foreign instances, resolve them from the host instead.
- `tutor_grade` and `tutor_assess` trust the model to pass the learner's actual words. DeepTutor commits answers server-side at turn start. Closing this needs reading the current user message from the DSH session.
- Answers are entered in chat. Dedicated answer controls plus `exec.concludeTurn()` are the upgrade path.
- Code grading is exact after normalization (HTML/LaTeX delimiters, case, punctuation). An answer with equivalent but different wording fails, which is why free-text blanks are routed to `open`.
- Verdicts on `open` questions are the model's judgement, not checked by code.
- About 1,800 parser leaves have no answer key and are not in the bank. Only ~400 items carry a `knowledge` tag, so linking relies on text search.
- Textbook text for the model is `pdftotext` output. Formulas and figures come through garbled, and image-only pages are empty. The learner's card shows page images instead, inlined as base64 (~150 KB a page), so each read adds ~0.5–1 MB to the session log. The first search on a new PDF takes about 5 s to build the cache.
- Not packaged as a DSH bundle yet: an installed bundle needs JS output, because Node won't strip types inside `node_modules`.
