/**
 * WordPress WXR 导入（B5 搬家导入工具）
 * =====================================
 * 解析 WordPress 导出的 WXR 1.2（RSS 2.0 + wp: 命名空间扩展）并把文章 / 页面 / 评论
 * 映射进本站。与 Markdown 包 / WXR 导出（A1，带走内容去别家）互为镜像：别人能来，我们也能回。
 *
 * 设计口径（与 AGENTS.md「复杂度预算」对齐的单文件模块）：
 * - 本文件是「一个自洽小文件」：解析与映射全是纯函数，Node 测试直接导入（tests/import-wxr.test.ts），
 *   不依赖 Workers 运行时；写库 / 转存等副作用全部留在 api.ts 端点层。
 * - 零依赖：WXR 解析用手写扫描器（XML 没有内置解析器，npm 包被依赖预算禁止）。
 *   扫描器全程 CDATA 感知——正文里含 "<item>" 字样的文章不会把解析器劈开。
 * - 上限常量集中在本文末（与 db.ts MAX_CONTENT_BYTES 同族的 import 侧口径），
 *   超限整体 400 并报出具体数字，引导用户用 WordPress 的「按作者 / 日期分卷导出」。
 *
 * 语义拍板（v1）：
 * - 合并式导入：目标站不要求为空（与整站包「只还原到空站」是两码事——那是同系统搬家，这是跨系统迁入）；
 *   slug 冲突由服务端自动加序号，重复导入会产生重复内容，由文档提醒。
 * - 保留原状态与原发布时间；pending/private 归草稿（宁严勿漏）；trash 跳过。
 * - 评论一并导入（approved 原样、待审进待审、spam/trash 跳过），email/website 落库
 *   （内部数据，公开面本来就不出 email）。
 * - 图片不阻塞导入：正文一步进来（外链原样），附件清单返回给前端分批转存
 *   （Workers 免费档子请求预算扛不住一次几百张），转存后服务端全局替换正文 / 封面引用。
 * - 导入不逐篇触发发布广播（firePostPublished）——换博客用户不想一次收到几百条 TG 通知。
 */

/* ============================ 类型 ============================ */

export interface WxrComment {
  wpId: number
  parent: number
  author: string
  email: string
  url: string
  dateGmtMs: number | null
  content: string
  status: 'approved' | 'pending'
}

export interface WxrItem {
  id: number
  type: 'post' | 'page' | 'attachment'
  title: string
  slug: string
  status: string
  password: string
  dateGmtMs: number | null
  dateLocalMs: number | null
  content: string
  excerpt: string
  categories: string[]
  tags: string[]
  thumbId: number
  attachmentUrl: string
  comments: WxrComment[]
  postmeta: { key: string; value: string }[]
}

export type WxrParseResult = { ok: true; items: WxrItem[] } | { ok: false; error: string }

export interface MappedPost {
  wpId: number
  title: string
  slug: string
  content: string
  excerpt: string
  status: 'published' | 'draft' | 'scheduled'
  publishedAt: number | null
  publishAt: number | null
  password: string
  categories: string[]
  tags: string[]
  thumbId: number
  comments: MappedComment[]
}

export interface MappedPage {
  wpId: number
  title: string
  slug: string
  content: string
  status: 'published' | 'draft'
  publishedAt: number | null
  comments: MappedComment[]
}

export interface MappedComment {
  postKey: number
  wpId: number
  parentWpId: number
  nickname: string
  email: string
  website: string
  content: string
  status: 'approved' | 'pending'
  createdAt: number | null
}

/** 导入侧体积 / 数量上限（api.ts 端点层校验并报具体数字；XML 预检走 api.ts 的 30MB 上传档） */
export const MAX_WXR_BYTES = 20 * 1024 * 1024
export const MAX_IMPORT_POSTS = 500
export const MAX_IMPORT_PAGES = 100
export const MAX_IMPORT_PASSWORDS = 20
export const MAX_IMPORT_IMAGES = 300
export const MAX_IMPORT_COMMENTS = 5000
/** 单批转存图片数（端点层限制；Workers 子请求预算内的保守值） */
export const IMPORT_IMAGE_BATCH = 10
/** 单篇正文上限（与 db.ts MAX_CONTENT_BYTES 同口径的字节限制，超限跳过该篇并计入报告） */
export const MAX_IMPORT_CONTENT_BYTES = 1024 * 1024

/* ============================ XML 扫描器（CDATA 感知） ============================ */

/** 在 s 里找 needle，扫描途中遇到 CDATA 段整体跳过（防止正文里的 "<item>" 字样劈开解析） */
function findTop(s: string, needle: string, from: number): number {
  let i = from
  while (i <= s.length - needle.length) {
    const hit = s.indexOf(needle, i)
    if (hit === -1) return -1
    // 检查 hit 前方是否存在未闭合的 CDATA 开始
    const cd = s.lastIndexOf('<![CDATA[', hit)
    if (cd !== -1) {
      const close = s.indexOf(']]>', cd)
      if (close !== -1 && close < hit) return hit // CDATA 已闭合，hit 在其外
      // hit 落在（或包着）CDATA 内 → 从 CDATA 结束之后继续找
      if (close === -1) return -1 // CDATA 未闭合，残文
      i = close + 3
      continue
    }
    return hit
  }
  return -1
}

/** 解 XML 基础实体与数字实体（CDATA 段不经此函数——CDATA 原样提取） */
export function decodeXmlEntities(s: string): string {
  if (!s.includes('&')) return s
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function safeFromCode(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  // XML 1.0 非法控制字符原样丢弃（与 src/xml.ts 输出侧的剥控制字符同族口径）
  if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0xd800 && code <= 0xdfff)) return ''
  return String.fromCodePoint(code)
}

/**
 * 提取 block 内第一个 <tag>…</tag> 的文本（tag 含命名空间前缀，如 wp:post_date）。
 * 值为 CDATA 时原样提取（不解释实体），否则解 XML 实体。找不到返回 null。
 */
export function extractText(block: string, tag: string): string | null {
  const openA = findTop(block, `<${tag}>`, 0)
  const openB = findTop(block, `<${tag} `, 0)
  let openStart = -1
  if (openA === -1 && openB === -1) return null
  if (openA === -1) openStart = openB
  else if (openB === -1) openStart = openA
  else openStart = Math.min(openA, openB)
  const innerStart = block.indexOf('>', openStart)
  if (innerStart === -1) return null
  const close = findTop(block, `</${tag}>`, innerStart)
  if (close === -1) return null
  const inner = block.slice(innerStart + 1, close)
  if (inner.startsWith('<![CDATA[')) {
    const body = inner.slice(9)
    const closeCd = body.indexOf(']]>')
    return closeCd === -1 ? body : body.slice(0, closeCd)
  }
  return decodeXmlEntities(inner.trim())
}

/** 提取 block 内全部 <tag>…</tag> 文本（category / postmeta 这类重复标签） */
export function extractAllText(block: string, tag: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const openA = findTop(block, `<${tag}>`, from)
    const openB = findTop(block, `<${tag} `, from)
    let openStart: number
    if (openA === -1 && openB === -1) break
    if (openA === -1) openStart = openB
    else if (openB === -1) openStart = openA
    else openStart = Math.min(openA, openB)
    const innerStart = block.indexOf('>', openStart)
    if (innerStart === -1) break
    const close = findTop(block, `</${tag}>`, innerStart)
    if (close === -1) break
    const inner = block.slice(innerStart + 1, close)
    if (inner.startsWith('<![CDATA[')) {
      const body = inner.slice(9)
      const closeCd = body.indexOf(']]>')
      out.push(closeCd === -1 ? body : body.slice(0, closeCd))
    } else {
      out.push(decodeXmlEntities(inner.trim()))
    }
    from = close + tag.length + 3
  }
  return out
}

/** 提取带属性的重复标签（WXR 的 <category domain="category" nicename="…">名</category>） */
export function extractCategoryTags(block: string): { name: string; domain: string; nicename: string }[] {
  const out: { name: string; domain: string; nicename: string }[] = []
  let from = 0
  for (;;) {
    const open = findTop(block, '<category', from)
    if (open === -1) break
    const gt = block.indexOf('>', open)
    if (gt === -1) break
    const attrs = block.slice(open + 9, gt)
    const close = findTop(block, '</category>', gt)
    if (close === -1) break
    const inner = block.slice(gt + 1, close)
    let name: string
    if (inner.startsWith('<![CDATA[')) {
      const body = inner.slice(9)
      const closeCd = body.indexOf(']]>')
      name = closeCd === -1 ? body : body.slice(0, closeCd)
    } else {
      name = decodeXmlEntities(inner.trim())
    }
    const domain = /domain="([^"]*)"/.exec(attrs)?.[1] || ''
    const nicename = /nicename="([^"]*)"/.exec(attrs)?.[1] || ''
    if (name) out.push({ name, domain, nicename })
    from = close + 11
  }
  return out
}

/* ============================ WXR 解析 ============================ */

/** WordPress 日期（`YYYY-MM-DD HH:MM:SS`）按 UTC 解析成毫秒；占位值（0000-…）与坏值返回 null */
export function parseWpDate(raw: string | null): number | null {
  if (!raw) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim())
  if (!m) return null
  if (m[1] === '0000') return null
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
  return Number.isFinite(ms) ? ms : null
}

/** WXR status → 本站 status；返回 null = 该篇跳过（trash / 自动草稿 / 附件继承态） */
export function mapWxrStatus(wpStatus: string): 'published' | 'draft' | 'scheduled' | null {
  switch ((wpStatus || '').trim()) {
    case 'publish':
      return 'published'
    case 'future':
      return 'scheduled'
    case 'draft':
    case 'pending':
    case 'private': // WP 登录可见——导入端没有对应语义，归草稿（宁严勿漏）
      return 'draft'
    default:
      return null
  }
}

/** wp:comment_approved → 本站评论状态；null = 跳过（spam / trash / 空值） */
export function mapCommentStatus(v: string): 'approved' | 'pending' | null {
  const t = (v || '').trim()
  if (t === '1' || t === 'approve' || t === 'approved') return 'approved'
  if (t === '0' || t === 'pending' || t === 'hold') return 'pending'
  return null
}

/** 解析整个 WXR 文本。结构不对（非 RSS / 无 channel）返回 { ok:false, error } */
export function parseWxr(xml: string): WxrParseResult {
  if (!xml || findTop(xml, '<channel', 0) === -1) {
    return { ok: false, error: 'not-wxr' }
  }
  const items: WxrItem[] = []
  let from = 0
  for (;;) {
    const start = findTop(xml, '<item>', from)
    const startB = start === -1 ? findTop(xml, '<item ', from) : start
    const openStart = start === -1 ? startB : start
    if (openStart === -1) break
    const innerStart = xml.indexOf('>', openStart)
    if (innerStart === -1) break
    const end = findTop(xml, '</item>', innerStart)
    if (end === -1) break
    const block = xml.slice(innerStart + 1, end)
    const item = parseWxrItem(block)
    if (item) items.push(item)
    from = end + 7
  }
  return { ok: true, items }
}

function parseWxrItem(block: string): WxrItem | null {
  const type = (extractText(block, 'wp:post_type') || '').trim()
  if (type !== 'post' && type !== 'page' && type !== 'attachment') return null // nav_menu_item 等跳过
  const id = Number(extractText(block, 'wp:post_id')) || 0
  const comments: WxrComment[] = []
  for (const cb of splitChildren(block, 'wp:comment')) {
    const wpId = Number(extractText(cb, 'wp:comment_id')) || 0
    const status = mapCommentStatus(extractText(cb, 'wp:comment_approved') || '')
    if (!wpId || !status) continue
    comments.push({
      wpId,
      parent: Number(extractText(cb, 'wp:comment_parent')) || 0,
      author: (extractText(cb, 'wp:comment_author') || '').slice(0, 24) || '匿名',
      email: (extractText(cb, 'wp:comment_author_email') || '').slice(0, 120),
      url: (extractText(cb, 'wp:comment_author_url') || '').slice(0, 300),
      dateGmtMs: parseWpDate(extractText(cb, 'wp:comment_date_gmt') || extractText(cb, 'wp:comment_date')),
      content: extractText(cb, 'wp:comment_content') || '',
      status,
    })
  }
  const cats = extractCategoryTags(block)
  const postmeta: { key: string; value: string }[] = []
  for (const mb of splitChildren(block, 'wp:postmeta')) {
    const key = extractText(mb, 'wp:meta_key')
    const value = extractText(mb, 'wp:meta_value')
    if (key) postmeta.push({ key, value: value || '' })
  }
  const thumbId = Number(postmeta.find((m) => m.key === '_thumbnail_id')?.value) || 0
  return {
    id,
    type: type as WxrItem['type'],
    title: (extractText(block, 'title') || '').trim(),
    slug: (extractText(block, 'wp:post_name') || '').trim(),
    status: (extractText(block, 'wp:status') || '').trim(),
    password: (extractText(block, 'wp:post_password') || '').trim(),
    dateGmtMs: parseWpDate(extractText(block, 'wp:post_date_gmt')),
    dateLocalMs: parseWpDate(extractText(block, 'wp:post_date')),
    content: extractText(block, 'content:encoded') || '',
    excerpt: extractText(block, 'excerpt:encoded') || '',
    categories: cats.filter((c) => c.domain === 'category' || (!c.domain && !c.nicename)).map((c) => c.name),
    tags: cats.filter((c) => c.domain === 'post_tag').map((c) => c.name),
    thumbId,
    attachmentUrl: type === 'attachment' ? (extractText(block, 'wp:attachment_url') || '').trim() : '',
    comments,
    postmeta,
  }
}

/** 按 open/close 标签切出重复子块（wp:comment / wp:postmeta）——与 findTop 同样 CDATA 感知 */
function splitChildren(block: string, tag: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const open = findTop(block, `<${tag}>`, from)
    if (open === -1) break
    const innerStart = open + tag.length + 2
    const close = findTop(block, `</${tag}>`, innerStart)
    if (close === -1) break
    out.push(block.slice(innerStart, close))
    from = close + tag.length + 3
  }
  return out
}

/* ============================ 映射（写库前的纯转换） ============================ */

export interface MappedImport {
  posts: MappedPost[]
  pages: MappedPage[]
  comments: MappedComment[]
  /** 需要建的分类名（服务端与现有分类对比后只建缺失的） */
  categoryNames: string[]
  /** 需要建的标签名（服务端按需去重后入 JSON 列） */
  tagNames: string[]
  /** 附件图片清单（去重、http(s) only、上限截断）——前端分批转存 */
  images: string[]
  /** 被跳过的篇目（含原因），报告给管理员 */
  skipped: { id: number; title: string; reason: string }[]
  counts: { posts: number; pages: number; comments: number; protected: number; attachments: number }
}

/**
 * 把解析结果映射成本站行（不含写库）。slug 冲突在端点层结合现有库处理，
 * 这里只做状态 / 时间 / 语义的纯转换。
 */
export function mapWxrImport(items: WxrItem[]): MappedImport {
  const posts: MappedPost[] = []
  const pages: MappedPage[] = []
  const comments: MappedComment[] = []
  const categoryNames: string[] = []
  const tagNames: string[] = []
  const skipped: { id: number; title: string; reason: string }[] = []
  const images: string[] = []
  let protectedCount = 0
  let commentCount = 0

  for (const it of items) {
    if (it.type === 'attachment') {
      if (it.attachmentUrl && /^https?:\/\//i.test(it.attachmentUrl)) images.push(it.attachmentUrl)
      continue
    }
    const status = mapWxrStatus(it.status)
    if (!status) {
      skipped.push({ id: it.id, title: it.title, reason: `状态「${it.status || '空'}」不导入` })
      continue
    }
    // 正文按 UTF-8 字节限长（与站内正文上限同口径）；超限跳过并报告，不让单篇巨型文拖垮整次导入
    if (it.type === 'post' && new TextEncoder().encode(it.content).length > MAX_IMPORT_CONTENT_BYTES) {
      skipped.push({ id: it.id, title: it.title, reason: '正文超过 1MB 上限' })
      continue
    }
    const publishedAt =
      status === 'published' ? it.dateGmtMs ?? it.dateLocalMs ?? null : null
    const publishAt =
      status === 'scheduled' ? it.dateGmtMs ?? it.dateLocalMs ?? null : null
    // publishedAt 为 null 的已发布文由端点层以当前时间兜底（映射层不碰 Date.now() 保持可测性）

    if (it.password) protectedCount++
    const mappedComments: MappedComment[] = []
    for (const cm of it.comments) {
      if (commentCount >= MAX_IMPORT_COMMENTS) break
      mappedComments.push({
        postKey: it.id,
        wpId: cm.wpId,
        parentWpId: cm.parent,
        nickname: cm.author,
        email: cm.email,
        website: cm.url,
        content: cm.content,
        status: cm.status,
        createdAt: cm.dateGmtMs ?? it.dateGmtMs ?? null,
      })
      commentCount++
    }
    comments.push(...mappedComments)

    for (const c of it.categories) if (!categoryNames.includes(c)) categoryNames.push(c)
    for (const t of it.tags) if (!tagNames.includes(t)) tagNames.push(t)

    if (it.type === 'page') {
      pages.push({
        wpId: it.id,
        title: it.title || '无标题页面',
        slug: it.slug,
        content: it.content,
        status: status === 'scheduled' ? 'draft' : status, // 页面没有定时语义，future 归草稿
        publishedAt,
        comments: mappedComments,
      })
    } else {
      posts.push({
        wpId: it.id,
        title: it.title || '无标题',
        slug: it.slug,
        content: it.content,
        excerpt: it.excerpt,
        status,
        publishedAt,
        publishAt,
        password: it.password,
        categories: it.categories,
        tags: it.tags,
        thumbId: it.thumbId,
        comments: mappedComments,
      })
    }
  }

  // 附件 URL 去重 + 上限
  const uniqImages = [...new Set(images)].slice(0, MAX_IMPORT_IMAGES)

  return {
    posts,
    pages,
    comments,
    categoryNames,
    tagNames,
    images: uniqImages,
    skipped,
    counts: {
      posts: posts.length,
      pages: pages.length,
      comments: comments.length,
      protected: protectedCount,
      attachments: images.length,
    },
  }
}
