import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import katex from 'katex'
import sanitizeHtml from 'sanitize-html'
import type { Card } from './cards.ts'

export type QuestionType = 'single' | 'multi' | 'judge' | 'blank' | 'open'
type TypeCounts = Record<QuestionType, number>

export interface Paper {
  title: string
  scope: string
  subject: string
  grade: string
  count: number
  requested_count: number
  duration_minutes: number | null
  type_counts: TypeCounts
  difficulty_counts: Record<string, number>
  knowledge_points: Array<{ name: string; objective: string; question_numbers: number[]; type_counts: TypeCounts }>
  questions: Array<{
    number: number; knowledge_point: string; question_id: string; question_type: QuestionType
    material: string; prompt: string; options: Record<string, string>; blanks: number; difficulty: number; paper: string
  }>
  warnings: string[]
}

const TYPES: QuestionType[] = ['single', 'multi', 'judge', 'blank', 'open']
const TYPE_LABEL: Record<QuestionType, string> = { single: '单选题', multi: '多选题', judge: '判断题', blank: '填空题', open: '解答题' }
const DIFFICULTY = ['', '基础', '中档', '较难']
const SUBJECT: Record<string, string> = { math: '数学', physics: '物理', chinese: '语文', english: '英语', chemistry: '化学', biology: '生物', history: '历史', geography: '地理', politics: '政治' }
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// shortcut: these are the bundled bank's image hosts; extend this set when importing another bank.
const IMAGE_HOSTS = new Set(['resource.xinjiaoyu.com', 'word-parse-1314219157.cos.ap-beijing.myqcloud.com'])
const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const md = (value: string) => escape(value.replace(/\s+/g, ' ')).replace(/[\\`*_{}\[\]()#+.!|>-]/g, '\\$&')
const typeSummary = (counts: TypeCounts) => TYPES.filter(type => counts[type] > 0).map(type => `${TYPE_LABEL[type]} ${counts[type]} 题`).join('、') || '暂无可用题目'
const difficultySummary = (paper: Paper) => [1, 2, 3].filter(level => paper.difficulty_counts[level] > 0)
  .map(level => `${DIFFICULTY[level]} ${paper.difficulty_counts[level]} 题（${Number((paper.difficulty_counts[level] / paper.count * 100).toFixed(1))}%）`).join('、') || '暂无可用题目'

const katexFolder = dirname(fileURLToPath(import.meta.resolve('katex/dist/katex.min.css')))
const katexLicense = readFileSync(join(katexFolder, '../LICENSE'), 'utf8')
const mathCss = `/* KaTeX\n${katexLicense} */\n` + readFileSync(join(katexFolder, 'katex.min.css'), 'utf8').replace(/src:([^;}]+)/g, (source, urls: string) => {
  const font = /url\((fonts\/[^)]+\.woff2)\)/.exec(urls)?.[1]
  if (!font) throw new Error(`KaTeX font source is unsupported: ${source}`)
  return `src:url(data:font/woff2;base64,${readFileSync(join(katexFolder, font)).toString('base64')}) format("woff2")`
})

function rasterMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}

async function inlineImage(source: string, signal: AbortSignal): Promise<string> {
  const data = /^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(source)
  let bytes: Buffer
  if (data) {
    if (data[1].length > MAX_IMAGE_BYTES * 4 / 3 + 8) throw new Error('image is too large')
    bytes = Buffer.from(data[1], 'base64')
  } else {
    const url = new URL(source)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !IMAGE_HOSTS.has(url.hostname)) {
      throw new Error('image source is not a supported bank host')
    }
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('image is unavailable or too large')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_IMAGE_BYTES) throw new Error('image is too large')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    bytes = Buffer.concat(chunks)
  }
  const mime = rasterMime(bytes)
  if (!mime || bytes.length > MAX_IMAGE_BYTES) throw new Error('image is not a supported raster image')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

const paperCss = `
  *{box-sizing:border-box} body{margin:0;background:#f5f7fa;color:#172333;font:15px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  ::selection{background:#d5e7ff} .paper{max-width:980px;margin:auto;padding:28px clamp(16px,4vw,36px) 48px} header{margin-bottom:28px} h1{margin:0 0 12px;font-size:26px;line-height:1.45;font-weight:650;overflow-wrap:anywhere}
  .paper-meta,.question-meta{color:#526173;font-size:13px} .paper-meta{display:flex;flex-wrap:wrap;gap:4px 20px} .scope{margin:12px 0 0} h2{margin:28px 0 12px;font-size:19px;line-height:1.5} .question{margin:0 0 16px;padding:20px;background:#fff;border:1px solid #dce3ec;border-radius:12px;break-inside:avoid}
  .question-number{margin:0 0 8px;font-size:15px;font-weight:600} .content{overflow-wrap:anywhere} .content p{margin:0 0 10px} .content img{max-width:100%;height:auto;max-height:420px;object-fit:contain;vertical-align:middle} .content table{border-collapse:collapse;max-width:100%;display:block;overflow:auto;margin:12px 0} .content td,.content th{border:1px solid #bcc8d7;padding:6px 10px}
  .material{margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #e6ebf1} .options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 24px;margin:16px 0}.option{display:flex;align-items:baseline;gap:8px;min-width:0}.option-label{flex:none;font-weight:500}.option-content{min-width:0}.option p{margin:0}
  .question-meta{margin-top:16px;padding-top:12px;border-top:1px solid #e6ebf1;overflow-wrap:anywhere}.answer-space{margin-top:16px;min-height:120px;border-bottom:1px solid #b4c0cf;color:#526173}.blank-space{min-height:40px}.blank{display:inline-block;min-width:4em;border-bottom:1px solid currentColor;height:1em;vertical-align:baseline}
  .notice,.image-missing{padding:12px 16px;background:#fff5dc;color:#684b0a;border-radius:12px}.notice{margin:16px 0}.notice p{margin:0}.image-missing{display:inline-block;font-size:13px}.math-fallback{white-space:pre-wrap;overflow-wrap:anywhere}.katex-display{overflow-x:auto;overflow-y:hidden;padding:4px 0}
  @media(max-width:520px){.paper{padding:20px 12px 36px}h1{font-size:22px}.question{padding:16px}.options{grid-template-columns:minmax(0,1fr)}}
  @media print{body{background:#fff;color:#000;font-size:11pt}.paper{max-width:none;padding:0}.question{border:0;border-radius:0;padding:12px 0;border-bottom:1px solid #ccc}.question-meta{font-size:9pt}.notice{background:transparent;border:1px solid #aaa}.answer-space{min-height:100px}.blank-space{min-height:32px} @page{margin:16mm}}
`

/** Sanitize original bank HTML before adding trusted KaTeX markup and embedded assets. */
export async function renderPaperHtml(paper: Paper, signal?: AbortSignal): Promise<{ html: string; warnings: string[] }> {
  signal?.throwIfAborted()
  const warnings = new Set<string>()
  const images = new Map<string, { index: number; numbers: Set<number> }>()
  const renderText = (text: string, number: number) => text.replace(/\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|(?<!\\)\$(?!\s)([^$\n]*?\S)(?<!\\)\$(?!\d)/g,
    (whole, inline: string | undefined, display: string | undefined, dollarsDisplay: string | undefined, dollarsInline: string | undefined) => {
      const tex = (inline ?? display ?? dollarsDisplay ?? dollarsInline ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      try {
        return katex.renderToString(tex, { displayMode: display !== undefined || dollarsDisplay !== undefined, trust: false, strict: 'error', throwOnError: true, maxExpand: 1000, maxSize: 20 })
      } catch {
        warnings.add(`第 ${number} 题有公式暂不能排版，已保留原式。`)
        return `<code class="math-fallback">${whole}</code>`
      }
    }).replace(/\[\[_\]\]/g, '<span class="blank" aria-label="填空"></span>')
  const content = (raw: string, number: number) => sanitizeHtml(raw, {
    allowedTags: ['p', 'div', 'span', 'br', 'sup', 'sub', 'u', 'strong', 'em', 'b', 'i', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'ol', 'li', 'img'],
    allowedAttributes: { img: ['data-paper-image', 'alt'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'svg', 'math', 'object', 'embed', 'form'],
    nestingLimit: 40,
    transformTags: { img: (_tag, attrs) => {
      const source = attrs.src ?? ''
      const image = images.get(source) ?? { index: images.size, numbers: new Set<number>() }
      image.numbers.add(number)
      images.set(source, image)
      return { tagName: 'img', attribs: { 'data-paper-image': String(image.index), alt: attrs.alt || `第 ${number} 题题图` } }
    } },
    textFilter: text => renderText(text, number),
  })
  const groups = TYPES.map(type => {
    const questions = paper.questions.filter(question => question.question_type === type)
    if (!questions.length) return ''
    return { type, questions: questions.map(q => `<article class="question" id="question-${q.number}">
      <h3 class="question-number">第 ${q.number} 题</h3>
      ${q.material ? `<div class="content material">${content(q.material, q.number)}</div>` : ''}
      <div class="content">${content(q.prompt, q.number)}</div>
      ${Object.keys(q.options).length ? `<div class="options">${Object.entries(q.options).map(([label, text]) => `<div class="option"><span class="option-label">${escape(label)}.</span><div class="content option-content">${content(text, q.number)}</div></div>`).join('')}</div>` : ''}
      ${q.question_type === 'open' || q.question_type === 'blank' ? `<div class="answer-space ${q.question_type === 'blank' ? 'blank-space' : ''}">${q.question_type === 'open' ? '解：' : `作答${q.blanks > 1 ? `（共 ${q.blanks} 空）` : ''}：`}</div>` : ''}
      <footer class="question-meta">难度：${escape(DIFFICULTY[q.difficulty] ?? '未指定')}　知识点：${escape(q.knowledge_point)}${q.paper ? `<br>来源：${escape(q.paper)}` : ''}</footer>
    </article>`).join('') }
  }).filter((group): group is { type: QuestionType; questions: string } => !!group)
  const assets: string[] = []
  const entries = [...images]
  const imageSignal = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])])
  for (let start = 0; start < entries.length; start += 4) {
    await Promise.all(entries.slice(start, start + 4).map(async ([source, image]) => {
      try {
        imageSignal.throwIfAborted()
        assets[image.index] = await inlineImage(source, imageSignal)
      } catch {
        signal?.throwIfAborted()
        warnings.add(`第 ${[...image.numbers].join('、')} 题的题图暂不可用，请核对题目后使用。`)
      }
    }))
  }
  signal?.throwIfAborted()
  const sections = groups.map((group, i) => `<section><h2>${['一', '二', '三', '四', '五'][i]}、${TYPE_LABEL[group.type]}（共 ${paper.type_counts[group.type]} 小题）</h2>${group.questions}</section>`).join('')
    .replace(/<img\b[^>]*data-paper-image="(\d+)"[^>]*\/?\s*>/g, (tag, index: string) => assets[Number(index)]
      ? tag.replace(/data-paper-image="\d+"/, `src="${assets[Number(index)]}"`)
      : '<span class="image-missing">题图暂不可用，请核对后使用。</span>')
  const notices = [...new Set([...paper.warnings, ...warnings])]
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(paper.title)}</title><style>${mathCss}\n${paperCss}</style></head><body><main class="paper">
    <header><h1>${escape(paper.title)}</h1><div class="paper-meta"><span>学科：${escape((SUBJECT[paper.subject] ?? paper.subject) || '未指定')}</span><span>年级：${escape(paper.grade || '未指定')}</span><span>共 ${paper.count} 题${paper.count < paper.requested_count ? ` / 目标 ${paper.requested_count} 题` : ''}</span>${paper.duration_minutes ? `<span>参考时间：${paper.duration_minutes} 分钟</span>` : ''}</div><p class="scope">考查范围：${escape(paper.scope)}</p></header>
    ${notices.length ? `<aside class="notice" aria-label="组卷提示">${notices.map(warning => `<p>${escape(warning)}</p>`).join('')}</aside>` : ''}
    ${sections || '<p>当前题库尚未找到适合该范围的题目，请先补充题库或调整组卷范围。</p>'}
  </main></body></html>`
  return { html, warnings: [...warnings] }
}

/** The chat keeps the blueprint and coverage details; the paper opens separately. */
export function paperCard(paper: Paper, htmlPath?: string): Card & { html_path?: string } {
  const rows = [
    ['考查范围', md(paper.scope)], ['学科', md((SUBJECT[paper.subject] ?? paper.subject) || '未指定')], ['年级', md(paper.grade || '未指定')],
    ['题量', `${paper.count} 题 / 目标 ${paper.requested_count} 题`], ['参考时间', paper.duration_minutes ? `${paper.duration_minutes} 分钟` : '未指定'],
    ['题型结构', typeSummary(paper.type_counts)], ['难度分布', difficultySummary(paper)],
  ]
  const parts = ['### 组卷需求', '| 项目 | 内容 |', '| --- | --- |', ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    '', '### 知识点拆解', '| 知识点 | 考查目标 | 对应题号 | 题型 |', '| --- | --- | --- | --- |',
    ...paper.knowledge_points.map(point => `| ${md(point.name)} | ${md(point.objective)} | ${point.question_numbers.join('、') || '暂无匹配题目'} | ${typeSummary(point.type_counts)} |`),
    '', '### 细目表', '| 题号 | 题型 | 难度 | 知识点 |', '| --- | --- | --- | --- |',
    ...paper.questions.map(question => `| ${question.number} | ${TYPE_LABEL[question.question_type]} | ${DIFFICULTY[question.difficulty] ?? '未指定'} | ${md(question.knowledge_point)} |`)]
  if (!paper.questions.length) parts.push('| — | — | — | 暂无匹配题目 |')
  if (paper.warnings.length) parts.push('', '### 组卷提示', ...[...new Set(paper.warnings)].map(warning => `- ${md(warning)}`))
  return { title: `组卷 · ${paper.title}`, body: parts.join('\n'), ...(htmlPath ? { html_path: htmlPath } : {}) }
}
