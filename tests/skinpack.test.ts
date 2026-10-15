import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanCustomCss, customCssHeadStyle, needsFontSrc } from '../src/skinpack.ts'

// ── cleanCustomCss：样式安检门 ──

test('clean：空/空白 = 清空；合法 CSS 原样通过（trim）', () => {
  assert.equal(cleanCustomCss(''), '')
  assert.equal(cleanCustomCss('   \n  '), '')
  const css = '.rich img { border-radius: 8px; }\n@media (max-width: 560px) { .rich { padding: 12px; } }'
  assert.equal(cleanCustomCss(css), css)
})

test('clean：@import 剥除（大小写、url 与字符串两种形态）', () => {
  const out = cleanCustomCss('@import url("https://evil.example/x.css"); .rich { color: red; }')!
  assert.ok(!out.toLowerCase().includes('@import'))
  assert.ok(out.includes('.rich { color: red; }'), '其余规则保留')
  assert.ok(!cleanCustomCss('@IMPORT "x.css";')!.toLowerCase().includes('@import'))
})

test('clean：</style 逃逸全形态剥除（大小写 / 空格变体），<!-- 一并剥掉', () => {
  const out = cleanCustomCss('.a { color: red; } </style><script>alert(1)</script>')!
  assert.ok(!out.toLowerCase().includes('</style'), '不能逃出 <style> 上下文')
  assert.ok(!out.toLowerCase().includes('<script'))
  assert.ok(!cleanCustomCss('</ STYLE>')!.toLowerCase().includes('<'))
  assert.ok(!cleanCustomCss('/* x */ <!-- .a{} -->')!.includes('<!--'))
})

test('clean：expression / -moz-binding / behavior 历史脚本面剥除', () => {
  assert.ok(!cleanCustomCss('.a { width: expression(alert(1)); }')!.toLowerCase().includes('expression'))
  assert.ok(!cleanCustomCss('.a { -moz-binding: url(https://x.example/y.xml); }')!.toLowerCase().includes('-moz-binding'))
  assert.ok(!cleanCustomCss('.a { behavior: url(x.htc); }')!.toLowerCase().includes('behavior'))
})

test('clean：url() 白名单——https / 站内相对 / data:image|font 放行，javascript / http / 其他 data 拒绝', () => {
  assert.ok(cleanCustomCss('.a { background: url(https://cdn.example/x.png); }'))
  assert.ok(cleanCustomCss('.a { background: url(/images/u/a.png); }'))
  assert.ok(cleanCustomCss(".a { background: url('./bg.png'); }"))
  assert.ok(cleanCustomCss('.a { background: url(data:image/png;base64,AAAA); }'))
  assert.ok(cleanCustomCss('.a { src: url(data:font/woff2;base64,AAAA); }'))
  assert.equal(cleanCustomCss('.a { background: url(javascript:alert(1)); }'), null)
  assert.equal(cleanCustomCss('.a { background: url(http://insecure.example/x.png); }'), null, '混合内容 http 拒绝')
  assert.equal(cleanCustomCss('.a { background: url(data:text/html,<script>alert(1)</script>); }'), null)
  assert.equal(cleanCustomCss('.a { background: url(vbscript:x); }'), null)
  assert.equal(cleanCustomCss('.a { background: url(//protocol-relative.example/x.png); }'), null, '协议相对地址也拒绝（宁拒勿漏）')
})

test('clean：花括号配平；超长拒绝；控制字符剥除', () => {
  assert.equal(cleanCustomCss('.a { color: red;'), null, '少右括号')
  assert.equal(cleanCustomCss('.a { color: red; } }'), null, '多余右括号')
  assert.equal(cleanCustomCss('.a {'.repeat(500) + '}'), null)
  assert.ok(!cleanCustomCss('.a { color: red\u0000; }')!.includes('\u0000'))
})

test('clean：幂等——净化输出再过一遍结果不变（渲染端二次净化依赖此性质）', () => {
  const dirty = '@import url(x.css); .a { width: expression(alert(1)); } </style>ok'
  const once = cleanCustomCss(dirty)!
  assert.equal(cleanCustomCss(once), once)
})

// ── customCssHeadStyle：渲染期注入口（二次净化，脏数据静默当没配）──

test('head：无配置 → 空串（输出字节级不变）；合法 → <style data-custom-css>', () => {
  assert.equal(customCssHeadStyle({ customCss: '' }), '')
  assert.equal(customCssHeadStyle({}), '')
  assert.equal(customCssHeadStyle({ customCss: '  ' }), '')
  const html = customCssHeadStyle({ customCss: '.rich { letter-spacing: 0.02em; }' })
  assert.ok(html.startsWith('<style data-custom-css>'))
  assert.ok(html.endsWith('</style>'))
  assert.ok(html.includes('.rich { letter-spacing: 0.02em; }'))
})

test('head：库里被旁路写脏时二次净化兜底——</style 逃逸到不了输出', () => {
  const html = customCssHeadStyle({ customCss: '.a { color: red } </style><script>alert(1)</script>' })
  assert.ok(!html.toLowerCase().includes('</style></style>'))
  assert.ok(!html.toLowerCase().includes('<script'), '剥除后残骸不构成脚本注入')
})

// ── needsFontSrc：CSP 放宽判定 ──

test('fontSrc：有自定义 CSS 才放宽，无 CSS 的站点 CSP 字节级不变', () => {
  assert.equal(needsFontSrc(null), false)
  assert.equal(needsFontSrc(undefined), false)
  assert.equal(needsFontSrc({ customCss: '' }), false)
  assert.equal(needsFontSrc({ customCss: '  \n ' }), false)
  assert.equal(needsFontSrc({ customCss: '.a { color: red }' }), true)
})
