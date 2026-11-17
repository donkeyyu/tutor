// DSH plugin: mounts the tutor tools and protocol. All state and decisions live
// in the Python engine (../engine); these tools are thin JSON pass-throughs.
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolResult } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { type Card, gradeCard, knowledgeCard, presentCard, questionCard } from './cards.ts'
import { callEngine, type EngineOptions, type Json } from './engine.ts'
import { TUTOR_PROTOCOL } from './prompt.ts'
import { type Paper, paperCard, renderPaperHtml } from './paper.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const name = 'tutor'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  python: string
  engineDir: string
  db: string
  bank: string
  sources: string
  vault: string
  indexFolder: string
  pdftotext: string
  learner: string
  course: string
}

export const Config: Schema<Config> = Schema.object({
  python: Schema.string().default('python3').description('Python >= 3.11 executable'),
  engineDir: Schema.string().default(resolve(ROOT, 'engine')),
  db: Schema.string().default(resolve(ROOT, 'data/tutor.db')),
  bank: Schema.string().default(resolve(ROOT, 'data/bank.jsonl')),
  sources: Schema.string().default(resolve(ROOT, 'data/sources')),
  vault: Schema.string().default(resolve(ROOT, 'data/textbooks')).description('Textbook vault (bundled demo by default). Set a 教材学习 vault path to use your own books, or leave empty to turn tutor_textbook off.'),
  indexFolder: Schema.string().default('教材索引').description('章节索引文件夹: vault-relative chapter index folder, same as the 教材学习 setting.'),
  pdftotext: Schema.string().default('pdftotext').description('pdftotext executable (poppler) used to read textbook PDF text.'),
  learner: Schema.string().default('default'),
  course: Schema.string().default('default'),
})

const json = { schema: { type: 'json' }, render: (_: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] } as const

/** JSON output plus a result card; `card` returns null for results shown raw. */
const carded = (card: (args: any, value: any) => Card | null) => ({
  output: { ...json, presentationMeta: (args: unknown, value: unknown) => card(args, value) as any },
  presentResult: (_args: unknown, result: ToolResult) => presentCard(result),
})

/** Textbook reads stay in the tool record unless the tutor explicitly shows a card. */
const textbookOutput = {
  output: {
    schema: json.schema,
    render: (args: unknown, value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return json.render(args, value)
      const { images: _images, ...rest } = value as Record<string, unknown>
      return json.render(args, rest)
    },
    presentationMeta: (args: any, value: any) => (args.action === 'read'
      ? { ...knowledgeCard(value), show_card: args.show_card === true } : null) as any,
  },
  presentResult: (_args: unknown, result: ToolResult) =>
    (result.meta as { show_card?: boolean } | undefined)?.show_card === true ? presentCard(result) : undefined,
}

const kpId = { type: 'string', description: 'knowledge_point_id from tutor_status, verbatim.' } as const

export function apply(ctx: Context, config: Config) {
  const opts: EngineOptions = config
  const call = (command: string, params: Record<string, unknown>, signal: AbortSignal) =>
    callEngine(opts, command, params, signal)

  ctx.systemPrompt.section({ name: 'tutor:protocol', order: 5000, text: TUTOR_PROTOCOL, interpolate: false })

  ctx.tools.register(defineTool({
    name: 'tutor_status',
    description: 'Read the next step (decided by the engine), the course outline with mastery, the learner profile, and teaching notes for the current objective. Call at the start of every turn.',
    parameters: {},
    output: json,
    execute: (_args, exec) => call('status', {}, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_bank_search',
    description: 'Search the question bank to find question ids for an objective. All query words must appear (in material, stem, knowledge, question_type or paper). Returns a total and short summaries.',
    parameters: {
      query: { type: 'string', description: 'Space-separated words, e.g. "向量 共线".' },
      subject: { type: 'string', description: 'e.g. math, physics, chinese, english, chemistry, biology, history, geography, politics.' },
      types: { type: 'array', items: { type: 'string', enum: ['single', 'multi', 'judge', 'blank', 'open'] } },
      difficulty: { type: 'integer', enum: [1, 2, 3], description: '1 基础, 2 中档, 3 较难' },
      limit: { type: 'integer', description: 'Max results, up to 50 (default 20).' },
      detail: { type: 'boolean', description: 'Include full question material, prompt and options, without answers. Use true to inspect candidates before selecting a test paper.' },
    },
    output: json,
    execute: (args, exec) => call('bank_search', args, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_paper',
    description: '组卷: assemble a standalone test paper from real bank questions you have inspected. First split the requested chapter/topic into knowledge points and search with tutor_bank_search detail=true; select only questions that match the grade, topic and requested types. Returns knowledge coverage, question-type/difficulty breakdown and shortages, with a click-to-open HTML paper. Does not change the course, pending quiz or mastery. Never invent question ids or fill shortages with unrelated questions.',
    parameters: {
      title: { type: 'string', required: true, description: 'Chinese paper title.' },
      scope: { type: 'string', required: true, description: 'The chapter or knowledge scope requested by the learner.' },
      subject: { type: 'string', description: 'Bank subject code, e.g. math. Every selected question must match.' },
      grade: { type: 'string', description: 'Grade explicitly given by the learner, if any.' },
      count: { type: 'integer', description: 'Requested total questions, 1–50 (default 10). Keep this target when the bank is short.' },
      duration_minutes: { type: 'integer', description: 'Time limit only if requested, 1–360 minutes.' },
      knowledge_points: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'A distinct knowledge point in the requested scope.' },
            objective: { type: 'string', required: true, description: 'The specific ability this point tests.' },
            question_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Inspected bank ids for this point. An empty list reports a coverage gap. Each id may occur only once in the whole paper.' },
          },
        },
      },
    },
    output: {
      schema: json.schema,
      render: (_args: unknown, value: any) => json.render(_args, {
        ...value,
        questions: value.questions.map(({ number, knowledge_point, question_id, question_type, difficulty }: any) =>
          ({ number, knowledge_point, question_id, question_type, difficulty })),
      }),
      presentationMeta: (_args: unknown, value: any) => paperCard(value, value.html_path) as any,
    },
    presentResult: (_args: unknown, result: ToolResult) => presentCard(result),
    execute: async (args, exec) => {
      const paper = await call('paper', args, exec.signal) as unknown as Paper
      if (paper.count === 0) return paper as unknown as Json
      const rendered = await renderPaperHtml(paper, exec.signal)
      exec.signal.throwIfAborted()
      const directory = resolve(dirname(opts.db), 'papers')
      mkdirSync(directory, { recursive: true })
      const path = resolve(directory, `paper-${randomUUID()}.html`)
      const temporary = `${path}.tmp`
      try {
        writeFileSync(temporary, rendered.html, { encoding: 'utf8', flag: 'wx' })
        renameSync(temporary, path)
      } finally {
        rmSync(temporary, { force: true })
      }
      return { ...paper, warnings: [...paper.warnings, ...rendered.warnings], html_path: path } as unknown as Json
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_textbook',
    description: 'Read the course textbooks (PDF text plus study notes from the 教材学习 vault). list: chapters with refs and PDF pages. search: pages and notes containing all query words. read: a chapter by ref, a few pages at a time (follow next_page), with the notes on those pages.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'search', 'read'] },
      query: { type: 'string', description: 'search: space-separated words, e.g. "相反数 绝对值".' },
      ref: { type: 'string', description: 'read: chapter ref from list or search, verbatim.' },
      page: { type: 'integer', description: 'read: physical PDF page to start from (default: chapter start).' },
      limit: { type: 'integer', description: 'search: max hits, up to 30 (default 10).' },
      show_card: { type: 'boolean', description: 'read: show a knowledge card only when the learner asks to see the material or the card clearly helps the current explanation. Omit or false for routine teaching and background reading (default: hidden).' },
    },
    ...textbookOutput,
    execute: ({ show_card: _showCard, ...args }, exec) => call('textbook', args, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_build',
    description: 'Replace the course outline. Link each knowledge point to bank question ids found with tutor_bank_search, and to its textbook chapter ref from tutor_textbook. Keep existing ids to keep progress; mastered objectives cannot be dropped. Reports objectives with no poseable questions (memory/procedure need code-graded types).',
    parameters: {
      modules: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string', required: true },
            objective: { type: 'string', description: 'What the learner can do once this clears.' },
            knowledge_points: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string', required: true },
                  type: { type: 'string', required: true, enum: ['memory', 'procedure', 'concept', 'design'] },
                  question_ids: { type: 'array', items: { type: 'string' }, description: 'Bank question ids from tutor_bank_search.' },
                  chapter: { type: 'string', description: 'Textbook chapter ref from tutor_textbook, verbatim.' },
                },
              },
            },
          },
        },
      },
    },
    output: json,
    execute: (args, exec) => call('build', { modules: args.modules }, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_quiz',
    description: 'Pose the next bank question for an objective (defaults to the current one). The answer key stays in the engine. If a question is already open it is returned unchanged. Success displays the question card and ends this turn. Do not repeat the material, prompt or options in text; wait for the learner.',
    parameters: { knowledge_point_id: kpId },
    ...carded((_args, value) => questionCard(value)),
    execute: async (args, exec) => {
      const result = await call('quiz', { knowledge_point_id: args.knowledge_point_id ?? '' }, exec.signal)
      exec.concludeTurn()
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_grade',
    description: "Grade the open question. single/multi/judge: pass answer. blank: pass blanks, one entry per [[_]] in order. Always use the learner's own words. open: first call with answer to see the reference, then call again with verdict only.",
    parameters: {
      answer: { type: 'string' },
      blanks: { type: 'array', items: { type: 'string' } },
      verdict: { type: 'string', enum: ['correct', 'partial', 'incorrect'], description: 'open questions only, after seeing the reference.' },
    },
    ...carded((_args, value) => gradeCard(value)),
    execute: (args, exec) => call('grade', args, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_assess',
    description: "Record a concept/design check after the learner explained the idea in their own words. learner_quote must appear literally in learner_message.",
    parameters: {
      knowledge_point_id: { ...kpId, required: true },
      passed: { type: 'boolean', required: true },
      learner_quote: { type: 'string', required: true },
      learner_message: { type: 'string', required: true, description: "The learner's current message, verbatim." },
    },
    output: json,
    execute: (args, exec) => call('assess', args, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_skip',
    description: 'Drop the open question (learner asked, or it is broken). No credit.',
    parameters: {},
    output: json,
    execute: (_args, exec) => call('skip', {}, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_defer',
    description: 'Set an objective aside for later at the learner\'s request. No credit; it returns when nothing else is left.',
    parameters: { knowledge_point_id: { ...kpId, required: true } },
    output: json,
    execute: (args, exec) => call('defer', args, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_profile',
    description: 'Merge learner intake answers. Record only what the learner said.',
    parameters: {
      fields: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          prior_knowledge: { type: 'string' },
          target_level: { type: 'string' },
          time_budget: { type: 'string' },
          preferences: { type: 'string' },
          notes: { type: 'string' },
          teaching_strategy: { type: 'string', enum: ['probe_first', 'teach_first'] },
        },
      },
    },
    output: json,
    execute: (args, exec) => call('profile', { fields: args.fields }, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'tutor_note',
    description: 'Upsert/remove teaching preferences (explicit learner requests) and per-objective observations. Evidence must be a literal quote from learner_message. Never grants mastery.',
    parameters: {
      learner_message: { type: 'string', required: true },
      updates: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: ['preference', 'observation'] },
            op: { type: 'string', required: true, enum: ['upsert', 'remove'] },
            key: { type: 'string', required: true },
            text: { type: 'string' },
            basis: { type: 'string', enum: ['learner_report', 'tentative'] },
            evidence: { type: 'string' },
            knowledge_point_id: { type: 'string' },
            strategy: { type: 'string' },
            outcome: { type: 'string', enum: ['unknown', 'helped', 'not_helped'] },
          },
        },
      },
    },
    output: json,
    execute: (args, exec) => call('note', args, exec.signal),
  }))
}
