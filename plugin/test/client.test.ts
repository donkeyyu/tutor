import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { gradeCard, knowledgeCard, questionCard } from '../src/cards.ts'

function loadClient() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-tool'))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-chat'))
  let plugin: any
  const MarkdownText = Symbol('DSH MarkdownText')
  const createElement = (type: any, props: any, ...children: any[]): any => typeof type === 'function'
    ? type({ ...props, children: children.flat(Infinity) })
    : { type, props, children: children.flat(Infinity) }
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
  const nodes = new Map<string, any>()
  const definitions: any[] = []
  plugin.apply({ slots: {
    inject: (name: string, register: () => unknown) => {
      assert.ok(['tool.call.toolview', 'conversation.chat.node'].includes(name))
      return register()
    },
    register: ({ name, key }: any, view: any) => {
      const registry = name === 'tool.call.toolview' ? views : nodes
      registry.set(key, (props: any) => {
        const stateKey = `${name}/${props.node?.id ?? props.block?.callId ?? key}`
        activeState = states.get(stateKey) ?? []
        states.set(stateKey, activeState)
        cursor = 0
        return view({ useInput: (select: any) => select({ draft: '', phase: 'plain' }), ...props })
      })
    },
  }, uiConversation: { events: { register: (definition: any) => definitions.push(definition) } } })
  const renderCard = (props: any) => props.toolName === 'tutor_grade' ? views.get(props.toolName)(props)
    : nodes.get('tutor-card')({ ...props, node: { id: props.block.callId, data: { toolName: props.toolName, block: props.block } } })
  return { views, nodes, definitions, MarkdownText, renderCard }
}

test('conversation cards render persisted Markdown instead of the raw JSON', () => {
  const { views, MarkdownText, renderCard } = loadClient()
  assert.deepEqual([...views.keys()].sort(), ['tutor_grade', 'tutor_quiz', 'tutor_textbook'])
  const cards = {
    tutor_quiz: questionCard({ question: {
      question_type: 'single', difficulty: 1, prompt: '<p>求 \\(x+1\\)</p>', options: { A: '2', B: '3' },
    } }),
    tutor_grade: gradeCard({ correct: true, expected_answer: 'A', mastery: 0.5 }),
    tutor_textbook: knowledgeCard({ title: '方程', shown: [2, 2], text: [{ page: 2, text: '等式的性质' }] }),
  }
  for (const [toolName, meta] of Object.entries(cards)) {
    const row = renderCard({
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

function callEvents(props: any) {
  const callId = props.block.callId
  return [
    { type: 'tool/call', seq: 10, time: 100, data: { callId, name: props.toolName, arguments: '{}', turn: 1, step: 1 } },
    { type: 'tool/result', seq: 11, time: 110, surfaceOp: 'append', data: {
      message: { source: { callId }, content: props.block.content, isError: props.block.isError }, meta: props.block.meta,
    } },
  ]
}

function project(definition: any, events: any[]) {
  assert.ok(definition, 'the tutor must register a conversation card definition')
  const contexts = new Map<string, any>()
  for (const event of events) {
    const match = definition.match[event.type]?.(event)
    if (!match) continue
    const location = { kind: 'step', turn: { turn: 1, status: 'closed' }, step: { turn: 1, step: 1 } }
    const accepted = { event, role: match.role, location }
    let context = contexts.get(match.id)
    if (!context) {
      context = { key: `${definition.kind}:${match.id}`, kind: definition.kind, id: match.id, matches: [], current: new Map() }
      contexts.set(match.id, context)
    }
    context.matches.push(accepted)
    if (match.role === 'start' && !context.start) {
      context.start = accepted
      context.state = definition.start(context, accepted)
    } else if (context.start) {
      context.state = definition.update(context, accepted)
    }
  }
  return [...contexts.values()].map(context => definition.buildViewNode(context)).filter(Boolean)
}

test('question and knowledge cards stay outside the thinking group on live results and replay', () => {
  const { definitions, views, nodes } = loadClient()
  const definition = definitions.find(definition => definition.kind === 'tutor-card')
  assert.ok(nodes.has('tutor-card'))
  for (const { props } of [quizProps(), knowledgeProps()]) {
    const events = callEvents(props)
    const [node] = project(definition, events)
    assert.ok(node)
    assert.equal(node.target, 'chat')
    assert.equal(node.kind, 'tutor-card')
    assert.equal(node.groupTree, 'turn', 'turn items stay outside both step and whole-turn process folding')
    assert.equal(node.visibility, 'visible')
    assert.equal(node.anchorSeq, events[1].seq)
    assert.equal(node.data.toolName, props.toolName)
    assert.equal(node.data.block.callId, props.block.callId)
    assert.deepEqual(node.data.block.content, props.block.content)
    assert.equal(project(definition, events)[0].key, node.key, 'replay uses the same card identity')
    let inspected: string | undefined
    const card = nodes.get('tutor-card')({ ...props, node, inspectCall: (id: string) => { inspected = id } })
    assert.equal(card.props['data-tutor-card'], props.toolName)
    const inspect = elements(card).find(element => element.type === 'button' && element.children.includes('row.inspect'))
    inspect.props.onClick()
    assert.equal(inspected, props.block.callId)
    const toolRow = views.get(props.toolName)(props)
    assert.ok(!elements(toolRow).some(element => element.props?.['data-tutor-card']), 'thinking keeps only the tool record')
    assert.ok(!elements(toolRow).some(element => element.type === 'img' || element.type === 'input'))
  }
})

test('loading, failed tools, textbook searches and unrelated tools do not create conversation cards', () => {
  const { definitions } = loadClient()
  const definition = definitions.find(definition => definition.kind === 'tutor-card')
  const { props } = quizProps()
  assert.equal(project(definition, callEvents(props).slice(0, 1)).length, 0)
  props.block.isError = true
  assert.equal(project(definition, callEvents(props)).length, 0)
  for (const value of [{ textbooks: [] }, { hits: [] }, { title: 'broken read', shown: [1, 2] }]) {
    const { props } = knowledgeProps()
    props.block.content[0].text = JSON.stringify(value)
    assert.equal(project(definition, callEvents(props)).length, 0)
  }
  const unrelated = quizProps().props
  unrelated.toolName = 'other_quiz'
  assert.equal(project(definition, callEvents(unrelated)).length, 0)
  assert.equal(project(definition, callEvents(quizProps().props).slice(1)).length, 0, 'a result without its tool name is not guessed')
  const replaced = callEvents(quizProps().props)
  replaced[1].surfaceOp = 'replace'
  assert.equal(project(definition, replaced).length, 0)
})

test('nested tutor calls publish their own cards without exposing unrelated subcalls', () => {
  const { definitions } = loadClient()
  const definition = definitions.find(definition => definition.kind === 'tutor-card')
  const { props } = knowledgeProps()
  const nested = { type: 'tool/ptc-dispatch', seq: 20, time: 200, data: {
    subCallId: 'nested-read', parentCallId: 'code', rootCallId: 'code', name: props.toolName,
    arguments: { action: 'read' }, content: props.block.content, isError: false,
  } }
  const [node] = project(definition, [nested])
  assert.equal(node.groupTree, 'turn')
  assert.equal(node.data.block.callId, 'nested-read')
  assert.equal(node.anchorSeq, 20)
  assert.equal(project(definition, [{ ...nested, data: { ...nested.data, name: 'read' } }]).length, 0)
})

test('older textbook reads render every page and note as a knowledge card without saved metadata', () => {
  const { renderCard, MarkdownText } = loadClient()
  const { value, props } = knowledgeProps()
  const row = renderCard(props)
  const expected = knowledgeCard(value)
  assert.equal(row.children[0].children[0], expected.title)
  const markdown = elements(row).find(node => node.type === MarkdownText)
  assert.equal(markdown?.props.text, expected.body)
  assert.ok(!elements(row).some(node => node.type === 'pre'))
})

test('continuation stages the correct chapter and next page while preserving the existing draft', () => {
  const { renderCard } = loadClient()
  const { props, input } = knowledgeProps(131, 'Keep my draft.')
  const render = () => renderCard(props)
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
    assert.ok(!elements(renderCard(last.props)).some(node => node.type === 'button' && node.children.join('').includes('续读')))
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
  const { renderCard, MarkdownText } = loadClient()
  const { props, input } = quizProps()
  const render = () => renderCard(props)
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
  const { renderCard } = loadClient()
  const { props, input } = quizProps('multi')
  const render = () => renderCard(props)
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

test('textbook cards show rendered page images above the remaining text and notes', () => {
  const { renderCard, MarkdownText } = loadClient()
  const { value, props } = knowledgeProps()
  const src = 'data:image/jpeg;base64,AAAA'
  const meta = knowledgeCard(value, [{ page: 127, src }, { page: 128, src: 'javascript:alert(1)' }])
  const row = renderCard({ ...props, block: { ...props.block, meta } })
  // Only inline JPEG data reaches an <img>.
  assert.deepEqual(elements(row).filter(node => node.type === 'img').map(node => node.props.src), [src])
  const markdown = elements(row).find(node => node.type === MarkdownText)
  assert.ok(!markdown.props.text.includes('第 127 页原文') && markdown.props.text.includes('第 129 页原文'))
  assert.ok(markdown.props.text.includes('去分母'))
})
