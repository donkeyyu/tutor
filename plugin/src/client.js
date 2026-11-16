// DSH loads browser entries as module factories. Plain JS needs no build step.
window.__ModuleLoader__.load({
  id: 'dsh-tutor',
  factory(require) {
    const { createElement: h, useState } = require('react')
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')

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

    function TutorCard({ toolName, phase, block, inspect, t, useInput, inputActions }) {
      const [selected, setSelected] = useState([])
      const [continuationError, setContinuationError] = useState('')
      const input = useInput(state => state)
      if (phase !== 'result') {
        return h('div', { role: 'status' }, `${toolName} · ${t(phase === 'preparing' ? 'row.preparing' : 'bash.running')}`)
      }
      const knowledge = !block.isError && toolName === 'tutor_textbook' ? knowledgeResult(block) : null
      const meta = block.meta && typeof block.meta.title === 'string' && typeof block.meta.body === 'string'
        ? block.meta : knowledge ? legacyKnowledgeCard(knowledge) : null
      const card = !block.isError && meta && typeof meta.title === 'string' && typeof meta.body === 'string'
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
      card
        ? h(MarkdownText, { text: question?.body ?? meta.body, labels })
        : h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: block.isError ? 'var(--dsw-alias-state-error-primary)' : 'inherit' } }, text),
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
      }, t('row.inspect')),
      // Tutor cards grow with the conversation instead of scrolling inside DSH's capped process pane.
      card && h('style', null, `
        [data-step-process-body]:has(> [data-step-process-content] [data-tutor-card]) {
          max-height: none;
          overflow-y: visible;
          mask-image: none;
          scrollbar-gutter: auto;
        }
      `))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const key of ['tutor_quiz', 'tutor_grade', 'tutor_textbook']) {
          ctx.slots.inject('tool.call.toolview', () =>
            ctx.slots.register({ name: 'tool.call.toolview', key, locale: 'conversation' }, TutorCard))
        }
      },
    }
  },
})
