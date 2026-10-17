import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendOldSlug } from '../src/utils'
import { findPublishedByOldSlug } from '../src/db'
import { ensureSchema } from '../src/db'
import type { Env } from '../src/types'

/* ── 纯函数：appendOldSlug ── */

test('appendOldSlug：追加旧值、去重、排除当前 slug、脏 JSON 容错', () => {
  assert.equal(appendOldSlug(null, 'old-a', 'new'), '["old-a"]')
  assert.equal(appendOldSlug('[]', 'old-a', 'new'), '["old-a"]')
  assert.equal(appendOldSlug('["old-a"]', 'old-b', 'new'), '["old-a","old-b"]')
  // 重复追加同名旧值不重复
  assert.equal(appendOldSlug('["old-a"]', 'old-a', 'new'), '["old-a"]')
  // A→B→A 往返改名：当前 slug A 不入列，中间值 B 留在历史
  assert.equal(appendOldSlug('["A"]', 'B', 'A'), '["B"]')
  // previous 恰好也是历史值（A→B→A→C 再改到 C）：历史里 B 保留且不重复
  assert.equal(appendOldSlug('["A","B"]', 'B', 'C'), '["A","B"]')
  // 脏 JSON / undefined 当空数组
  assert.equal(appendOldSlug('not-json', 'old', 'new'), '["old"]')
  assert.equal(appendOldSlug(undefined, 'old', 'new'), '["old"]')
  // 空旧 slug 不入列
  assert.equal(appendOldSlug('[]', '', 'new'), '[]')
})

test('appendOldSlug：上限 20 个保留最近的（频繁改名不无限增长）', () => {
  let cur: string | null = null
  for (let i = 0; i < 30; i++) {
    cur = appendOldSlug(cur, `s-${i}`, `s-${i + 1}`)
  }
  const list = JSON.parse(cur!) as string[]
  assert.equal(list.length, 20)
  assert.equal(list[0], 's-10') // 最早的 10 个被挤掉
  assert.equal(list[list.length - 1], 's-29')
})

/* ── 真库：findPublishedByOldSlug（读侧 301 判定口径） ── */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

async function seedDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = {
    prepare: (sql: string) => {
      const st = db.prepare(sql)
      return {
        bind: (...b: unknown[]) => ({
          run: async () => { const i = st.run(...(b as never)); return { success: true, meta: { last_row_id: Number(i.lastInsertRowid), changes: Number(i.changes) } } },
          all: async () => ({ results: st.all(...(b as never)) }),
          first: async <T>() => (st.get(...(b as never)) as T | undefined) ?? null,
        }),
        run: async () => { const i = st.run(); return { success: true, meta: { last_row_id: Number(i.lastInsertRowid), changes: Number(i.changes) } } },
        all: async () => ({ results: st.all() }),
        first: async <T>() => (st.get() as T | undefined) ?? null,
      }
    },
    batch: async (stmts: { run: () => Promise<unknown> }[]) => { for (const s of stmts) await s.run(); return [] },
  } as never
  await ensureSchema(d1)
  return { db, d1 }
}

test('findPublishedByOldSlug：命中已发布、跳过草稿 / 回收站 / 窗口外、多命中取最新', async () => {
  const { db, d1 } = await seedDb()
  const NOW = 1_800_000_000_000
  const ins = async (slug: string, status: string, publishedAt: number | null, oldSlugs: string, deletedAt: number | null = null) => {
    await d1.prepare(
      'INSERT INTO posts (slug, title, content, status, old_slugs, published_at, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(slug, slug, '<p>x</p>', status, oldSlugs, publishedAt, publishedAt ?? 1, publishedAt ?? 1, deletedAt).run()
  }
  await ins('new-slug', 'published', NOW, '["old-slug"]')
  await ins('draft-one', 'draft', null, '["old-slug"]')
  await ins('trashed', 'published', NOW, '["old-slug"]', NOW - 1)
  await ins('old-window', 'published', NOW - 400 * 86400_000, '["old-slug"]')
  // 两条都命中时取 published_at 最新的
  await ins('newer', 'published', NOW + 1, '["old-slug"]')

  const hit = await findPublishedByOldSlug(d1, 'old-slug', 0)
  assert.ok(hit)
  assert.equal(hit!.slug, 'newer')

  // 站点可见窗口：cutoff 排除窗口外的旧文（newer/new-slug 在窗口内仍命中）
  const hit2 = await findPublishedByOldSlug(d1, 'old-slug', NOW - 30 * 86400_000)
  assert.ok(hit2)
  assert.equal(hit2!.slug, 'newer')

  // 拉到极早窗口：全部出窗 → 不命中（宁 404 不泄露窗口外内容）
  const miss = await findPublishedByOldSlug(d1, 'old-slug', NOW + 10 * 86400_000)
  assert.equal(miss, null)

  // 没有旧 slug 记录的查询
  assert.equal(await findPublishedByOldSlug(d1, 'never-existed', 0), null)
  void db
})
