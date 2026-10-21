/**
 * 关键词自动内链（服务端插件 keyword-link 的纯函数组，hooks.ts 注册表同文件模式）：
 * 站长配置「关键词|链接」映射表，文章正文渲染时把命中的关键词文本包成 <a>——
 * SEO 内链 / 术语跳转。渲染期改写不落库：改映射回溯全站旧文，停用插件即全部消失。
 *
 * 扫描器只处理文本节点，一律跳过：标签属性、既有 <a> 内部（不嵌套链接）、
 * <pre>/<code> 等代码语境（代码正确性优先）、h1-h6 标题（目录卡与锚点保持干净）、
 * HTML 注释。同一位置多词命中取最长（「比特币」优先于「特币」）；纯 ASCII 词加 \b
 * 边界（关键词 AI 不命中 detail）；命中文本原样回填（存库 HTML 已转义，不二次加工），
 * 落在实体残段上的命中（&amp; 中间的 "amp"）按不安全跳过——宁缺勿错。
 *
 * 本模块被 Node 测试直接导入（同 outlink.ts 理由），不依赖 Workers 运行时。
 */
import { escAttr } from './sanitize'
import { outHref } from './outlink'

/** 规则上限：防一条超长配置拖慢每篇文章的渲染扫描 */
const MAX_RULES = 100
const MAX_KEYWORD_CHARS = 60
const MAX_URL_CHARS = 500

export interface KeywordRule {
  /** 关键词原文（不含转义） */
  keyword: string
  /** 原始链接（http(s) 绝对地址或本站相对路径；渲染时过 outHref 按全站口径包装） */
  url: string
}

/** 正文文本节点的实体形态（utils.esc 同表）：关键词先转成本形态再匹配，
 *  含 HTML 特殊字符的关键词（如 AT&T）才能命中存库里的 AT&amp;T */
function escapeForMatch(kw: string): string {
  return kw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 合并正则的单条备选源：实体形态 + 正则转义；首尾是 ASCII 词字符的加 \b 边界
 *  （边界只对 ASCII 有定义，「5G基站」首字符 5 加 \b 可挡住「x5G基站」误命中） */
function buildPattern(keyword: string): string {
  const body = regexEscape(escapeForMatch(keyword))
  const head = /^[A-Za-z0-9]/.test(keyword) ? '\\b' : ''
  const tail = /[A-Za-z0-9]$/.test(keyword) ? '\\b' : ''
  return head + body + tail
}

function isRuleValid(keyword: string, url: string): boolean {
  if (!keyword || [...keyword].length > MAX_KEYWORD_CHARS) return false
  if (!url || url.length > MAX_URL_CHARS) return false
  // 只放行 http(s) 绝对地址与本站相对路径——javascript: / data: 等一律不入表
  return /^https?:\/\//i.test(url) || url.startsWith('/')
}

/** 解析一行「关键词|链接」；不合法返回 null（lenient 跳过 / strict 报行号） */
function parseRuleLine(line: string): KeywordRule | null {
  const idx = line.indexOf('|')
  if (idx <= 0) return null
  const keyword = line.slice(0, idx).trim()
  const url = line.slice(idx + 1).trim()
  return isRuleValid(keyword, url) ? { keyword, url } : null
}

function isCommentLine(t: string): boolean {
  return t.startsWith('#') || t.startsWith('//')
}

/** lenient 解析（渲染路径）：坏行静默跳过，重复关键词取先者，超量截断 */
export function parseKeywordRules(raw: string): KeywordRule[] {
  const out: KeywordRule[] = []
  const seen = new Set<string>()
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || isCommentLine(t)) continue
    const r = parseRuleLine(t)
    if (!r || seen.has(r.keyword)) continue
    seen.add(r.keyword)
    out.push(r)
    if (out.length >= MAX_RULES) break
  }
  return out
}

/** strict 校验（configValidate）：坏行报行号、整体拒绝保存——不让半配置静默失效。
 *  重复关键词不报错（渲染时先者生效），返回 null = 通过 */
export function keywordRulesError(raw: string): string | null {
  let count = 0
  const seen = new Set<string>()
  const lines = String(raw ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || isCommentLine(t)) continue
    count++
    if (count > MAX_RULES) return `关键词最多 ${MAX_RULES} 条`
    const idx = t.indexOf('|')
    if (idx <= 0) return `第 ${i + 1} 行格式不对：应为「关键词|链接」`
    const keyword = t.slice(0, idx).trim()
    const url = t.slice(idx + 1).trim()
    if (!keyword || [...keyword].length > MAX_KEYWORD_CHARS)
      return `第 ${i + 1} 行关键词为空或超过 ${MAX_KEYWORD_CHARS} 字`
    if (!url || url.length > MAX_URL_CHARS)
      return `第 ${i + 1} 行链接为空或超过 ${MAX_URL_CHARS} 字符`
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/'))
      return `第 ${i + 1} 行链接必须是 http(s) 地址或本站相对路径（/post/…）`
    if (!seen.has(keyword)) seen.add(keyword)
  }
  return null
}

/** 每篇替换次数：留空 / 非数字 = 1（仅首次，SEO 内链惯例）；all / 全部 = 全部替换；
 *  数字 N = 前 N 次（上限 99） */
export function parseMaxPerKeyword(raw: string): number | 'all' {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === 'all' || v === '全部') return 'all'
  const n = parseInt(v, 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, 99)
}

export interface KeywordLinkOptions {
  /** 当前请求源（renderPost 有）：非白名单外链按全站口径包 /go 中间页 */
  origin?: string
  /** 每个关键词每篇替换上限：数字 N = 前 N 次；'all' = 全部。默认 1 */
  maxPerKeyword?: number | 'all'
}

/** 语境跳过表：既有链接内不嵌套链接；代码语境不自动链接；标题保持干净
 *  （目录卡、标题锚点与主题样式不受内链影响） */
const SKIP_TAGS = new Set([
  'a',
  'pre',
  'code',
  'kbd',
  'samp',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'script',
  'style',
  'textarea',
  'iframe',
  'svg',
  'object',
])

/** 不成对的空元素：不得入栈（<br> 若入栈永远等不到 </br>，其后全文都会被误跳过） */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** 命中是否落在实体残段上：文本 "A&amp;B" 里关键词 amp 会切在实体中间，回填后
 *  实体被拆散、渲染错位——一律跳过（宁缺勿错）。两向检查：命中起点躲在未终结实体
 *  里、或命中文本自身吞了半个实体 */
function entityUnsafe(seg: string, start: number, end: number): boolean {
  const prevSemi = seg.lastIndexOf(';', start - 1)
  const amp = seg.indexOf('&', prevSemi + 1)
  if (amp !== -1 && amp < start) return true
  const body = seg.slice(start, end)
  const lastSemi = body.lastIndexOf(';')
  return body.indexOf('&', lastSemi + 1) !== -1
}

/** 锚点 HTML：属性口径与 sanitizeHtml 的 <a> 输出一致——被包成 /go 中间页的外链
 *  加 target=_blank + nofollow/noopener，其余 http(s) 加 rel=noopener，站内相对链接裸 <a>。
 *  锚文本用命中原文回填（存库 HTML 已转义，不二次加工） */
function anchorHtml(url: string, text: string, origin?: string): string {
  const href = outHref(url, origin)
  let attrs = ''
  if (href !== url) attrs = ' target="_blank" rel="nofollow noopener noreferrer"'
  else if (/^https?:\/\//i.test(url)) attrs = ' rel="noopener noreferrer"'
  return `<a href="${escAttr(href)}"${attrs}>${text}</a>`
}

/** 主入口：把正文 HTML 里的关键词包成链接。rules 为空 / 正则编译失败一律原文返回 */
export function keywordLinkHtml(html: string, rules: KeywordRule[], opts: KeywordLinkOptions = {}): string {
  if (!html || !rules.length) return html
  const max = opts.maxPerKeyword ?? 1
  // 备选按 pattern 长度降序——正则交替在同一位置取第一个能匹配的备选，长词优先
  // （「比特币」与「特币」同时在表里时，重叠命中归长词）
  const ordered = rules
    .map((r) => ({ ...r, pattern: buildPattern(r.keyword) }))
    .sort((a, b) => b.pattern.length - a.pattern.length)
  let re: RegExp
  try {
    re = new RegExp(ordered.map((r) => `(${r.pattern})`).join('|'), 'gi')
  } catch {
    return html
  }
  // 每个关键词每篇的替换计数跨全文累计（不是按段落），命中序号 = 备选组序号 - 1
  const counters = new Array(ordered.length).fill(0) as number[]
  const stack: string[] = []
  let out = ''
  let pos = 0
  const n = html.length

  /** 文本段替换；stack 非空 = 语境跳过区（链接 / 代码 / 标题…），原样返回 */
  const linkText = (seg: string): string => {
    if (!seg || stack.length) return seg
    re.lastIndex = 0
    let segOut = ''
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(seg))) {
      let ri = -1
      for (let g = 1; g < m.length; g++) {
        if (m[g] !== undefined) {
          ri = g - 1
          break
        }
      }
      if (ri < 0) break
      const matched = m[0]
      if (!matched) {
        re.lastIndex++
        continue
      }
      if (max !== 'all' && counters[ri] >= (max as number)) continue
      const start = m.index
      if (entityUnsafe(seg, start, start + matched.length)) continue
      counters[ri]++
      segOut += seg.slice(last, start) + anchorHtml(ordered[ri].url, matched, opts.origin)
      last = start + matched.length
    }
    return segOut + seg.slice(last)
  }

  while (pos < n) {
    const lt = html.indexOf('<', pos)
    if (lt === -1) {
      out += linkText(html.slice(pos))
      break
    }
    if (lt > pos) out += linkText(html.slice(pos, lt))
    if (html.startsWith('<!--', lt)) {
      // 注释整段原样（里面的关键词不是可见文本）
      const end = html.indexOf('-->', lt + 4)
      const stop = end === -1 ? n : end + 3
      out += html.slice(lt, stop)
      pos = stop
      continue
    }
    const gt = html.indexOf('>', lt)
    if (gt === -1) {
      // 未终结的标签前缀：余下原样透传（净化器不该产出，防御兜底）
      out += html.slice(lt)
      break
    }
    const tag = html.slice(lt, gt + 1)
    const tm = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)
    if (tm) {
      const name = tm[2].toLowerCase()
      if (SKIP_TAGS.has(name)) {
        if (tm[1]) {
          const open = stack.lastIndexOf(name)
          if (open !== -1) stack.length = open
        } else if (!tag.endsWith('/>') && !VOID_TAGS.has(name)) {
          stack.push(name)
        }
      }
    }
    out += tag
    pos = gt + 1
  }
  return out
}
