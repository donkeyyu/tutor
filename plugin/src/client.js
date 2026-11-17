// DSH loads browser entries as module factories. Plain JS needs no build step.
window.__ModuleLoader__.load({
  id: 'dsh-tutor',
  factory(require) {
    const { createElement: h, useState } = require('react')
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')

    const welcomeStyles = `
      .tutor-frame { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; }
      .tutor-welcome { box-sizing:border-box; flex:none; width:calc(100% - 32px); max-width:var(--dsh-composer-card-max-width, 960px); max-height:60dvh; overflow:auto; margin:16px auto 8px; padding:0 8px 16px; border-bottom:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); font-size:14px; line-height:1.7; overflow-wrap:anywhere; }
      .tutor-welcome-header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:8px; }
      .tutor-welcome h2 { margin:0; padding-top:6px; font-size:22px; line-height:1.4; font-weight:600; }
      .tutor-welcome p { margin:0 0 12px; }
      .tutor-welcome-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:24px; }
      .tutor-welcome ul { margin:0; padding-left:20px; }
      .tutor-welcome li + li { margin-top:8px; }
      .tutor-welcome li span { color:var(--dsw-alias-label-secondary); }
      .tutor-welcome summary { cursor:pointer; padding:8px 0; }
      .tutor-welcome blockquote { margin:0; padding:12px 16px; border-radius:12px; background:var(--dsw-alias-markdown-code-block); overflow-wrap:anywhere; }
      .tutor-welcome .tutor-memory { color:var(--dsw-alias-label-secondary); }
      .tutor-welcome .tutor-welcome-footer { margin:12px 0 0; font-size:12px; color:var(--dsw-alias-label-secondary); }
      .tutor-welcome button { flex:none; min-height:44px; padding:8px 16px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
      .tutor-welcome button:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .tutor-welcome:focus-visible, .tutor-welcome button:focus-visible, .tutor-welcome summary:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:3px; }
      @media (max-width:640px) { .tutor-welcome-grid { grid-template-columns:minmax(0, 1fr); gap:8px; } .tutor-welcome h2 { font-size:20px; } }
    `

    function TutorWelcomeFrame({ children }) {
      // Demo visits always start with guidance; dismissing it never changes learner data.
      const [visible, setVisible] = useState(true)
      return h('div', { className: 'tutor-frame' },
        h('style', null, welcomeStyles),
        visible && h('section', { className: 'tutor-welcome', 'data-tutor-welcome': true, lang: 'zh-CN', 'aria-label': '学习助教欢迎与使用引导', tabIndex: 0 },
          h('div', { className: 'tutor-welcome-header' },
            h('h2', null, '你好，我是你的学习助教'),
            h('button', { type: 'button', onClick: () => setVisible(false) }, '收起引导')),
          h('p', null, '我会陪你读教材、讲清知识点，再用练习检查掌握情况。'),
          h('p', { className: 'tutor-memory' }, '我会记录你提供的学习信息和交流偏好，方便后续接着学；你也可以随时补充或修改。'),
          h('p', null, '在下方聊天框告诉我：'),
          h('div', { className: 'tutor-welcome-grid' },
            h('ul', null,
              h('li', null, h('strong', null, '年级与基础：'), h('span', null, '你读几年级，哪些地方还不熟？')),
              h('li', null, h('strong', null, '想学什么：'), h('span', null, '哪一科、哪个知识点？演示可先体验七年级数学「有理数」。')),
              h('li', null, h('strong', null, '希望我怎么讲：'), h('span', null, '多举例、一步步提示，或先试做再讲。'))),
            h('details', null,
              h('summary', null, '查看填写示例'),
              h('blockquote', null, '我读七年级，想学数学的有理数。请用中文，先举例，再一步步带我练习。今天大约有 15 分钟。'))),
          h('p', { className: 'tutor-welcome-footer' }, '演示每次打开都会展示这段引导，已有学习档案会保留，无需重复填写。')),
        children)
    }

    function knowledgeResult(block) {
      try {
        const value = JSON.parse(block.content.find(part => part.type === 'text').text)
        if (typeof value.ref !== 'string' || !value.ref.trim() || typeof value.title !== 'string'
          || !Array.isArray(value.shown) || value.shown.length !== 2
          || !value.shown.every(page => Number.isInteger(page) && page > 0) || value.shown[1] < value.shown[0]
          || !Array.isArray(value.text) || !value.text.every(page => Number.isInteger(page.page) && page.page > 0 && typeof page.text === 'string')
          || !Array.isArray(value.notes ?? []) || !(value.notes ?? []).every(note => typeof note.title === 'string' && Number.isInteger(note.page) && note.page > 0 && typeof note.text === 'string')) return null
        return value
      } catch {
        return null
      }
    }

    // Older sessions saved only JSON. Rebuild the same display without rewriting history.
    function legacyKnowledgeCard(value) {
      const [from, to] = value.shown
      const parts = value.text.filter(page => page.text.trim()).map(page => `**第 ${page.page} 页**\n\n${page.text.trim()}`)
      if (!parts.length) parts.push('_这些页面没有可提取的文字（可能是图片页）。_')
      if (value.notes?.length) parts.push('---', '### 学习笔记', ...value.notes.map(note => `**${note.title}** · 第 ${note.page} 页${note.content_type ? ` · ${note.content_type}` : ''}\n\n${note.text}`))
      if (value.next_page) parts.push(`_续读：第 ${value.next_page} 页起_`)
      return { title: `知识卡 · ${value.title} · 第 ${from === to ? from : `${from}–${to}`} 页`, body: parts.join('\n\n') }
    }

    function cardMeta(toolName, block) {
      if (block.isError) return null
      if (typeof block.meta?.title === 'string' && typeof block.meta.body === 'string') return block.meta
      const knowledge = toolName === 'tutor_textbook' && knowledgeResult(block)
      return knowledge ? legacyKnowledgeCard(knowledge) : null
    }

    function questionChoices(block, body) {
      try {
        const question = JSON.parse(block.content.find(part => part.type === 'text').text).question
        if (!['single', 'multi', 'judge'].includes(question?.question_type)) return null
        const labels = Object.keys(question.options ?? {})
        if (!labels.length || !labels.every(label => /^[A-Z]$/.test(label))) return null
        // questionCard emits these option paragraphs; preserve their Markdown on replay.
        const markers = labels.map(label => `\n\n**${label}.** `)
        const starts = markers.map(marker => body.lastIndexOf(marker))
        if (starts.some((start, i) => start < 0 || i > 0 && start <= starts[i - 1])) return null
        return {
          body: body.slice(0, starts[0]).trim(),
          multiple: question.question_type === 'multi',
          options: labels.map((label, i) => ({ label, text: body.slice(starts[i] + markers[i].length, starts[i + 1]).trim() })),
        }
      } catch {
        return null
      }
    }

    function TutorCard({ toolName, phase, block, inspect, t, useInput, inputActions, openFile }) {
      const [selected, setSelected] = useState([])
      const [continuationError, setContinuationError] = useState('')
      const input = useInput(state => state)
      if (phase !== 'result') {
        return h('div', { role: 'status' }, `${toolName} · ${t(phase === 'preparing' ? 'row.preparing' : 'bash.running')}`)
      }
      const knowledge = !block.isError && toolName === 'tutor_textbook' ? knowledgeResult(block) : null
      const meta = cardMeta(toolName, block)
      const card = meta !== null
      const paperPath = toolName === 'tutor_paper' && typeof meta?.html_path === 'string' ? meta.html_path : null
      const paperLink = paperPath && typeof openFile === 'function' && h('button', {
        type: 'button', 'data-tutor-paper-open': true, onClick: () => openFile(paperPath),
        style: { display: 'block', minHeight: '44px', margin: '12px 0', padding: '8px 0', border: 0, background: 'transparent', color: 'color-mix(in srgb, var(--dsw-alias-link) 90%, var(--dsw-alias-label-primary))', font: 'inherit', fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: '3px', cursor: 'pointer' },
      }, '查看试卷')
      const text = (block.content ?? []).map(part => part.type === 'text' ? part.text : JSON.stringify(part)).join('\n')
      const question = card && toolName === 'tutor_quiz' ? questionChoices(block, meta.body) : null
      const answer = selected.join('')
      const nextPage = knowledge && Number.isInteger(knowledge.next_page) && knowledge.next_page > knowledge.shown[1]
        && (!Array.isArray(knowledge.pages) || knowledge.next_page <= knowledge.pages[1]) ? knowledge.next_page : null
      const continuationRequest = nextPage ? `继续阅读《${knowledge.title}》，从第 ${nextPage} 页开始（章节：${knowledge.ref}）。` : ''
      const continuationNotice = continuationError || (continuationRequest && input.draft.endsWith(continuationRequest) ? '续读请求已填入聊天框，发送即可。' : '')
      const labels = {
        code: {
          copyLabel: t('copy'), copiedLabel: t('copied'),
          toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') },
        },
        footnotes: t('markdown.footnotes'),
      }
      function select(label) {
        if (input.phase !== 'plain') return
        const next = question.multiple
          ? question.options.map(option => option.label).filter(key => key === label ? !selected.includes(key) : selected.includes(key))
          : [label]
        setSelected(next)
        if (!input.draft || input.draft === answer) inputActions.setDraft(next.join(''))
      }
      function continueReading() {
        if (input.phase !== 'plain') return
        if (!input.draft.endsWith(continuationRequest)) {
          const end = input.draft.length
          if (!inputActions.insertText(`${end ? '\n\n' : ''}${continuationRequest}`, { start: end, end, draftRev: input.draftRev })) {
            setContinuationError('聊天框暂不可编辑，请稍后重试。')
            return
          }
        }
        setContinuationError('')
      }
      return h('section', {
        'data-tutor-card': card ? toolName : undefined,
        role: block.isError ? 'alert' : undefined,
        style: {
          boxSizing: 'border-box', minWidth: 0, width: '100%', maxWidth: '72ch', margin: '8px 0', padding: '24px',
          borderRadius: '16px', background: 'var(--dsw-alias-markdown-code-block)', color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('h3', { style: { margin: '0 0 20px', fontSize: '0.875rem', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' } }, card ? meta.title : toolName),
      ...(paperLink ? [paperLink] : []),
      card
        ? h(MarkdownText, { text: question?.body ?? meta.body, labels })
        : h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: block.isError ? 'var(--dsw-alias-state-error-primary)' : 'inherit' } }, text),
      ...(paperLink ? [paperLink] : []),
      question && h('div', {
        role: question.multiple ? 'group' : 'radiogroup', 'aria-label': '选择答案',
        style: { display: 'grid', gap: '8px', marginTop: '16px' },
      }, question.options.map(option => h('label', {
        key: option.label,
        style: {
          display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, padding: '12px', borderRadius: '12px',
          border: `1px solid ${selected.includes(option.label) ? 'var(--dsw-alias-state-business-primary)' : 'transparent'}`,
          background: selected.includes(option.label) ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent', cursor: input.phase === 'plain' ? 'pointer' : 'default',
        },
      },
      h('input', {
        type: question.multiple ? 'checkbox' : 'radio', name: `tutor-answer-${block.callId}`, value: option.label,
        checked: selected.includes(option.label), disabled: input.phase !== 'plain', onChange: () => select(option.label),
        style: { flexShrink: 0, margin: 0, accentColor: 'var(--dsw-alias-state-business-primary)' },
      }),
      h('span', { style: { flexShrink: 0, fontWeight: 500 } }, option.label),
      h('div', { style: { minWidth: 0, overflowX: 'auto' } }, h(MarkdownText, { text: option.text, labels }))))),
      nextPage && h('button', {
        type: 'button', 'data-tutor-continue': true, disabled: input.phase !== 'plain', onClick: continueReading,
        style: { display: 'block', minHeight: '44px', marginTop: '16px', padding: '10px 16px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px', background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', cursor: input.phase === 'plain' ? 'pointer' : 'default' },
      }, `续读：第 ${nextPage} 页起`),
      continuationNotice && h('p', { role: 'status', style: { fontSize: '0.875rem', color: 'var(--dsw-alias-label-secondary)' } }, continuationNotice),
      answer && h('p', { role: 'status', style: { margin: '12px 0 0', fontSize: '0.875rem', color: 'var(--dsw-alias-label-secondary)' } },
        `已选 ${answer} · ${input.draft === answer ? '已填入聊天框，发送即可' : '原草稿已保留'}`,
        input.draft !== answer && h('button', {
          type: 'button', disabled: input.phase !== 'plain',
          onClick: () => inputActions.insertText(answer, inputActions.captureInsertion()),
        }, '插入答案')),
      inspect && h('button', {
        type: 'button', onClick: inspect,
        style: { marginTop: '16px', padding: '4px 0', border: 0, background: 'transparent', font: 'inherit', fontSize: '0.75rem', color: 'var(--dsw-alias-label-secondary)', textDecoration: 'underline', textUnderlineOffset: '3px', cursor: 'pointer' },
      }, t('row.inspect')))
    }

    function TutorTool(props) {
      const meta = props.phase === 'result' && cardMeta(props.toolName, props.block)
      if (!meta) return h(TutorCard, props)
      return h('div', { 'data-tutor-tool': props.toolName, style: { color: 'var(--dsw-alias-label-secondary)' } },
        meta.title,
        props.inspect && h('button', {
          type: 'button', onClick: props.inspect,
          style: { marginLeft: '12px', padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '3px' },
        }, props.t('row.inspect')))
    }

    function TutorConversationCard({ node, inspectCall, ...props }) {
      return h(TutorCard, {
        ...props, ...node.data, phase: 'result',
        inspect: inspectCall && (() => inspectCall(node.data.block.callId)),
      })
    }

    return {
      inject: ['slots', 'uiConversation'],
      apply(ctx) {
        ctx.slots.inject('conversation.hero.frame', () =>
          ctx.slots.register({ name: 'conversation.hero.frame', id: 'tutor-welcome' }, TutorWelcomeFrame))
        const cardTool = name => name === 'tutor_quiz' || name === 'tutor_textbook' || name === 'tutor_paper'
        // Project saved results at Turn level so both process disclosures leave them visible.
        ctx.uiConversation.events.register({
          kind: 'tutor-card', target: 'chat',
          match: {
            'tool/call': event => cardTool(event.data.name) ? { id: String(event.data.callId), role: 'start' } : null,
            'tool/result': event => event.surfaceOp === 'append'
              ? { id: String(event.data.message.source.callId), role: 'update' } : null,
            'tool/ptc-dispatch': event => cardTool(event.data.name) ? { id: String(event.data.subCallId), role: 'start' } : null,
          },
          start: () => null,
          update: () => null,
          buildViewNode(context) {
            const result = context.matches.findLast(match => match.event.type === 'tool/result' || match.event.type === 'tool/ptc-dispatch')
            if (!result) return null
            const { event } = result
            const nested = event.type === 'tool/ptc-dispatch'
            const call = context.matches.find(match => match.event.type === 'tool/call')
            const toolName = nested ? event.data.name : call?.event.data.name
            if (!cardTool(toolName)) return null
            const block = {
              kind: 'tool-result', callId: context.id, meta: event.data.meta,
              content: nested ? event.data.content ?? [] : event.data.message.content,
              isError: (nested ? event.data.isError : event.data.message.isError) === true,
            }
            if (!cardMeta(toolName, block) || toolName === 'tutor_textbook' && block.meta?.show_card !== true) return null
            return {
              key: context.key, id: context.id, kind: 'tutor-card', target: 'chat',
              anchorSeq: event.seq, location: result.location, visibility: 'visible', groupTree: 'turn',
              data: { toolName, block },
            }
          },
        })
        ctx.slots.inject('conversation.chat.node', () =>
          ctx.slots.register({ name: 'conversation.chat.node', key: 'tutor-card', locale: 'conversation' }, TutorConversationCard))
        for (const key of ['tutor_quiz', 'tutor_grade', 'tutor_textbook', 'tutor_paper']) {
          ctx.slots.inject('tool.call.toolview', () =>
            ctx.slots.register({ name: 'tool.call.toolview', key, locale: 'conversation' }, key === 'tutor_grade' ? TutorCard : TutorTool))
        }
      },
    }
  },
})
