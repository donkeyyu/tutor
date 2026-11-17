import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Paper, paperCard, renderPaperHtml } from '../src/paper.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
const image = `data:image/png;base64,${png.toString('base64')}`
const counts = { single: 1, multi: 0, judge: 0, blank: 0, open: 1 }

function sample(): Paper {
  return {
    title: '一次函数专题测试', scope: '一次函数的图象与解析式', subject: 'math', grade: '八年级',
    count: 2, requested_count: 2, duration_minutes: 20, type_counts: { ...counts },
    difficulty_counts: { 1: 1, 2: 1, 3: 0 }, warnings: [],
    knowledge_points: [{ name: '图象与解析式', objective: '根据函数式判断图象并求点坐标', question_numbers: [1, 2], type_counts: { ...counts } }],
    questions: [
      { number: 1, knowledge_point: '图象与解析式', question_id: 'q1', question_type: 'single', difficulty: 1, blanks: 0,
        material: '<p>阅读材料，<sup>2</sup><sub>1</sub><table><tr><td>坐标</td><td>数值</td></tr></table></p>',
        prompt: '<p>函数 \\(y=\\frac{1}{2}x+1\\) 经过哪一点？</p>', options: { A: '(0, 1)', B: '(1, 0)' }, paper: '测试来源' },
      { number: 2, knowledge_point: '图象与解析式', question_id: 'q2', question_type: 'open', difficulty: 2, blanks: 0,
        material: '', prompt: '<p>求一次函数解析式。</p>', options: {}, paper: '测试来源' },
    ],
  }
}

test('paper preserves material and options, pre-renders math, and embeds its own fonts', async () => {
  const paper = sample()
  Object.assign(paper.questions[0], { answer: 'PRIVATE_KEY', explanation: 'PRIVATE_EXPLANATION' })
  const { html, warnings } = await renderPaperHtml(paper)
  assert.deepEqual(warnings, [])
  assert.ok(html.includes('class="katex"'))
  assert.ok(html.includes('data:font/woff2;base64,'))
  assert.ok(!/url\(["']?fonts\//.test(html))
  assert.ok(html.includes('<sup>2</sup><sub>1</sub>'))
  assert.ok(html.includes('<table>'))
  assert.ok(html.includes('(0, 1)'))
  assert.ok(html.indexOf('id="question-1"') < html.indexOf('id="question-2"'))
  assert.ok(!html.includes('PRIVATE_KEY') && !html.includes('PRIVATE_EXPLANATION'))
  assert.ok(!/<script\b|<link\b/i.test(html))
})

test('paper escapes user metadata and removes active bank markup and unsafe image URLs', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch') })
  const paper = sample()
  paper.title = '<试卷> & "title"'
  paper.questions[0].prompt = '<script>PRIVATE_SCRIPT</script><style>@import "evil"</style><p onclick="evil()">保留题目</p><iframe src="https://evil.example"></iframe><svg onload="evil()"></svg><img src="javascript:evil()" onerror="evil()">'
  const { html, warnings } = await renderPaperHtml(paper)
  assert.ok(html.includes('&lt;试卷&gt; &amp; &quot;title&quot;'))
  assert.ok(html.includes('保留题目'))
  assert.ok(!/<(?:script|iframe|svg|object)\b|\bon(?:click|error|load)=/i.test(html))
  assert.ok(!html.includes('PRIVATE_SCRIPT') && !html.includes('@import'))
  assert.ok(!html.includes('javascript:'))
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(warnings.length, 1)
  assert.ok(html.includes('class="image-missing"'))
})

test('paper embeds raster data and deduplicates bank CDN image downloads', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })
  })
  const paper = sample()
  const url = 'https://resource.xinjiaoyu.com/demo.png'
  paper.questions[0].prompt += `<img src="${image}"><img src="${url}">`
  paper.questions[1].prompt += `<img src="${url}">`
  const { html, warnings } = await renderPaperHtml(paper)
  assert.deepEqual(warnings, [])
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal((html.match(/<img\b/g) ?? []).length, 3)
  assert.equal((html.match(/src="data:image\/png;base64,/g) ?? []).length, 3)
  assert.ok(!html.includes('src="https:') && !html.includes('data-paper-image='))
})

test('unavailable, oversized, local and unknown-host images remain visible coverage warnings', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(png), {
    headers: { 'content-length': String(6 * 1024 * 1024) },
  }))
  const paper = sample()
  paper.questions[0].prompt += '<img src="http://127.0.0.1/private"><img src="https://untrusted.example/x.png"><img src="https://resource.xinjiaoyu.com/oversized.png">'
  const { html, warnings } = await renderPaperHtml(paper)
  assert.equal(fetch.mock.callCount(), 1)
  assert.ok(warnings.length)
  assert.equal((html.match(/class="image-missing"/g) ?? []).length, 3)
  assert.ok(!/<img\b/.test(html))
})

test('a cancelled paper does not fetch or render after cancellation', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch') })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(renderPaperHtml(sample(), controller.signal), { name: 'AbortError' })
  assert.equal(fetch.mock.callCount(), 0)
})

test('chat blueprint retains objectives, question mappings, distribution and honest gaps', () => {
  const paper = sample()
  paper.requested_count = 4
  paper.knowledge_points.push({ name: '缺口|知识点', objective: '尚无匹配题目', question_numbers: [], type_counts: { single: 0, multi: 0, judge: 0, blank: 0, open: 0 } })
  paper.warnings.push('目标 4 题，实际 2 题。')
  const meta = paperCard(paper, '/demo/paper.html')
  assert.equal(meta.html_path, '/demo/paper.html')
  assert.ok(meta.body.includes('根据函数式判断图象并求点坐标'))
  assert.ok(meta.body.includes('1、2'))
  assert.ok(meta.body.includes('50%'))
  assert.ok(meta.body.includes('缺口\\|知识点'))
  assert.ok(meta.body.includes('目标 4 题，实际 2 题'))
  assert.ok(!meta.body.includes('求一次函数解析式。'), 'chat keeps the blueprint rather than duplicating the paper stems')
  assert.equal(paperCard(paper).html_path, undefined)
})
