import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attrHrefToUrl, goPageHtml, isTrustedOutHost, outHref, wrapAnchorHref } from '../src/outlink.ts'
import { weiboTextHtml } from '../src/render.ts'
import { sanitizeHtml } from '../src/sanitize.ts'

// ── 白名单命中：主域名 + 子域名跟随，大小写/尾部点归一化，前缀伪装不误命中 ──
test('isTrustedOutHost：主域与子域命中，伪装域不命中', () => {
  assert.equal(isTrustedOutHost('apple.com'), true)
  assert.equal(isTrustedOutHost('www.apple.com'), true)
  assert.equal(isTrustedOutHost('a.b.apple.com'), true)
  assert.equal(isTrustedOutHost('APPLE.COM.'), true)
  // 个人域名（官方版挑洗时按台账剔除）
  assert.equal(isTrustedOutHost('blog.xiaowuleyi.com'), true)
  assert.equal(isTrustedOutHost('bloghao.com'), true)
  // 前缀/后缀伪装不是子域
  assert.equal(isTrustedOutHost('notapple.com'), false)
  assert.equal(isTrustedOutHost('evilapple.com'), false)
  assert.equal(isTrustedOutHost('apple.com.evil.com'), false)
  assert.equal(isTrustedOutHost(''), false)
})

// ── outHref：非白名单外域包 /go，白名单/同源/相对/非 http(s)/超长原样返回 ──
test('outHref：非白名单外域包 /go?u=，白名单直出', () => {
  const target = 'https://example.com/page?a=1&b=2'
  assert.equal(outHref(target), `/go?u=${encodeURIComponent(target)}`)
  // 白名单（含子域）不包
  assert.equal(outHref('https://www.apple.com/iphone/'), 'https://www.apple.com/iphone/')
  assert.equal(outHref('https://v2ex.com/t/1'), 'https://v2ex.com/t/1')
})

test('outHref：同源、相对路径、非 http(s)、超长、解析失败都原样返回', () => {
  assert.equal(outHref('https://blog.test/post/x', 'https://blog.test'), 'https://blog.test/post/x')
  assert.equal(outHref('/post/x'), '/post/x')
  assert.equal(outHref('javascript:alert(1)'), 'javascript:alert(1)')
  assert.equal(outHref('mailto:a@b.c'), 'mailto:a@b.c')
  assert.equal(outHref(`https://example.com/${'a'.repeat(1100)}`), `https://example.com/${'a'.repeat(1100)}`)
  assert.equal(outHref('https://'), 'https://')
})

// ── 净化器属性值 → URL：escAttr 实体先解码（含 &amp; 的查询串不断链）──
test('attrHrefToUrl：解码实体后解析，仅接受 http(s) 绝对地址', () => {
  assert.equal(attrHrefToUrl('https://example.com/a?x=1&amp;y=2'), 'https://example.com/a?x=1&y=2')
  assert.equal(attrHrefToUrl('/post/x'), null)
  assert.equal(attrHrefToUrl('mailto:a@b.c'), null)
  assert.equal(attrHrefToUrl('javascript:alert(1)'), null)
})

test('wrapAnchorHref：该包的返回 /go，不该包的返回 null', () => {
  const raw = 'https://example.com/a?x=1&amp;y=2'
  const wrapped = wrapAnchorHref(raw, 'https://s.test')
  assert.equal(wrapped, `/go?u=${encodeURIComponent('https://example.com/a?x=1&y=2')}`)
  // 白名单 / 同源 / 相对 / 非绝对地址不包
  assert.equal(wrapAnchorHref('https://www.apple.com/'), null)
  assert.equal(wrapAnchorHref('https://s.test/post/1', 'https://s.test'), null)
  assert.equal(wrapAnchorHref('/post/2', 'https://s.test'), null)
  assert.equal(wrapAnchorHref('mailto:a@b.c', 'https://s.test'), null)
})

// ── /go 中间页：免责声明 + 转义 + noindex，无脚本 ──
test('goPageHtml：展示目标域名与完整链接，带免责声明与 noindex', () => {
  const target = new URL('https://example.com/page?a=1&b=2')
  const html = goPageHtml(target, '测试站<>&')
  assert.ok(html.includes('noindex'))
  assert.ok(html.includes('免责声明'))
  assert.ok(html.includes('继续访问'))
  assert.ok(html.includes(`href="${esc(target.href)}"`))
  assert.ok(html.includes(esc(target.hostname)))
  assert.ok(html.includes(esc('测试站<>&')))
  assert.ok(!html.includes('<script'))
})

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// ── 微博正文：URL 转超链（与 site.js wbTextHtml 同口径，改这里记得同步客户端）──
test('weiboTextHtml：非白名单 URL 包 /go 中间页，白名单直出', () => {
  const wrapped = weiboTextHtml('看这个 https://example.com/a 很不错')
  assert.ok(wrapped.includes(`<a class="wb-link" href="/go?u=${encodeURIComponent('https://example.com/a')}" target="_blank" rel="noopener noreferrer">https://example.com/a</a>`))
  const trusted = weiboTextHtml('官网 https://www.apple.com/iphone')
  assert.ok(trusted.includes('href="https://www.apple.com/iphone"'))
  assert.ok(!trusted.includes('/go?u='))
})

test('weiboTextHtml：URL 尾部标点留在链接外，括号配对保留', () => {
  assert.ok(weiboTextHtml('链接 https://example.com/x。').includes('>https://example.com/x</a>。'))
  assert.ok(weiboTextHtml('链接 https://example.com/x，很好').includes('>https://example.com/x</a>，'))
  assert.ok(weiboTextHtml('见 https://example.com/wiki/a_(b) 正文').includes('>https://example.com/wiki/a_(b)</a>'))
  assert.ok(weiboTextHtml('见 https://example.com/a_(b）中').includes('>https://example.com/a_(b</a>'))
})

test('weiboTextHtml：中文紧贴 URL 时链接停在汉字前', () => {
  const html = weiboTextHtml('https://example.com的官网')
  assert.ok(html.includes('</a>的官网'))
  assert.ok(html.includes(encodeURIComponent('https://example.com')))
})

test('weiboTextHtml：URL 与话题共存，fragment 不被当话题', () => {
  const html = weiboTextHtml('#随笔# 看 https://example.com/#section #生活#')
  assert.equal((html.match(/class="wb-topic"/g) || []).length, 2)
  assert.equal((html.match(/class="wb-link"/g) || []).length, 1)
  assert.ok(html.includes(encodeURIComponent('随笔')))
  assert.ok(html.includes(encodeURIComponent('生活')))
})

test('weiboTextHtml：含查询串的 URL 转义正确（&amp; 不破坏属性）', () => {
  const html = weiboTextHtml('https://example.com/?a=1&b=2')
  assert.ok(html.includes(encodeURIComponent('https://example.com/?a=1&b=2')))
  // URL 后紧跟引号：引号落在锚点外且被转义，不产生可注入的属性
  const quoted = weiboTextHtml('"https://example.com/x"')
  assert.ok(quoted.includes('&quot;'))
  assert.ok(!quoted.includes('"onclick'))
})

test('weiboTextHtml：既有话题语义不回归（C# 不算话题、无 URL 时输出与旧版一致）', () => {
  const html = weiboTextHtml('写 C# 的日常 #随笔#')
  assert.equal((html.match(/class="wb-topic"/g) || []).length, 1)
  assert.ok(html.includes(encodeURIComponent('随笔')))
  assert.equal(weiboTextHtml(''), '')
  assert.ok(weiboTextHtml('纯文本，没有链接。').includes('纯文本，没有链接。'))
})

// ── 正文渲染期包装（sanitizeHtml opts）：存库/RSS/导出不传 origin，行为不变 ──
test('sanitizeHtml：传 origin 时非白名单外链包装 /go，白名单与同源保持原样', () => {
  const wrapped = sanitizeHtml('<p><a href="https://example.com/x">外链</a></p>', { origin: 'https://s.test' })
  assert.ok(wrapped.includes(`href="/go?u=${encodeURIComponent('https://example.com/x')}"`))
  assert.ok(wrapped.includes('target="_blank" rel="nofollow noopener noreferrer"'))
  // 白名单：直出（沿用既有 rel，不加 nofollow/target）
  const trusted = sanitizeHtml('<a href="https://www.apple.com/">苹果</a>', { origin: 'https://s.test' })
  assert.ok(trusted.includes('href="https://www.apple.com/"'))
  assert.ok(trusted.includes('rel="noopener noreferrer"'))
  assert.ok(!trusted.includes('nofollow'))
  // 同源：直出
  const same = sanitizeHtml('<a href="https://s.test/post/1">站内</a>', { origin: 'https://s.test' })
  assert.ok(same.includes('href="https://s.test/post/1"'))
  assert.ok(!same.includes('/go?u='))
})

test('sanitizeHtml：不传 origin 保持既有行为（存库/RSS/导出路径），包装幂等', () => {
  const raw = '<a href="https://example.com/x">外链</a>'
  assert.ok(sanitizeHtml(raw).includes('href="https://example.com/x"'))
  // 已包装的相对地址重复净化不会二次包装（渲染层每次从库里原始内容重新包装）
  const once = sanitizeHtml('<a href="https://example.com/x">外链</a>', { origin: 'https://s.test' })
  const twice = sanitizeHtml(once, { origin: 'https://s.test' })
  assert.equal((twice.match(/\/go\?u=/g) || []).length, 1)
  // 相对路径与 mailto 不受影响
  assert.ok(sanitizeHtml('<a href="/post/1">站内</a><a href="mailto:a@b.c">邮</a>', { origin: 'https://s.test' }).includes('href="/post/1"'))
  assert.ok(sanitizeHtml('<a href="mailto:a@b.c">邮</a>', { origin: 'https://s.test' }).includes('href="mailto:a@b.c"'))
})
