import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keywordLinkHtml, keywordRulesError, parseKeywordRules, parseMaxPerKeyword } from '../src/keyword-link.ts'
import { renderPostContentHtml, SERVER_PLUGINS } from '../src/hooks.ts'
import { sanitizeHtml } from '../src/sanitize.ts'
import type { SettingsMap } from '../src/types.ts'

// ── 配置解析 ──

test('parseKeywordRules：每行一条「关键词|链接」，注释行与空行跳过，坏行静默丢弃', () => {
  const rules = parseKeywordRules(
    '# 注释行\n// 注释2\n\n比特币|/post/btc\n区块链 | https://zh.wikipedia.org/wiki/区块链\n坏行没有分隔\n|/empty\n比特币|javascript:alert(1)'
  )
  assert.deepEqual(rules, [
    { keyword: '比特币', url: '/post/btc' },
    { keyword: '区块链', url: 'https://zh.wikipedia.org/wiki/区块链' },
  ])
})

test('parseKeywordRules：重复关键词取先者，上限 100 条截断', () => {
  assert.deepEqual(parseKeywordRules('比特币|/a\n比特币|/b'), [{ keyword: '比特币', url: '/a' }])
  const many = Array.from({ length: 120 }, (_, i) => `词${i}|/u${i}`).join('\n')
  assert.equal(parseKeywordRules(many).length, 100)
})

test('keywordRulesError：合法返回 null，坏行报行号，超量报上限', () => {
  assert.equal(keywordRulesError('比特币|/post/btc\n# 注释\n\n区块链|https://x.example/y'), null)
  assert.ok(keywordRulesError('比特币')!.includes('第 1 行'))
  assert.ok(keywordRulesError('比特币|')!.includes('第 1 行'))
  assert.ok(keywordRulesError('|/a')!.includes('第 1 行'))
  assert.ok(keywordRulesError('比特币|ftp://x')!.includes('http(s)'))
  assert.ok(keywordRulesError('比特币|/a\n坏行')!.includes('第 2 行'))
  const many = Array.from({ length: 101 }, (_, i) => `词${i}|/u${i}`).join('\n')
  assert.ok(keywordRulesError(many)!.includes('100 条'))
})

test('parseMaxPerKeyword：留空=1，all/全部=全部，数字取整夹在 1-99，脏值降级 1', () => {
  assert.equal(parseMaxPerKeyword(''), 1)
  assert.equal(parseMaxPerKeyword('1'), 1)
  assert.equal(parseMaxPerKeyword('3'), 3)
  assert.equal(parseMaxPerKeyword(' 2 '), 2)
  assert.equal(parseMaxPerKeyword('all'), 'all')
  assert.equal(parseMaxPerKeyword('ALL'), 'all')
  assert.equal(parseMaxPerKeyword('全部'), 'all')
  assert.equal(parseMaxPerKeyword('0'), 1)
  assert.equal(parseMaxPerKeyword('-5'), 1)
  assert.equal(parseMaxPerKeyword('abc'), 1)
  assert.equal(parseMaxPerKeyword('150'), 99)
})

// ── 扫描器：文本节点替换 ──

const BTC = [{ keyword: '比特币', url: '/post/btc' }]

test('keywordLinkHtml：基础替换——命中关键词包成链接，站内相对链接裸 <a>', () => {
  assert.equal(
    keywordLinkHtml('<p>比特币是一种货币，比特币很火。</p>', BTC),
    '<p><a href="/post/btc">比特币</a>是一种货币，比特币很火。</p>'
  )
})

test('keywordLinkHtml：默认每个关键词每篇只链首次（计数跨段落累计）', () => {
  assert.equal(
    keywordLinkHtml('<p>比特币</p><p>再说比特币</p><p>还有比特币</p>', BTC),
    '<p><a href="/post/btc">比特币</a></p><p>再说比特币</p><p>还有比特币</p>'
  )
})

test('keywordLinkHtml：maxPerKeyword 数字 N = 前 N 次，all = 全部', () => {
  const html = '<p>比特币</p><p>比特币</p><p>比特币</p>'
  assert.equal(
    keywordLinkHtml(html, BTC, { maxPerKeyword: 2 }),
    '<p><a href="/post/btc">比特币</a></p><p><a href="/post/btc">比特币</a></p><p>比特币</p>'
  )
  assert.equal(
    keywordLinkHtml(html, BTC, { maxPerKeyword: 'all' }),
    '<p><a href="/post/btc">比特币</a></p><p><a href="/post/btc">比特币</a></p><p><a href="/post/btc">比特币</a></p>'
  )
})

test('keywordLinkHtml：既有链接内部跳过（不嵌套 a），且不消耗该关键词的首次配额', () => {
  assert.equal(
    keywordLinkHtml('<p><a href="/x">比特币论坛</a>与比特币</p>', BTC),
    '<p><a href="/x">比特币论坛</a>与<a href="/post/btc">比特币</a></p>'
  )
})

test('keywordLinkHtml：代码语境（pre/code）与标题 h1-h6 一律跳过，关闭后恢复', () => {
  assert.equal(
    keywordLinkHtml('<pre>比特币</pre><p>比特币</p>', BTC),
    '<pre>比特币</pre><p><a href="/post/btc">比特币</a></p>'
  )
  assert.equal(
    keywordLinkHtml('<p>比特币</p><code>比特币</code><h2>比特币</h2><h1>比特币</h1>', BTC),
    '<p><a href="/post/btc">比特币</a></p><code>比特币</code><h2>比特币</h2><h1>比特币</h1>'
  )
})

test('keywordLinkHtml：标签属性（img alt）与 HTML 注释里的关键词不动', () => {
  assert.equal(
    keywordLinkHtml('<p><img src="/a.png" alt="比特币"></p><!-- 比特币 --><p>比特币</p>', BTC),
    '<p><img src="/a.png" alt="比特币"></p><!-- 比特币 --><p><a href="/post/btc">比特币</a></p>'
  )
})

test('keywordLinkHtml：同位置多词命中取最长（比特币优先于特币），不重叠各自命中', () => {
  const rules = [
    { keyword: '特币', url: '/a' },
    { keyword: '比特币', url: '/b' },
  ]
  assert.equal(
    keywordLinkHtml('<p>比特币与特币</p>', rules),
    '<p><a href="/b">比特币</a>与<a href="/a">特币</a></p>'
  )
})

test('keywordLinkHtml：纯 ASCII 词加词边界——AI 不命中 detail，独立出现照常命中', () => {
  const rules = [{ keyword: 'AI', url: '/ai' }]
  assert.equal(
    keywordLinkHtml('<p>AI 很火，detail 里没有，末尾是 ai。</p>', rules, { maxPerKeyword: 'all' }),
    '<p><a href="/ai">AI</a> 很火，detail 里没有，末尾是 <a href="/ai">ai</a>。</p>'
  )
  // 默认配额 1：首次命中后同词不再链
  assert.equal(
    keywordLinkHtml('<p>AI 很火，末尾是 ai。</p>', rules),
    '<p><a href="/ai">AI</a> 很火，末尾是 ai。</p>'
  )
})

test('keywordLinkHtml：大小写不敏感（英文关键词命中任意大小写）', () => {
  const rules = [{ keyword: 'Bitcoin', url: '/btc' }]
  assert.equal(
    keywordLinkHtml('<p>bitcoin 与 Bitcoin</p>', rules, { maxPerKeyword: 'all' }),
    '<p><a href="/btc">bitcoin</a> 与 <a href="/btc">Bitcoin</a></p>'
  )
})

test('keywordLinkHtml：正则特殊字符按字面匹配（C++）', () => {
  const rules = [{ keyword: 'C++', url: '/cpp' }]
  assert.equal(keywordLinkHtml('<p>C++ 很强</p>', rules), '<p><a href="/cpp">C++</a> 很强</p>')
})

test('keywordLinkHtml：实体安全——不切进 &amp; 中间，含 HTML 字符的关键词按实体形态命中', () => {
  // "amp" 会切散 &amp; ——跳过；独立出现照常链接
  assert.equal(
    keywordLinkHtml('<p>A&amp;B 与 amp</p>', [{ keyword: 'amp', url: '/amp' }]),
    '<p>A&amp;B 与 <a href="/amp">amp</a></p>'
  )
  // 关键词 AT&T 按存库的实体形态 AT&amp;T 命中，锚文本原样回填
  assert.equal(
    keywordLinkHtml('<p>AT&amp;T 公司</p>', [{ keyword: 'AT&T', url: '/att' }]),
    '<p><a href="/att">AT&amp;T</a> 公司</p>'
  )
})

test('keywordLinkHtml：外链按全站口径包装——非白名单包 /go，白名单直出，同源不打弯', () => {
  const target = 'https://example.com/x'
  assert.equal(
    keywordLinkHtml('<p>比特币</p>', [{ keyword: '比特币', url: target }], { origin: 'https://blog.test' }),
    `<p><a href="/go?u=${encodeURIComponent(target)}" target="_blank" rel="nofollow noopener noreferrer">比特币</a></p>`
  )
  assert.equal(
    keywordLinkHtml('<p>区块链</p>', [{ keyword: '区块链', url: 'https://zh.wikipedia.org/wiki/区块链' }], {
      origin: 'https://blog.test',
    }),
    '<p><a href="https://zh.wikipedia.org/wiki/区块链" rel="noopener noreferrer">区块链</a></p>'
  )
  assert.equal(
    keywordLinkHtml('<p>比特币</p>', [{ keyword: '比特币', url: 'https://blog.test/post/btc' }], {
      origin: 'https://blog.test',
    }),
    '<p><a href="https://blog.test/post/btc" rel="noopener noreferrer">比特币</a></p>'
  )
})

test('keywordLinkHtml：未终结标签兜底原样透传，空输入 / 无规则原文返回', () => {
  assert.equal(keywordLinkHtml('比特币 <img src="x', BTC), '<a href="/post/btc">比特币</a> <img src="x')
  assert.equal(keywordLinkHtml('', BTC), '')
  assert.equal(keywordLinkHtml('<p>比特币</p>', []), '<p>比特币</p>')
})

test('keywordLinkHtml：净化器真实产物形态可正常工作', () => {
  // sanitizeHtml 给 http(s) 链接带 rel="noopener noreferrer"——扫描器对既有 <a> 整段跳过
  const clean = sanitizeHtml('<p>比特币在 <a href="https://example.com/f">比特币论坛</a> 被讨论</p>')
  assert.equal(
    keywordLinkHtml(clean, BTC, { maxPerKeyword: 'all' }),
    '<p><a href="/post/btc">比特币</a>在 <a href="https://example.com/f" rel="noopener noreferrer">比特币论坛</a> 被讨论</p>'
  )
})

// ── 插件链集成：renderPostContentHtml（settings.serverPluginConfig → 钩子） ──

const cfgOf = (fields: Record<string, string>): SettingsMap => ({ serverPluginConfig: JSON.stringify({ 'keyword-link': fields }) })

test('renderPostContentHtml：keyword-link 配置生效——正文关键词包链接', () => {
  const settings = cfgOf({ rules: '比特币|/post/btc', maxPerKeyword: '2' })
  assert.equal(
    renderPostContentHtml(settings, '<p>比特币与比特币与比特币</p>', 'https://blog.test'),
    '<p><a href="/post/btc">比特币</a>与<a href="/post/btc">比特币</a>与比特币</p>'
  )
})

test('renderPostContentHtml：插件停用 / 配置脏 / 未配置一律原文返回', () => {
  const settings: SettingsMap = { ...cfgOf({ rules: '比特币|/post/btc' }), serverPluginsDisabled: 'keyword-link' }
  assert.equal(renderPostContentHtml(settings, '<p>比特币</p>'), '<p>比特币</p>')
  assert.equal(renderPostContentHtml({ serverPluginConfig: 'dirty{{{' } as SettingsMap, '<p>比特币</p>'), '<p>比特币</p>')
  assert.equal(renderPostContentHtml({} as SettingsMap, '<p>比特币</p>'), '<p>比特币</p>')
})

test('renderPostContentHtml：configValidate 语义校验拦坏配置', () => {
  const plugin = SERVER_PLUGINS.find((p) => p.id === 'keyword-link')!
  assert.ok(plugin)
  assert.equal(plugin.configValidate!({ rules: '比特币|/post/btc', maxPerKeyword: 'all' }), null)
  assert.ok(plugin.configValidate!({ rules: '坏行' })!.includes('关键词映射'))
  assert.ok(plugin.configValidate!({ rules: '比特币|/post/btc', maxPerKeyword: '0' })!.includes('替换次数'))
})
