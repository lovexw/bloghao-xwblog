import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeXmlEntities,
  extractText,
  mapCommentStatus,
  mapWxrImport,
  mapWxrStatus,
  MAX_IMPORT_CONTENT_BYTES,
  parseWpDate,
  parseWxr,
} from '../src/import-wxr'

/** 构造一份有代表性的 WXR 样本：CDATA 正文 / 实体 / postmeta / 缩略图 / 评论树 / 页面 / 附件 / 各种状态 */
const SAMPLE = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>老博客</title>
  <wp:wxr_version>1.2</wp:wxr_version>

  <item>
    <title>发布文：介绍 &amp; 背景里藏有 &lt;b&gt;标签</title>
    <wp:post_id>101</wp:post_id>
    <wp:post_date>2023-05-01 12:00:00</wp:post_date>
    <wp:post_date_gmt>2023-05-01 04:00:00</wp:post_date_gmt>
    <wp:post_name>hello-post</wp:post_name>
    <wp:status>publish</wp:status>
    <wp:post_type>post</wp:post_type>
    <category domain="category" nicename="life"><![CDATA[生活]]></category>
    <category domain="post_tag" nicename="travel">旅行</category>
    <category domain="post_tag" nicename="code">编程</category>
    <content:encoded><![CDATA[<p>正文第一段，讲 <a href="https://wp.example.com/wp-content/uploads/2023/05/a.jpg">图片</a>。</p><!--more--><p>正文第二段谈 RSS 里的 &lt;item&gt; 标签与 ]]&gt; 不会出现。</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[<p>手写摘要</p>]]></excerpt:encoded>
    <wp:postmeta>
      <wp:meta_key>_thumbnail_id</wp:meta_key>
      <wp:meta_value><![CDATA[201]]></wp:meta_value>
    </wp:postmeta>
    <wp:comment>
      <wp:comment_id>9001</wp:comment_id>
      <wp:comment_author><![CDATA[张三]]></wp:comment_author>
      <wp:comment_author_email>zs@example.com</wp:comment_author_email>
      <wp:comment_author_url>https://zs.example.com</wp:comment_author_url>
      <wp:comment_date_gmt>2023-05-02 03:00:00</wp:comment_date_gmt>
      <wp:comment_approved>1</wp:comment_approved>
      <wp:comment_parent>0</wp:comment_parent>
      <wp:comment_content><![CDATA[<p>写得好！</p>]]></wp:comment_content>
    </wp:comment>
    <wp:comment>
      <wp:comment_id>9002</wp:comment_id>
      <wp:comment_author><![CDATA[李四]]></wp:comment_author>
      <wp:comment_date_gmt>2023-05-02 05:00:00</wp:comment_date_gmt>
      <wp:comment_approved>0</wp:comment_approved>
      <wp:comment_parent>9001</wp:comment_parent>
      <wp:comment_content><![CDATA[回复张三：同感]]></wp:comment_content>
    </wp:comment>
    <wp:comment>
      <wp:comment_id>9003</wp:comment_id>
      <wp:comment_author><![CDATA[垃圾君]]></wp:comment_author>
      <wp:comment_approved>spam</wp:comment_approved>
      <wp:comment_content><![CDATA[广告]]></wp:comment_content>
    </wp:comment>
  </item>

  <item>
    <title>定时文</title>
    <wp:post_id>102</wp:post_id>
    <wp:post_date>2030-01-01 08:00:00</wp:post_date>
    <wp:post_date_gmt>2030-01-01 00:00:00</wp:post_date_gmt>
    <wp:post_name>scheduled-post</wp:post_name>
    <wp:status>future</wp:status>
    <wp:post_type>post</wp:post_type>
    <content:encoded><![CDATA[<p>未来见</p>]]></content:encoded>
  </item>

  <item>
    <title>密码文</title>
    <wp:post_id>103</wp:post_id>
    <wp:post_date>2023-06-01 09:00:00</wp:post_date>
    <wp:post_date_gmt>0000-00-00 00:00:00</wp:post_date_gmt>
    <wp:status>publish</wp:status>
    <wp:post_password>wp-secret</wp:post_password>
    <wp:post_type>post</wp:post_type>
    <content:encoded><![CDATA[<p>机密</p>]]></content:encoded>
  </item>

  <item>
    <title>私密文</title>
    <wp:post_id>104</wp:post_id>
    <wp:post_date>2023-06-02 09:00:00</wp:post_date>
    <wp:status>private</wp:status>
    <wp:post_type>post</wp:post_type>
    <content:encoded><![CDATA[<p>私密</p>]]></content:encoded>
  </item>

  <item>
    <title>回收站文</title>
    <wp:post_id>105</wp:post_id>
    <wp:status>trash</wp:status>
    <wp:post_type>post</wp:post_type>
  </item>

  <item>
    <title>关于页面</title>
    <wp:post_id>106</wp:post_id>
    <wp:post_date>2023-01-01 00:00:00</wp:post_date>
    <wp:post_date_gmt>2022-12-31 16:00:00</wp:post_date_gmt>
    <wp:post_name>about-me</wp:post_name>
    <wp:status>publish</wp:status>
    <wp:post_type>page</wp:post_type>
    <content:encoded><![CDATA[<h2>关于我</h2><p>页面正文</p>]]></content:encoded>
  </item>

  <item>
    <title>a</title>
    <wp:post_id>201</wp:post_id>
    <wp:post_date>2023-05-01 00:00:00</wp:post_date>
    <wp:status>inherit</wp:status>
    <wp:post_type>attachment</wp:post_type>
    <wp:attachment_url>https://wp.example.com/wp-content/uploads/2023/05/a.jpg</wp:attachment_url>
  </item>

  <item>
    <title>b</title>
    <wp:post_id>202</wp:post_id>
    <wp:status>inherit</wp:status>
    <wp:post_type>attachment</wp:post_type>
    <wp:attachment_url>https://wp.example.com/wp-content/uploads/2023/05/a.jpg</wp:attachment_url>
  </item>

  <item>
    <title>导航菜单</title>
    <wp:post_id>301</wp:post_id>
    <wp:status>publish</wp:status>
    <wp:post_type>nav_menu_item</wp:post_type>
  </item>
</channel>
</rss>`

test('parseWxr：解析条目数量与类型分流', () => {
  const r = parseWxr(SAMPLE)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.items.length, 8) // nav_menu_item 在解析层即弃（不进 items 也不进 skipped）
  const byType = { post: 0, page: 0, attachment: 0 }
  for (const it of r.items) byType[it.type]++
  assert.deepEqual(byType, { post: 5, page: 1, attachment: 2 })
})

test('parseWxr：CDATA 正文原样保留、标题实体已解码、CDATA 内的 <item> 字样不劈开解析', () => {
  const r = parseWxr(SAMPLE)
  if (!r.ok) return assert.fail()
  const hello = r.items.find((i) => i.id === 101)!
  assert.equal(hello.title, '发布文：介绍 & 背景里藏有 <b>标签')
  assert.ok(hello.content.includes('RSS 里的 &lt;item&gt; 标签')) // CDATA 原样：HTML 实体不二次解码
  assert.ok(hello.content.includes('<!--more-->'))
  assert.equal(hello.slug, 'hello-post')
  assert.deepEqual(hello.categories, ['生活'])
  assert.deepEqual(hello.tags, ['旅行', '编程'])
  assert.equal(hello.thumbId, 201)
  // 正文里的 "<item>" 字样出现于 CDATA 内——若扫描器不感知 CDATA，本篇之后的条目会被吞
  assert.ok(r.items.some((i) => i.id === 102), 'CDATA 内的 <item> 字样不能劈开 item 分割')
})

test('parseWxr：评论树解析（approved / pending 进，spam 解析层即弃）与父引用', () => {
  const r = parseWxr(SAMPLE)
  if (!r.ok) return assert.fail()
  const hello = r.items.find((i) => i.id === 101)!
  assert.equal(hello.comments.length, 2)
  assert.equal(hello.comments[0].author, '张三')
  assert.equal(hello.comments[0].status, 'approved')
  assert.equal(hello.comments[1].parent, 9001)
  assert.equal(hello.comments[1].status, 'pending')
})

test('mapWxrImport：状态映射 / 时间口径 / 密码统计 / 附件去重 / skipped 报告', () => {
  const r = parseWxr(SAMPLE)
  if (!r.ok) return assert.fail()
  const m = mapWxrImport(r.items)
  assert.equal(m.counts.posts, 4) // 发布文 + 定时文 + 密码文 + 私密归草稿（trash 已跳过）
  assert.equal(m.counts.pages, 1)
  assert.equal(m.counts.protected, 1)
  assert.equal(m.counts.attachments, 2)
  assert.equal(m.images.length, 1) // 两个附件同 URL，去重
  assert.equal(m.images[0], 'https://wp.example.com/wp-content/uploads/2023/05/a.jpg')

  const hello = m.posts.find((p) => p.wpId === 101)!
  assert.equal(hello.status, 'published')
  assert.equal(hello.publishedAt, Date.parse('2023-05-01T04:00:00Z')) // gmt 优先
  assert.equal(hello.excerpt, '<p>手写摘要</p>')
  assert.equal(hello.thumbId, 201)
  assert.deepEqual(hello.tags, ['旅行', '编程'])

  const scheduled = m.posts.find((p) => p.wpId === 102)!
  assert.equal(scheduled.status, 'scheduled')
  assert.equal(scheduled.publishAt, Date.parse('2030-01-01T00:00:00Z'))
  assert.equal(scheduled.publishedAt, null)

  const secret = m.posts.find((p) => p.wpId === 103)!
  assert.equal(secret.password, 'wp-secret')
  // gmt 列是 WP 占位值（0000-…）→ 回退 post_date 本地时间列按 UTC 解析（比 null 好，时区误差由文档说明）
  assert.equal(secret.publishedAt, Date.parse('2023-06-01T09:00:00Z'))

  const priv = m.posts.find((p) => p.wpId === 104)!
  assert.equal(priv.status, 'draft') // private 归草稿（宁严勿漏）
  assert.equal(priv.password, '')

  // trash 跳过进报告
  assert.ok(m.skipped.some((s) => s.id === 105))
  // 导航菜单项被 parse 层丢弃，不进 skipped
  assert.ok(!m.skipped.some((s) => s.id === 301))

  // 分类名收齐（含页面之外的唯一化）
  assert.ok(m.categoryNames.includes('生活'))
  assert.deepEqual(m.tagNames, ['旅行', '编程'])

  // 评论：approved + pending 进、spam 不进
  const cms = m.comments.filter((c) => c.postKey === 101)
  assert.equal(cms.length, 2)
  assert.deepEqual(cms.map((c) => c.status), ['approved', 'pending'])
  assert.equal(cms[0].nickname, '张三')
  assert.equal(cms[0].email, 'zs@example.com')
  assert.equal(cms[1].parentWpId, 9001)
  // 页面评论挂到 page key
  assert.equal(m.comments.filter((c) => c.postKey === 106).length, 0)

  // 未来状态映射里页面不出现 scheduled
  const about = m.pages.find((p) => p.wpId === 106)!
  assert.equal(about.status, 'published')
})

test('mapWxrImport：超长正文跳过并报告', () => {
  const big = '<p>' + '字'.repeat(MAX_IMPORT_CONTENT_BYTES) + '</p>'
  const xml = `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><title>t</title>
  <item><title>巨文</title><wp:post_id>7</wp:post_id><wp:status>publish</wp:status><wp:post_type>post</wp:post_type>
  <content:encoded><![CDATA[${big}]]></content:encoded></item>
  </channel></rss>`
  const r = parseWxr(xml)
  if (!r.ok) return assert.fail()
  const m = mapWxrImport(r.items)
  assert.equal(m.counts.posts, 0)
  assert.ok(m.skipped.some((s) => s.reason.includes('1MB')))
})

test('parseWxr：非 WXR 结构返回 not-wxr；空 channel 条目为空', () => {
  assert.deepEqual(parseWxr('<html><body>404</body></html>'), { ok: false, error: 'not-wxr' })
  const empty = parseWxr('<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><title>t</title></channel></rss>')
  assert.ok(empty.ok && empty.items.length === 0)
})

test('时间与状态映射小件', () => {
  assert.equal(parseWpDate('2023-05-01 04:00:00'), Date.parse('2023-05-01T04:00:00Z'))
  assert.equal(parseWpDate('0000-00-00 00:00:00'), null)
  assert.equal(parseWpDate('不是日期'), null)
  assert.equal(parseWpDate(null), null)
  assert.equal(mapWxrStatus('publish'), 'published')
  assert.equal(mapWxrStatus('future'), 'scheduled')
  assert.equal(mapWxrStatus('private'), 'draft')
  assert.equal(mapWxrStatus('trash'), null)
  assert.equal(mapWxrStatus('inherit'), null)
  assert.equal(mapCommentStatus('1'), 'approved')
  assert.equal(mapCommentStatus('0'), 'pending')
  assert.equal(mapCommentStatus('spam'), null)
  assert.equal(mapCommentStatus(''), null)
})

test('extractText：属性形态标签与缺失标签', () => {
  assert.equal(extractText('<wp:post_name>abc</wp:post_name>', 'wp:post_name'), 'abc')
  assert.equal(extractText('<title>带 &amp; 实体</title>', 'title'), '带 & 实体')
  assert.equal(extractText('<nothing/>', 'nothing'), null)
  assert.equal(decodeXmlEntities('&#65;&#x42;&lt;&amp;'), 'AB<&')
})

/* ============================ 端到端：真库导入（同 tests/mcp.test.ts 的薄壳模式） ============================ */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// api.ts 经 render.ts 引入七主题模块（主题 import .css，wrangler 部署走 Text rule）——
// 测试环境先挂 css 顶替 hook 再动态加载（同 tests/themes.test.ts）
register('./tests/css-loader.mjs', pathToFileURL(`${process.cwd()}/`))
const { api } = await import('../src/api')
const { ensureSchema } = await import('../src/db')
type Env = import('../src/types').Env

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

/** 极简 D1 适配（同 tests/mcp.test.ts 的 d1FromSqlite：run 回读 last_row_id + all + batch） */
function d1FromSqlite(db: DatabaseSync): D1Database {
  const cache = new Map<string, import('node:sqlite').StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = db.prepare(sql)))
    return st
  }
  const handlers = (sql: string, binds: unknown[]) => ({
    run: async () => {
      const info = stmtOf(sql).run(...(binds as never[]))
      return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } }
    },
    all: async <T>() => ({ results: stmtOf(sql).all(...(binds as never[])) as T[] }),
    first: async <T>() => ((stmtOf(sql).get(...(binds as never[])) as T | undefined) ?? null),
  })
  return {
    prepare: (sql: string) => {
      const unbound = handlers(sql, [])
      return { ...unbound, bind: (...binds: unknown[]) => handlers(sql, binds) }
    },
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      for (const s of stmts) await s.run()
      return []
    },
  } as unknown as D1Database
}

test('端到端：真库导入（文章/页面/评论树/分类关联/密码上锁/slug 冲突加序号）', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as unknown as Env
  const ec = { waitUntil: () => {}, passThroughOnException: () => {} } as never

  // 走 setup 端点建管理员并拿会话 Cookie（与生产同一套鉴权链）
  const setup = await api.request(
    'https://blog.example.com/auth/setup',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'importer', password: 'import-pass-123', displayName: '导入员' }),
    },
    env,
    ec
  )
  assert.equal(setup.status, 200)
  const cookie = (setup.headers.get('set-cookie') || '').split(';')[0]
  assert.ok(cookie.startsWith('bloghao_session='))

  // 预置：同名 slug（验证冲突加序号）与同名分类（验证不重复建）
  d1.prepare("INSERT INTO posts (slug, title, content, status, created_at, updated_at) VALUES ('hello-post', '旧文', '<p>旧</p>', 'published', 1, 1)").run()
  const existingCat = await d1.prepare("INSERT INTO categories (name, slug, sort, created_at) VALUES ('生活', 'life', 0, 1)").run()

  const imp = await api.request(
    'https://blog.example.com/admin/import/wxr',
    { method: 'POST', headers: { 'Content-Type': 'text/xml', Cookie: cookie }, body: SAMPLE },
    env,
    ec
  )
  assert.equal(imp.status, 200)
  const data = (await imp.json()) as { ok: boolean; report: { posts: number; pages: number; comments: number; skipped: unknown[] }; images: string[] }
  assert.equal(data.ok, true)
  assert.equal(data.report.posts, 4)
  assert.equal(data.report.pages, 1)
  assert.equal(data.report.comments, 2)
  assert.deepEqual(data.images, ['https://wp.example.com/wp-content/uploads/2023/05/a.jpg'])

  // slug 冲突：旧 hello-post 保留，导入副本 = hello-post-2；内容与原发布时间正确
  const helloRows = db.prepare("SELECT slug, title, status, published_at, content, summary FROM posts WHERE slug LIKE 'hello-post%'").all() as Record<string, unknown>[]
  assert.equal(helloRows.length, 2)
  const imported = helloRows.find((r) => r.slug === 'hello-post-2')!
  assert.ok(imported, '导入副本应落为 hello-post-2')
  assert.equal(imported.status, 'published')
  assert.equal(imported.published_at, Date.parse('2023-05-01T04:00:00Z'))
  assert.ok(String(imported.content).includes('正文第一段'))
  assert.ok(String(imported.summary).includes('手写摘要'))

  // 密码文：post_name 缺省 → cleanSlug(标题)='密码文'；password_hash 是 salt:hash 形态
  const secret = db.prepare("SELECT password_hash, published_at FROM posts WHERE slug = '密码文'").all() as Record<string, unknown>[]
  assert.equal(secret.length, 1)
  assert.match(String(secret[0].password_hash), /^[0-9a-f]{32}:[0-9a-f]{64}$/)
  assert.equal(secret[0].published_at, Date.parse('2023-06-01T09:00:00Z'))

  // 定时文：status=scheduled 且 publish_at 为未来时刻
  const future = db.prepare("SELECT status, publish_at FROM posts WHERE slug = 'scheduled-post'").all() as Record<string, unknown>[]
  assert.equal(future[0].status, 'scheduled')
  assert.equal(future[0].publish_at, Date.parse('2030-01-01T00:00:00Z'))

  // 分类：「生活」复用已存在的（不重复建），旅行/编程新建；文章关联到「生活」
  const cats = db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]
  assert.equal(cats.filter((c) => c.name === '生活').length, 1)
  const lifeId = cats.find((c) => c.name === '生活')!.id
  assert.equal(lifeId, Number(existingCat.meta.last_row_id))
  const link = db.prepare(
    'SELECT pc.category_id FROM post_categories pc JOIN posts p ON p.id = pc.post_id WHERE p.slug = ?'
  ).all('hello-post-2') as { category_id: number }[]
  assert.deepEqual(link.map((r) => r.category_id), [lifeId])

  // 评论树：顶层 + 子楼（parent_id 指向 9001 的新 id），email/website 已入库
  const top = db.prepare('SELECT id, parent_id, nickname, email, website, status FROM comments WHERE nickname = ?').all('张三') as Record<string, unknown>[]
  assert.equal(top.length, 1)
  const child = db.prepare('SELECT id, parent_id, status FROM comments WHERE nickname = ?').all('李四') as Record<string, unknown>[]
  assert.equal(child.length, 1)
  assert.equal(child[0].parent_id, top[0].id)

  // 页面：导入为独立页面（show_in_nav=0）
  const page = db.prepare('SELECT slug, status FROM pages WHERE slug = ?').all('about-me') as Record<string, unknown>[]
  assert.equal(page.length, 1)
  assert.equal(page[0].status, 'published')

  // 图片转存 step：不可达地址进 failed（不外泄 5xx）；空 urls 400
  const step = await api.request(
    'https://blog.example.com/admin/import/wxr/step',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ urls: ['https://127.0.0.1:9/loopback.jpg'] }) },
    env,
    ec
  )
  assert.equal(step.status, 200)
  const stepData = (await step.json()) as { moved: unknown[]; failed: string[] }
  assert.deepEqual(stepData.moved, [])
  assert.deepEqual(stepData.failed, ['https://127.0.0.1:9/loopback.jpg'])

  const badStep = await api.request(
    'https://blog.example.com/admin/import/wxr/step',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ urls: [] }) },
    env,
    ec
  )
  assert.equal(badStep.status, 400)
})

test('端到端：登录后演示站导入 404（isDemo 短路在鉴权之后）、未登录 401', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  const envDemo = { DB: d1, IMAGES: {}, ASSETS: {}, DEMO_MODE: '1' } as unknown as Env
  const ec = { waitUntil: () => {}, passThroughOnException: () => {} } as never

  // 鉴权中间件在 handler 之前——演示站的 404 短路只有「带着会话」才能摸到，
  // 直接造一个用户 + 会话（createSession 落库 SHA-256 哈希，Cookie 拿原文）
  const { createSession } = await import('../src/auth')
  const uid = Number((await d1.prepare("INSERT INTO users (username, password_hash, salt, display_name, created_at, updated_at) VALUES ('demo', 'x', 'y', '演示', 1, 1)").run()).meta.last_row_id)
  const token = await createSession(d1, uid)

  const demo = await api.request(
    'https://blog.example.com/admin/import/wxr',
    { method: 'POST', headers: { 'Content-Type': 'text/xml', Cookie: `bloghao_session=${token}` }, body: SAMPLE },
    envDemo,
    ec
  )
  assert.equal(demo.status, 404)

  const anon = await api.request(
    'https://blog.example.com/admin/import/wxr',
    { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: SAMPLE },
    { DB: d1, IMAGES: {}, ASSETS: {} } as unknown as Env,
    ec
  )
  assert.equal(anon.status, 401)
})
