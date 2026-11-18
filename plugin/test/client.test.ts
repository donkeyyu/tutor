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
  const frames = new Map<string, any>()
  const definitions: any[] = []
  plugin.apply({ slots: {
    inject: (name: string, register: () => unknown) => {
      assert.ok(['tool.call.toolview', 'conversation.chat.node', 'conversation.hero.frame'].includes(name))
      return register()
    },
    register: ({ name, key, id }: any, view: any) => {
      const registry = name === 'tool.call.toolview' ? views : name === 'conversation.hero.frame' ? frames : nodes
      key ??= id
      registry.set(key, (props: any) => {
        const stateKey = `${name}/${props.node?.id ?? props.block?.callId ?? key}`
        activeState = states.get(stateKey) ?? []
        states.set(stateKey, activeState)
        cursor = 0
        return view({ useInput: (select: any) => select({ draft: '', phase: 'plain' }), ...props })
      })
    },
  }, uiConversation: { events: { register: (definition: any) => definitions.push(definition) } } })
  const renderCard = (props: any) =>
    nodes.get('tutor-card')({ ...props, node: { id: props.block.callId, data: { toolName: props.toolName, block: props.block } } })
  return { views, nodes, frames, definitions, MarkdownText, renderCard }
}

test('welcome appears on each demo visit and dismisses without replacing the conversation', () => {
  for (const hero of [true, false]) {
    const { frames } = loadClient()
    const frame = frames.get('tutor-welcome')
    const children = { type: 'composer and conversation', children: [] }
    const render = () => frame({ hero, children })
    const welcome = () => elements(render()).find(node => node.props?.['data-tutor-welcome'])
    assert.ok(welcome())
    assert.equal(welcome().props.lang, 'zh-CN')
    assert.ok(elements(render()).includes(children))
    const dismiss = elements(welcome()).find(node => node.type === 'button')
    dismiss.props.onClick()
    assert.equal(welcome(), undefined)
    assert.ok(elements(render()).includes(children))
    const nextVisit = loadClient().frames.get('tutor-welcome')({ hero, children })
    assert.ok(elements(nextVisit).some(node => node.props?.['data-tutor-welcome']))
  }
})

test('conversation cards render persisted Markdown instead of the raw JSON', () => {
  const { views, MarkdownText, renderCard } = loadClient()
  assert.deepEqual([...views.keys()].sort(), ['tutor_grade', 'tutor_paper', 'tutor_quiz', 'tutor_textbook'])
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
      meta: { ...knowledgeCard(value), show_card: true },
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

test('paper blueprint stays in chat and opens the native sidebar only after a click, including replay', () => {
  const { definitions, nodes, MarkdownText } = loadClient()
  const definition = definitions.find(definition => definition.kind === 'tutor-card')
  const props = {
    toolName: 'tutor_paper', phase: 'result', t: (key: string) => key,
    block: { callId: 'paper-1', kind: 'tool-result', isError: false,
      meta: { title: '组卷 · 一次函数', body: '知识点拆解及逐题细目', html_path: '/demo/data/papers/paper-1.html' },
      content: [{ type: 'text', text: '{}' }] },
  }
  const opened: string[] = []
  const events = callEvents(props)
  for (const replay of [false, true]) {
    const [node] = project(definition, events)
    const row = nodes.get('tutor-card')({ ...props, node, openFile: (path: string) => opened.push(path) })
    assert.equal(opened.length, replay ? 2 : 0, 'rendering/replaying the card must not open the sidebar')
    const details = elements(row).find(element => element.type === MarkdownText)
    assert.equal(details.props.text, props.block.meta.body)
    const links = elements(row).filter(element => element.props?.['data-tutor-paper-open'])
    assert.equal(links.length, 2)
    assert.ok(row.children.indexOf(links[0]) < row.children.indexOf(details))
    assert.ok(row.children.lastIndexOf(links[1]) > row.children.indexOf(details))
    for (const link of links) {
      assert.equal(link.props.style.color, 'color-mix(in srgb, var(--dsw-alias-link) 90%, var(--dsw-alias-label-primary))')
      assert.equal(link.props.style.textDecoration, 'underline')
      link.props.onClick()
      assert.equal(opened.at(-1), props.block.meta.html_path)
    }
  }
  const noPaper = { ...props, block: { ...props.block, meta: { title: '组卷 · 缺题', body: '暂无匹配题目' } } }
  const [node] = project(definition, callEvents(noPaper))
  const empty = nodes.get('tutor-card')({ ...noPaper, node, openFile: () => assert.fail('no HTML was generated') })
  assert.ok(!elements(empty).some(element => element.props?.['data-tutor-paper-open']))
})

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

test('question, grading and knowledge cards stay outside the thinking group on live results and replay', () => {
  const { definitions, views, nodes } = loadClient()
  const definition = definitions.find(definition => definition.kind === 'tutor-card')
  assert.ok(nodes.has('tutor-card'))
  const result = { correct: true, expected_answer: 'A', mastery: 0.5 }
  const grade = {
    toolName: 'tutor_grade', phase: 'result', t: (key: string) => key,
    block: { callId: 'call-grade', kind: 'tool-result', isError: false, meta: gradeCard(result), content: [{ type: 'text', text: JSON.stringify(result) }] },
  }
  for (const props of [quizProps().props, grade, knowledgeProps().props]) {
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
    const card = nodes.get('tutor-card')({ ...props, node, inspectCall: () => assert.fail('Inspect is hidden') })
    assert.equal(card.props['data-tutor-card'], props.toolName)
    assert.ok(!elements(card).some(element => element.type === 'button' && element.children.includes('row.inspect')))
    const toolRow = views.get(props.toolName)({ ...props, inspect: () => assert.fail('Inspect is hidden') })
    assert.ok(!elements(toolRow).some(element => element.props?.['data-tutor-card']), 'thinking keeps only the tool record')
    assert.ok(!elements(toolRow).some(element => ['img', 'input', 'button'].includes(element.type)))
  }
})

test('textbook reads stay hidden unless explicitly shown, including legacy replay and nested calls', () => {
  const { definitions, views } = loadClient()
  const definition = definitions.find(definition => definition.kind === 'tutor-card')
  const { props } = knowledgeProps()
  for (const meta of [undefined, { title: 'Old knowledge card', body: 'Full chapter text' },
    { ...props.block.meta, show_card: false }, { ...props.block.meta, show_card: 'true' }]) {
    const hidden = { ...props, block: { ...props.block, meta } }
    const events = callEvents(hidden)
    assert.equal(project(definition, events).length, 0)
    assert.equal(project(definition, events).length, 0, 'replay stays hidden')
    assert.equal(project(definition, [{ type: 'tool/ptc-dispatch', seq: 20, time: 200, data: {
      subCallId: 'nested-read', name: props.toolName, arguments: { action: 'read' },
      content: props.block.content, meta, isError: false,
    } }]).length, 0)
    const toolRow = views.get(props.toolName)(hidden)
    assert.ok(!elements(toolRow).some(element => element.props?.['data-tutor-card'] || element.type === 'pre'))
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
    delete (props.block as any).meta
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
    arguments: { action: 'read', show_card: true }, content: props.block.content, meta: props.block.meta, isError: false,
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
  delete (props.block as any).meta
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
    delete (props.block as any).meta
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

test('textbook cards show page text and notes without inlining PDF page images', () => {
  const { renderCard, MarkdownText } = loadClient()
  const { value, props } = knowledgeProps()
  const meta = knowledgeCard(value)
  assert.ok(!('images' in meta))
  const row = renderCard({ ...props, block: { ...props.block, meta } })
  assert.deepEqual(elements(row).filter(node => node.type === 'img'), [])
  const markdown = elements(row).find(node => node.type === MarkdownText)
  assert.ok(markdown.props.text.includes('第 127 页原文') && markdown.props.text.includes('第 130 页原文'))
  assert.ok(markdown.props.text.includes('去分母'))
})
