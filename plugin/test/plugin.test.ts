// Smoke test: mount the plugin on a fake ctx and drive the real Python engine.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
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
  assert.equal((await run('tutor_grade', { answer: 'B' })).correct, true)
  await assert.rejects(run('tutor_grade', { answer: 'x' }), { code: 'TUTOR_REFUSED' })
  // The panel's index folder reaches the engine.
  await assert.rejects(run('tutor_textbook', { action: 'list' }), { code: 'TUTOR_REFUSED', message: /my-index/ })
})
