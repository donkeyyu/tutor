// UI cards for tool results. The model still gets the raw JSON; these only
// change how a DSH client shows the completed call. A card is projected once
// from the engine reply (output.presentationMeta, persisted with the session
// log). client.js renders that metadata in DSH web; presentCard supplies the
// generic result view for other clients. Replay needs no engine call.
import type { ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'

/** What a card carries: a header line and a Markdown body. */
export interface Card {
  title: string
  body: string
}

type Obj = Record<string, any>

const TYPE_LABEL: Record<string, string> = { single: '单选', multi: '多选', judge: '判断', blank: '填空', open: '简答' }
const DIFFICULTY = ['', '基础', '中档', '较难']

const ENTITY: Record<string, string> = { nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** Bank HTML to markdown: images, line breaks, simple tables, sub/sup, LaTeX as $..$, blanks as ____. */
export function htmlToMarkdown(html: string): string {
  return (html ?? '')
    .replace(/<img\b[^>]*?\bsrc="([^"]+)"[^>]*>/gi, '![]($1)')
    .replace(/<u\b[^>]*>(.*?)<\/u>/gis, (_, inner: string) => (inner.replace(/<[^>]+>|&nbsp;|\s/g, '') ? inner : '____'))
    .replace(/<sup\b[^>]*>(.*?)<\/sup>/gis, '^$1')
    .replace(/<sub\b[^>]*>(.*?)<\/sub>/gis, '_$1')
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(Number(e[1].toLowerCase() === 'x' ? `0${e.slice(1)}` : e.slice(1))) : ENTITY[e.toLowerCase()] ?? m)
    .replace(/\\\((.+?)\\\)/gs, (_, m: string) => `$${m.trim()}$`)
    .replace(/\[\[_\]\]/g, '____')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n\n')
}

function answerText(answer: unknown): string {
  return Array.isArray(answer) ? answer.map((a, i) => `${i + 1}. ${htmlToMarkdown(String(a))}`).join('\n') : htmlToMarkdown(String(answer ?? ''))
}

/** tutor_quiz: the posed question, never the key (the engine does not return it). */
export function questionCard(value: Obj): Card {
  const q: Obj = value.question ?? {}
  const label = TYPE_LABEL[q.question_type] ?? q.question_type ?? '题目'
  const parts = [q.material && `> ${htmlToMarkdown(q.material).replace(/\n/g, '\n> ')}`, htmlToMarkdown(q.prompt ?? '')]
  const options = Object.entries(q.options ?? {}).map(([k, v]) => `**${k}.** ${htmlToMarkdown(String(v))}`)
  if (options.length) parts.push(options.join('\n\n'))
  if (q.blanks > 1) parts.push(`_共 ${q.blanks} 空，按顺序作答_`)
  const tags = [label, DIFFICULTY[q.difficulty], value.reposed && '未作答'].filter(Boolean)
  return { title: `题目 · ${tags.join(' · ')}`, body: parts.filter(Boolean).join('\n\n') }
}

/** tutor_grade: the verdict, the key and the explanation. */
export function gradeCard(value: Obj): Card {
  if (value.needs_judgement) {
    return { title: '已收到作答 · 待评判', body: `**参考答案**\n\n${answerText(value.reference_answer)}` }
  }
  const verdict = value.correct ? '✓ 正确' : value.score > 0 ? '◐ 部分正确' : '✗ 错误'
  const parts = [`**答案**\n\n${answerText(value.expected_answer)}`]
  if (value.explanation) parts.push(`**解析**\n\n${htmlToMarkdown(value.explanation)}`)
  const mastery = typeof value.mastery === 'number' ? ` · 掌握度 ${Math.round(value.mastery * 100)}%` : ''
  return { title: `${verdict}${mastery}${value.mastered ? ' · 已掌握' : ''}`, body: parts.join('\n\n') }
}

/** tutor_textbook read: the chapter pages shown, then the study notes on them. */
export function knowledgeCard(value: Obj): Card {
  const [from, to] = value.shown ?? []
  const pages = (value.text ?? []).filter((p: Obj) => p.text?.trim())
    .map((p: Obj) => `**第 ${p.page} 页**\n\n${p.text.trim()}`)
  const notes = (value.notes ?? []).map((n: Obj) => `**${n.title}** · 第 ${n.page} 页${n.content_type ? ` · ${n.content_type}` : ''}\n\n${n.text}`)
  const parts = [...pages]
  if (!pages.length) parts.push('_这些页面没有可提取的文字（可能是图片页）。_')
  if (notes.length) parts.push('---', '### 学习笔记', ...notes)
  if (value.next_page) parts.push(`_续读：第 ${value.next_page} 页起_`)
  return { title: `知识卡 · ${value.title} · 第 ${from === to ? from : `${from}–${to}`} 页`, body: parts.join('\n\n') }
}

/** Read a card back from persisted meta; anything else falls back to the raw result. */
export function presentCard(result: ToolResult): ToolResultView | undefined {
  const meta = result.meta as Partial<Card> | undefined
  if (result.isError || !meta || typeof meta.title !== 'string' || typeof meta.body !== 'string') return undefined
  return { card: 'generic', title: meta.title, content: [{ type: 'text', text: meta.body }] }
}
