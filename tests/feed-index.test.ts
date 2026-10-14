import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_INDEXES } from '../src/db.ts'

// ── 列表时间线表达式排序索引（P0-1，D1 读放大优化）──
// 防线核心：listPosts / listWeibo 的 ORDER BY 用 COALESCE(published_at, created_at)，
// 索引表达式必须与排序片段一字不差（含 DESC 方向），否则 SQLite 结构匹配失败，
// 翻一页也全表扫描 + 临时 B-tree 排序（D1 按「行读取」计费，免费额度 500 万/天）。
// 本文件用 node:sqlite 执行真实 schema.sql 建库造数，逐条 EXPLAIN QUERY PLAN 验证。
// 已知局限（实测登记）：后台 status=all（无 status 等值）的列表规划器仍走全表 + 临时排序——
// SQLite 成本模型对无等值约束的全索引扫描偏保守（ANALYZE 后同样），仅后台低频路径，不在 P0-1 验收范围。

const ROOT = join(import.meta.dirname, '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

/** 三条索引的规范 DDL：schema.sql 与 db.ts SCHEMA_INDEXES 双份登记必须一致（同一 schema 两份表达的老规矩） */
const FEED_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_weibo_feed ON weibo (status, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_weibo_feed_pinned ON weibo (status, pinned DESC, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts (status, pinned DESC, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL',
]

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

test('feed 索引：schema.sql 与 SCHEMA_INDEXES 双份登记一致', () => {
  const sql = norm(SCHEMA_SQL)
  for (const ddl of FEED_INDEXES) {
    assert.ok(sql.includes(norm(ddl)), `schema.sql 缺：${ddl}`)
    assert.ok(SCHEMA_INDEXES.includes(ddl), `SCHEMA_INDEXES 缺：${ddl}`)
  }
})

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const base = 1700000000000
  const wb = db.prepare(
    'INSERT INTO weibo (content, status, pinned, likes, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (let i = 0; i < 930; i++) {
    const t = base + i * 60000
    // 每 5 条一条 published_at 为空：逼 COALESCE 分支参与排序（脏数据在同一条 SQL 里混）
    wb.run(`微博内容 ${i}`, i % 20 === 0 ? 'draft' : 'published', i % 100 === 0 ? 1 : 0, i % 7, i % 5 === 0 ? null : t, t, t)
  }
  const post = db.prepare(
    'INSERT INTO posts (slug, title, content, tags, status, pinned, views, likes, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (let i = 0; i < 215; i++) {
    const t = base + i * 3600000
    post.run(`post-${i}`, `文章 ${i}`, `正文 ${i}`, '["生活","Cloudflare"]', 'published', i % 50 === 0 ? 1 : 0, i, i % 9, i % 7 === 0 ? null : t, t, t)
  }
  return db
}

function planOf(db: DatabaseSync, sql: string): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((r) => String((r as { detail: unknown }).detail))
    .join(' | ')
}

/** 走没走索引 + 无临时排序（计划里出现 TEMP B-TREE FOR ORDER BY 就是没走） */
function assertUsesIndex(plan: string, index: string): void {
  assert.ok(plan.includes(`USING INDEX ${index}`), `未走 ${index}：${plan}`)
  assert.ok(!plan.includes('TEMP B-TREE'), `出现临时排序：${plan}`)
  assert.ok(!/SCAN (weibo|posts)(?! USING INDEX)/.test(plan), `全表扫描：${plan}`)
}

test('EXPLAIN：weibo recency 排序（公开 API / 首页入口卡）走 idx_weibo_feed', () => {
  const db = seedDb()
  const plan = planOf(
    db,
    "SELECT * FROM weibo WHERE deleted_at IS NULL AND status = 'published' ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT 20 OFFSET 0"
  )
  assertUsesIndex(plan, 'idx_weibo_feed')
})

test('EXPLAIN：weibo pinnedFirst 排序（/weibo 时间线）走 idx_weibo_feed_pinned', () => {
  const db = seedDb()
  const plan = planOf(
    db,
    "SELECT * FROM weibo WHERE deleted_at IS NULL AND status = 'published' ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC, id DESC LIMIT 20 OFFSET 0"
  )
  assertUsesIndex(plan, 'idx_weibo_feed_pinned')
})

test('EXPLAIN：posts 默认列表走 idx_posts_feed', () => {
  const db = seedDb()
  const plan = planOf(
    db,
    "SELECT * FROM posts WHERE deleted_at IS NULL AND status = 'published' ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC LIMIT 10 OFFSET 0"
  )
  assertUsesIndex(plan, 'idx_posts_feed')
})

test('EXPLAIN：posts 标签筛选（前导通配 LIKE）仍走 idx_posts_feed、无临时排序', () => {
  const db = seedDb()
  const plan = planOf(
    db,
    "SELECT * FROM posts WHERE deleted_at IS NULL AND status = 'published' AND tags LIKE ? ESCAPE '\\' ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC LIMIT 10 OFFSET 0"
  )
  assertUsesIndex(plan, 'idx_posts_feed')
})
