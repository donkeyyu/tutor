// Smoke test: mount the plugin on a fake ctx and drive the real Python engine.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { htmlToMarkdown, knowledgeCard } from '../src/cards.ts'
import { apply, Config } from '../src/index.ts'

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
  const exec = { signal: new AbortController().signal }
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
  // Textbook reads: image paths stay out of the model's text; the card inlines the images.
  const jpg = join(dir, 'p1.jpg')
  writeFileSync(jpg, 'jpg')
  const read = { ref: 'b/c', title: 'T', shown: [1, 2], text: [{ page: 1, text: 'ocr' }, { page: 2, text: 'two' }], notes: [],
    images: [{ page: 1, path: jpg }, { page: 2, path: join(dir, 'gone.jpg') }] }
  const textbook = tools.get('tutor_textbook').output
  assert.ok(!textbook.render({ action: 'read' }, read)[0].text.includes('images'))
  const meta = textbook.presentationMeta({ action: 'read' }, read)
  assert.deepEqual(meta.images, [{ page: 1, src: `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}` }])
  assert.equal(meta.body, '**第 2 页**\n\ntwo')
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
