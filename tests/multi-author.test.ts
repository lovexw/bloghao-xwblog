import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// api/pages 引主题（.css）——先挂顶替 hook 再动态加载（同 tests/themes.test.ts）
register('./tests/css-loader.mjs', pathToFileURL(`${process.cwd()}/`))
const { api } = await import('../src/api')
const { ensureSchema, getPostBySlug } = await import('../src/db')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

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
    batch: async (stmts: { run: () => Promise<{ meta: { changes: number } }> }[]) => {
      const out = []
      for (const s of stmts) out.push(await s.run())
      return out
    },
  } as unknown as D1Database
}

test('端到端：建作者 → 作者登录 → 内容面放行 / 管理面 403 / 建作者 403 → 署名进文章页', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  const { ensureSchema } = await import('../src/db')
  await ensureSchema(d1)
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
  const ec = { waitUntil: () => {}, passThroughOnException: () => {} } as never

  const setup = await api.request('https://x.example.com/auth/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'chief', password: 'chief-pass-123', displayName: '站长' }),
  }, env, ec)
  assert.equal(setup.status, 200)
  const adminCookie = (setup.headers.get('set-cookie') || '').split(';')[0]

  // 建作者（admin）→ 出参 role=author
  const mk = await api.request('https://x.example.com/admin/authors', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ username: 'writer01', password: 'writer-pass-123', displayName: '写手一号' }),
  }, env, ec)
  assert.equal(mk.status, 200)
  const mkData = (await mk.json()) as { author: { role: string; id: number } }
  assert.equal(mkData.author.role, 'author')
  const authorId = mkData.author.id

  // 作者登录 → 出参 role=author
  const login = await api.request('https://x.example.com/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'writer01', password: 'writer-pass-123' }),
  }, env, ec)
  assert.equal(login.status, 200)
  const loginData = (await login.json()) as { user: { role: string } }
  assert.equal(loginData.user.role, 'author')
  const authorCookie = (login.headers.get('set-cookie') || '').split(';')[0]

  // 作者：内容面放行、管理面 403、建作者 403
  const okPosts = await api.request('https://x.example.com/admin/posts', { headers: { Cookie: authorCookie } }, env, ec)
  assert.equal(okPosts.status, 200)
  // 编辑器内容辅助（/admin/tools/*：MD 预览 / 粘贴净化 / 链接卡片）随内容面放行——
  // 缺这条作者写文的预览与插卡会静默 403（工具全是内容助手，无站点配置语义）
  const okTools = await api.request('https://x.example.com/admin/tools/md', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: authorCookie },
    body: JSON.stringify({ md: '# 标题' }),
  }, env, ec)
  assert.equal(okTools.status, 200)
  const forbiddenSettings = await api.request('https://x.example.com/admin/settings', { headers: { Cookie: authorCookie } }, env, ec)
  assert.equal(forbiddenSettings.status, 403)
  const forbiddenBackup = await api.request('https://x.example.com/admin/backup', { method: 'POST', headers: { Cookie: authorCookie } }, env, ec)
  assert.equal(forbiddenBackup.status, 403)
  const forbiddenMk = await api.request('https://x.example.com/admin/authors', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: authorCookie },
    body: JSON.stringify({ username: 'writer02', password: 'writer-pass-456' }),
  }, env, ec)
  assert.equal(forbiddenMk.status, 403)
  // admin 不受限
  const adminSettings = await api.request('https://x.example.com/admin/settings', { headers: { Cookie: adminCookie } }, env, ec)
  assert.equal(adminSettings.status, 200)

  // 作者发文（内容面允许）→ 管理员把 author_id 改指作者 → 文章页 meta 出署名
  const mkPost = await api.request('https://x.example.com/admin/posts', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: authorCookie },
    body: JSON.stringify({ title: '作者的第一篇', slug: 'author-post-1', content: '<p>正文</p>', status: 'published' }),
  }, env, ec)
  if (mkPost.status !== 200) console.log('AUTHOR-POST-DEBUG', mkPost.status, await mkPost.clone().text())
  assert.equal(mkPost.status, 200)
  const pid = ((await mkPost.json()) as { post: { id: number } }).post.id
  await d1.prepare('UPDATE posts SET author_id = ? WHERE id = ?').bind(authorId, pid).run()
  const row = await getPostBySlug(d1, 'author-post-1')
  assert.ok(row)
  void row
  // 页面路由挂在 index.ts 的 app（/post/:slug 不在 api 子应用）——全栈 request 验证署名渲染
  const indexApp = (await import('../src/index')).default
  const page = await indexApp.fetch(new Request('https://x.example.com/post/author-post-1'), env, ec as never)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.ok(html.includes('写手一号'), '文章页 meta 应含作者署名')

  // 作者列表（admin）
  const list = await api.request('https://x.example.com/admin/authors', { headers: { Cookie: adminCookie } }, env, ec)
  assert.equal(list.status, 200)
  const listData = (await list.json()) as { authors: { username: string }[] }
  assert.deepEqual(listData.authors.map((a) => a.username), ['writer01'])
})
