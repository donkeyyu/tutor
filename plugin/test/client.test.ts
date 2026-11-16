import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { gradeCard, knowledgeCard, questionCard } from '../src/cards.ts'

function loadClient() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-tool'))
  let plugin: any
  const MarkdownText = Symbol('DSH MarkdownText')
  const createElement = (type: unknown, props: any, ...children: any[]) => ({ type, props, children: children.flat(Infinity) })
  const states = new Map<string, any[]>()
  let activeState: any[] = []
  let cursor = 0
  const useState = (initial: unknown) => {
    const state = activeState
    const index = cursor++
    if (!(index in state)) state[index] = initial
    return [state[index], (next: unknown) => { state[index] = next }]
  }
  runInNewContext(readFileSync(new URL(`../${pkg.exports['./client']}`, import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ id, factory }: any) => {
      assert.equal(id, pkg.name)
      plugin = factory((name: string) => {
        if (name === 'react') return { createElement, useState }
        assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives')
        return { MarkdownText }
      })
    } } },
  })
  const views = new Map<string, any>()
  plugin.apply({ slots: {
    inject: (name: string, register: () => unknown) => {
      assert.equal(name, 'tool.call.toolview')
      return register()
    },
    register: ({ name, key }: any, view: any) => {
      assert.equal(name, 'tool.call.toolview')
      views.set(key, (props: any) => {
        activeState = states.get(key) ?? []
        states.set(key, activeState)
        cursor = 0
        return view({ useInput: (select: any) => select({ draft: '', phase: 'plain' }), ...props })
      })
    },
  } })
  return { views, MarkdownText }
}

test('web tool slots render persisted card Markdown instead of the raw JSON', () => {
  const { views, MarkdownText } = loadClient()
  assert.deepEqual([...views.keys()].sort(), ['tutor_grade', 'tutor_quiz', 'tutor_textbook'])
  const cards = {
    tutor_quiz: questionCard({ question: {
      question_type: 'single', difficulty: 1, prompt: '<p>求 \\(x+1\\)</p>', options: { A: '2', B: '3' },
    } }),
    tutor_grade: gradeCard({ correct: true, expected_answer: 'A', mastery: 0.5 }),
    tutor_textbook: knowledgeCard({ title: '方程', shown: [2, 2], text: [{ page: 2, text: '等式的性质' }] }),
  }
  for (const [toolName, meta] of Object.entries(cards)) {
    const row = views.get(toolName)({
      toolName, phase: 'result', t: (key: string) => key,
      block: { kind: 'tool-result', isError: false, meta, content: [{ type: 'text', text: '{"raw":"model JSON"}' }] },
    })
    assert.equal(row.children[0].children[0], meta.title)
    assert.equal(row.children[1].type, MarkdownText)
    assert.equal(row.children[1].props.text, meta.body)
    assert.equal(row.children[1].props.labels.code.copyLabel, 'copy')
  }
})

function elements(node: any): any[] {
  return node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(elements)] : []
}

function quizProps(type = 'single', initialDraft = '') {
  const value = { question: {
    question_id: 'q-select', question_type: type, difficulty: 1,
    prompt: '<p>求 \\(x+1\\)</p>', options: { A: '2', B: '3' },
  } }
  const input = { draft: initialDraft, phase: 'plain' }
  const props = {
    toolName: 'tutor_quiz', phase: 'result', t: (key: string) => key,
    useInput: (select: any) => select(input),
    inputActions: { setDraft: (text: string) => { input.draft = text } },
    block: { callId: 'call-select', kind: 'tool-result', isError: false,
      meta: questionCard(value), content: [{ type: 'text', text: JSON.stringify(value) }] },
  }
  return { props, input }
}

function knowledgeProps(nextPage: number | null = 131, draft = '') {
  const value = {
    ref: 'book/chapter-5.2', title: '5.2 解一元一次方程', shown: [127, 130], pages: [127, 139], next_page: nextPage,
    text: [127, 128, 129, 130].map(page => ({ page, text: `第 ${page} 页原文\n${'等式两边同时乘以公分母。'.repeat(50)}` })),
    notes: [{ title: '去分母', page: 127, content_type: '方法', text: '每一项都要乘。' },
      { title: '例题', page: 128, text: '$2(x-1)=6$' }],
  }
  const input = { draft, draftRev: 0, phase: 'plain' }
  const props = {
    toolName: 'tutor_textbook', phase: 'result', t: (key: string) => key,
    useInput: (select: any) => select(input),
    inputActions: {
      insertText: (text: string, span: any) => {
        assert.equal(span.draftRev, input.draftRev)
        assert.equal(span.start, input.draft.length)
        assert.equal(span.end, input.draft.length)
        input.draft += text
        input.draftRev++
        return true
      },
      submit: () => assert.fail('continuation must not send without the learner'),
    },
    block: { callId: 'read-legacy', kind: 'tool-result', isError: false,
      content: [{ type: 'text', text: JSON.stringify(value) }] },
  }
  return { value, props, input }
}

test('older textbook reads render every page and note as a knowledge card without saved metadata', () => {
  const { views, MarkdownText } = loadClient()
  const { value, props } = knowledgeProps()
  const row = views.get('tutor_textbook')(props)
  const expected = knowledgeCard(value)
  assert.equal(row.children[0].children[0], expected.title)
  const markdown = elements(row).find(node => node.type === MarkdownText)
  assert.equal(markdown?.props.text, expected.body)
  assert.ok(!elements(row).some(node => node.type === 'pre'))
})

test('continuation stages the correct chapter and next page while preserving the existing draft', () => {
  const { views } = loadClient()
  const { props, input } = knowledgeProps(131, 'Keep my draft.')
  const render = () => views.get('tutor_textbook')(props)
  const next = () => elements(render()).find(node => node.type === 'button' && node.children.join('').includes('续读'))
  assert.ok(next())
  assert.ok(next().children.join('').includes('131'))
  next().props.onClick()
  assert.ok(input.draft.startsWith('Keep my draft.\n\n'))
  assert.ok(input.draft.includes('book/chapter-5.2'))
  assert.ok(input.draft.includes('131'))
  const staged = input.draft
  next().props.onClick()
  assert.equal(input.draft, staged)
  input.draft = 'Keep my draft.'
  assert.ok(!elements(render()).some(node => node.props?.role === 'status'))
  input.phase = 'sending'
  assert.equal(next().props.disabled, true)
  for (const page of [null, 0, 130, 140, 1.5]) {
    const last = knowledgeProps(page)
    assert.ok(!elements(views.get('tutor_textbook')(last.props)).some(node => node.type === 'button' && node.children.join('').includes('续读')))
  }
})

test('textbook lists, search results, malformed reads and errors keep their raw fallback', () => {
  const { views } = loadClient()
  for (const value of [{ textbooks: [] }, { hits: [] }, { ref: 'book/chapter', title: 'incomplete', shown: [1, 2] }]) {
    const { props } = knowledgeProps()
    props.block.content[0].text = JSON.stringify(value)
    const row = views.get('tutor_textbook')(props)
    assert.equal(row.children[1].type, 'pre')
    assert.equal(row.children[1].children[0], props.block.content[0].text)
  }
  const { props } = knowledgeProps()
  props.block.isError = true
  assert.equal(views.get('tutor_textbook')(props).children[1].type, 'pre')
})

test('clicking a single-choice option selects it and stages its letter without sending', () => {
  const { views, MarkdownText } = loadClient()
  const { props, input } = quizProps()
  const render = () => views.get('tutor_quiz')(props)
  const choices = () => elements(render()).filter(node => node.type === 'input')
  assert.equal(choices().length, 2)
  assert.equal(choices()[0].props.type, 'radio')
  choices()[0].props.onChange()
  assert.equal(input.draft, 'A')
  assert.equal(choices()[0].props.checked, true)
  choices()[1].props.onChange()
  assert.equal(input.draft, 'B')
  assert.equal(choices()[0].props.checked, false)
  assert.equal(choices()[1].props.checked, true)
  assert.deepEqual(elements(render()).filter(node => node.type === MarkdownText).map(node => node.props.text), ['求 $x+1$', '2', '3'])
})

test('multiple-choice options toggle independently and preserve an existing chat draft', () => {
  const { views } = loadClient()
  const { props, input } = quizProps('multi')
  const render = () => views.get('tutor_quiz')(props)
  const choices = () => elements(render()).filter(node => node.type === 'input')
  assert.equal(choices()[0].props.type, 'checkbox')
  choices()[0].props.onChange()
  choices()[1].props.onChange()
  assert.equal(input.draft, 'AB')
  choices()[0].props.onChange()
  assert.equal(input.draft, 'B')
  input.draft = 'Keep my working here'
  choices()[0].props.onChange()
  assert.equal(input.draft, 'Keep my working here')
  assert.ok(choices().every(node => node.props.checked))
  input.phase = 'sending'
  assert.ok(choices().every(node => node.props.disabled))
})

test('web cards keep loading, errors and results without card metadata visible', () => {
  const { views } = loadClient()
  const view = views.get('tutor_quiz')
  const t = (key: string) => key
  for (const phase of ['preparing', 'start']) {
    const row = view({ toolName: 'tutor_quiz', phase, block: {}, t })
    assert.equal(row.props.role, 'status')
    assert.ok(JSON.stringify(row).includes('tutor_quiz'))
  }
  for (const meta of [undefined, null, { title: 'invalid' }]) {
    const row = view({ toolName: 'tutor_textbook', phase: 'result', t,
      block: { isError: false, meta, content: [{ type: 'text', text: 'raw result' }] },
    })
    assert.ok(JSON.stringify(row).includes('raw result'))
  }
  const row = view({ toolName: 'tutor_quiz', phase: 'result', t,
    block: { isError: true, meta: { title: 'stale card', body: 'must not appear' }, content: [{ type: 'text', text: 'TutorRefusal' }] },
  })
  assert.equal(row.props.role, 'alert')
  assert.ok(JSON.stringify(row).includes('TutorRefusal'))
  assert.ok(!JSON.stringify(row).includes('must not appear'))
})
