// Smoke test: mount the plugin on a fake ctx and drive the real Python engine.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { htmlToMarkdown, knowledgeCard } from '../src/cards.ts'
import { apply, Config } from '../src/index.ts'
import { callEngine } from '../src/engine.ts'

test('default config lists the bundled textbook without a separate vault', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tutor-'))
  const config = Config({ db: join(dir, 't.db') } as Partial<Config> as Config)
  assert.equal(config.vault, resolve(import.meta.dirname, '../../data/textbooks'))
  const tools = new Map<string, any>()
  apply({ tools: { register: (def: any) => tools.set(def.name, def) }, systemPrompt: { section() {} } } as any, config)
  const result = await tools.get('tutor_textbook').execute({ action: 'list' }, { signal: new AbortController().signal })
  assert.equal(result.textbooks.length, 1)
  const book = result.textbooks[0]
  assert.equal(book.page_count, 23)
  assert.ok(book.notes > 0)
  assert.deepEqual(book.chapters.map((chapter: any) => [chapter.title, chapter.pages]), [
    ['第一章 有理数', [1, 23]],
    ['1.1 正数和负数', [2, 6]],
    ['1.2 有理数及其大小比较', [7, 19]],
  ])
  const textbook = tools.get('tutor_textbook')
  const args = { action: 'read', ref: book.chapters[1].ref, show_card: true }
  const read = await textbook.execute(args, { signal: new AbortController().signal })
  assert.equal(read.ref, args.ref)
  assert.equal(textbook.output.presentationMeta(args, read).show_card, true)
})

test('engine bridge keeps Chinese JSON intact with a non-UTF-8 parent encoding', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tutor-'))
  const bank = join(dir, 'bank.jsonl')
  writeFileSync(bank, JSON.stringify({ id: 'q1', type: 'blank', content: '相反数是什么？', answer: ['-1'] }))
  const previous = process.env.PYTHONIOENCODING
  process.env.PYTHONIOENCODING = 'ascii'
  t.after(() => {
    if (previous === undefined) delete process.env.PYTHONIOENCODING
    else process.env.PYTHONIOENCODING = previous
  })
  const result: any = await callEngine(
    Config({ db: join(dir, 't.db'), bank, vault: '' } as Partial<Config> as Config),
    'bank_search', { query: '相反数' },
  )
  assert.equal(result.total, 1)
  assert.equal(result.questions[0].text, '相反数是什么？')
})

test('successful quiz cards conclude the turn without suppressing refusals or changing a reposed question', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tutor-quiz-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bank = join(dir, 'bank.jsonl')
  writeFileSync(bank, JSON.stringify({ id: 'q1', type: 'single', content: '2 的相反数是？', options: ['-2', '2'], answer: 'A' }))
  const tools = new Map<string, any>()
  apply({ tools: { register: (def: any) => tools.set(def.name, def) }, systemPrompt: { section() {} } } as any,
    Config({ db: join(dir, 't.db'), bank, vault: '' } as Partial<Config> as Config))
  let conclusions = 0
  const exec = { signal: new AbortController().signal, concludeTurn: () => { conclusions++ } }
  const run = (name: string, args: any = {}) => tools.get(name).execute(args, exec)
  await assert.rejects(run('tutor_quiz'), { code: 'TUTOR_REFUSED' })
  assert.equal(conclusions, 0, 'a refused quiz must allow the model to explain or recover')
  await run('tutor_build', { modules: [{ name: 'Signs', knowledge_points: [{ id: 'sign', name: 'Opposites', type: 'memory', question_ids: ['q1'] }] }] })
  const posed = await run('tutor_quiz')
  assert.ok(tools.get('tutor_quiz').output.presentationMeta({}, posed).body)
  assert.equal(conclusions, 1, 'the rendered question must end the turn before an assistant echo')
  const reposed = await run('tutor_quiz')
  assert.equal(reposed.reposed, true)
  assert.deepEqual(reposed.question, posed.question)
  assert.equal(conclusions, 2, 'showing an already-open question must also end the turn')
})

test('paper tool writes a self-contained HTML file and keeps the pending lesson unchanged', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tutor-paper-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bank = join(dir, 'bank.jsonl')
  writeFileSync(bank, [
    { id: 'q1', type: 'single', subject: 'math', content: '函数 \\(y=2x+1\\) 的图象经过哪一点？', options: ['(0, 1)', '(1, 0)'], answer: 'A' },
    { id: 'q2', type: 'open', subject: 'math', content: '求一次函数解析式。', answer: 'SECRET_REFERENCE_ANSWER' },
  ].map(row => JSON.stringify(row)).join('\n'))
  const tools = new Map<string, any>()
  apply({ tools: { register: (def: any) => tools.set(def.name, def) }, systemPrompt: { section() {} } } as any,
    Config({ db: join(dir, 't.db'), bank, vault: '' } as Partial<Config> as Config))
  const exec = { signal: new AbortController().signal, concludeTurn() {} }
  const run = (name: string, args: any = {}) => tools.get(name).execute(args, exec)
  await run('tutor_build', { modules: [{ name: 'Existing lesson', knowledge_points: [{ id: 'fact', name: 'Graph', type: 'memory', question_ids: ['q1'] }] }] })
  await run('tutor_quiz')
  const before = await run('tutor_status')
  const args = { title: '一次函数专题测试', scope: '一次函数', subject: 'math', count: 2, knowledge_points: [
    { name: '求解析式', objective: '由条件求出一次函数解析式', question_ids: ['q2'] },
    { name: '图象与点', objective: '检验一个点是否在图象上', question_ids: ['q1'] },
  ] }
  const result = await run('tutor_paper', args)
  assert.ok(existsSync(result.html_path))
  assert.equal(resolve(result.html_path), result.html_path)
  const html = readFileSync(result.html_path, 'utf8')
  assert.ok(html.includes('katex'))
  assert.ok(!html.includes('SECRET_REFERENCE_ANSWER'))
  const output = tools.get('tutor_paper').output
  const modelText = JSON.parse(output.render(args, result)[0].text)
  assert.equal(modelText.count, 2)
  assert.ok(modelText.questions.every((question: any) => !('prompt' in question) && !('material' in question) && !('answer' in question)))
  const meta = output.presentationMeta(args, result)
  assert.equal(meta.html_path, result.html_path)
  assert.equal(typeof meta.body, 'string')
  assert.deepEqual(await run('tutor_status'), before)

  const files = readdirSync(join(dir, 'papers'))
  const empty = await run('tutor_paper', { ...args, knowledge_points: [
    { name: '未覆盖知识点', objective: '报告题库缺口', question_ids: [] },
  ] })
  assert.equal(empty.count, 0)
  assert.ok(empty.warnings.length)
  assert.equal(empty.html_path, undefined)
  assert.deepEqual(readdirSync(join(dir, 'papers')), files, 'zero-question analysis must not create a blank paper')
})

test('tools reach the engine and keep the answer key server-side', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tutor-'))
  const bank = join(dir, 'bank.jsonl')
  writeFileSync(bank, JSON.stringify({ id: 'q1', type: 'single', subject: 'geo', content: '<p>Capital of France?</p>', options: ['Lyon', 'Paris'], answer: 'B' }))
  const tools = new Map<string, any>()
  const sections: any[] = []
  const ctx: any = {
    tools: { register: (def: any) => tools.set(def.name, def) },
    systemPrompt: { section: (s: any) => sections.push(s) },
  }
  apply(ctx, Config({ db: join(dir, 't.db'), bank, sources: dir, vault: dir, indexFolder: 'my-index' } as Partial<Config> as Config))
  assert.equal(sections[0].name, 'tutor:protocol')
  const exec = { signal: new AbortController().signal, concludeTurn() {} }
  const run = (name: string, args: any = {}) => tools.get(name).execute(args, exec)

  const found = await run('tutor_bank_search', { query: 'France', subject: 'geo' })
  assert.deepEqual(found.questions.map((q: any) => q.id), ['q1'])
  await run('tutor_build', { modules: [{ name: 'Geo', knowledge_points: [{ id: 'fact', name: 'Capitals', type: 'memory', question_ids: ['q1'] }] }] })
  const quiz = await run('tutor_quiz')
  assert.deepEqual(quiz.question.options, { A: 'Lyon', B: 'Paris' })
  assert.ok(!('answer' in quiz.question) && !('explanation' in quiz.question))
  // Cards: projected into persisted meta, then shown as a generic result view.
  const present = (name: string, args: any, value: any) => {
    const tool = tools.get(name)
    return tool.presentResult(args, { content: [], isError: false, meta: tool.output.presentationMeta(args, value) })
  }
  const qCard = present('tutor_quiz', {}, quiz)
  assert.equal(qCard.title, '题目 · 单选 · 中档')
  assert.equal(qCard.content[0].text, 'Capital of France?\n\n**A.** Lyon\n\n**B.** Paris')
  const graded = await run('tutor_grade', { answer: 'B' })
  assert.equal(graded.correct, true)
  assert.match(present('tutor_grade', { answer: 'B' }, graded).title, /^✓ 正确/)
  assert.equal(tools.get('tutor_grade').presentResult({}, { content: [], isError: true }), undefined)
  await assert.rejects(run('tutor_grade', { answer: 'x' }), { code: 'TUTOR_REFUSED' })
  // Textbook reads: image paths stay out of the model's JSON; the card shows text only.
  const read = { ref: 'b/c', title: 'T', shown: [1, 2], text: [{ page: 1, text: 'ocr' }, { page: 2, text: 'two' }], notes: [],
    images: [{ page: 1, path: join(dir, 'p1.jpg') }] }
  const textbook = tools.get('tutor_textbook').output
  assert.ok(!textbook.render({ action: 'read' }, read)[0].text.includes('images'))
  const meta = textbook.presentationMeta({ action: 'read' }, read)
  assert.equal(meta.show_card, false)
  assert.equal(meta.images, undefined)
  assert.equal(meta.body, '**第 1 页**\n\nocr\n\n**第 2 页**\n\ntwo')
  assert.equal(textbook.presentationMeta({ action: 'read', show_card: false }, read).show_card, false)
  assert.equal(present('tutor_textbook', { action: 'read' }, read), undefined)
  assert.equal(present('tutor_textbook', { action: 'read', show_card: false }, read), undefined)
  assert.equal(present('tutor_textbook', { action: 'read', show_card: true }, read).title, meta.title)
  assert.equal(textbook.presentationMeta({ action: 'search', show_card: true }, { hits: [] }), null)
  // The panel's index folder reaches the engine.
  await assert.rejects(run('tutor_textbook', { action: 'list' }), { code: 'TUTOR_REFUSED', message: /my-index/ })
})

test('cards render bank HTML and textbook pages as markdown', () => {
  assert.equal(
    htmlToMarkdown('<p>若\\(x<sup>2</sup>=4\\)，则 x=[[_]]&nbsp;<u> </u></p><img class="a" src="https://x/1.png" width="3">'),
    '若$x^2=4$，则 x=____ ____\n\n![](https://x/1.png)',
  )
  const card = knowledgeCard({
    title: '有理数', shown: [5, 6], next_page: 7,
    text: [{ page: 5, text: '正数和负数' }, { page: 6, text: '' }],
    notes: [{ title: '相反数', page: 6, content_type: '概念', text: '只有符号不同' }],
  })
  assert.equal(card.title, '知识卡 · 有理数 · 第 5–6 页')
  assert.equal(card.body, '**第 5 页**\n\n正数和负数\n\n---\n\n### 学习笔记\n\n**相反数** · 第 6 页 · 概念\n\n只有符号不同\n\n_续读：第 7 页起_')
})
