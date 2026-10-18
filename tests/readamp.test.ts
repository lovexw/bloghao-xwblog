import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { D1Database } from '@cloudflare/workers-types'
import {
  bumpWeiboCount,
  bumpWeiboCountById,
  ensureSchema,
  listOnThisDay,
  listWeibo,
  recountWeiboCount,
  refreshOnThisDay,
} from '../src/db.ts'
import { cstDate, fmtDate } from '../src/utils.ts'

// ── D1 读放大治理（2026-10-18，2026-10-14/17 两次打爆免费档 500 万行读/天后的防线）──
// 三件套：① 微博分页总数记账位（wbPubCount）——COUNT 对 status 前缀索引也要扫全部已发布
// 条目，1900 条微博时一条查询一天烧 224 万行读；② 历史上的今天进 settings 快照——strftime
// 匹配月-日吃不到任何索引，纯全表扫；③ ensureSchema 的 FTS docsize 复核按 6h 节流——
// 每次 isolate 冷启动一发，2290 次冷启动/天 50 万行读。防线核心：**热路径 0 全表扫**，
// 快照只由写路径与每晚 cron 维护，脏快照宁可重算不可报错。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

/** node:sqlite → D1 形状适配（与 tests/list-range.test.ts 同款），另把每条 prepare 的 SQL 记进 sqls 供断言。
 *  batch 用 all() 取回各语句结果（listOnThisDay 的 db.batch 解构两侧 SELECT 结果），非 SELECT 语句退回 run。 */
function seedDb(): { d1: D1Database; raw: DatabaseSync; sqls: string[] } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(SCHEMA_SQL)
  const sqls: string[] = []
  const cache = new Map<string, StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = raw.prepare(sql)))
    return st
  }
  const handlers = (sql: string, binds: unknown[]) => ({
    run: async () => {
      stmtOf(sql).run(...(binds as never[]))
      return { success: true }
    },
    all: async <T>() => ({ results: stmtOf(sql).all(...(binds as never[])) as T[] }),
    first: async <T>() => ((stmtOf(sql).get(...(binds as never[])) as T | undefined) ?? null),
  })
  const d1 = {
    prepare: (sql: string) => {
      sqls.push(sql)
      const unbound = handlers(sql, [])
      return { ...unbound, bind: (...binds: unknown[]) => handlers(sql, binds) }
    },
    batch: async (stmts: { all?: () => Promise<unknown>; run: () => Promise<unknown> }[]) => {
      const out: unknown[] = []
      for (const s of stmts) {
        if (s.all) {
          try {
            out.push(await s.all())
            continue
          } catch {
            /* SELECT 之外 all() 不可用 → 退回 run */
          }
        }
        await s.run()
        out.push({ results: [] })
      }
      return out
    },
  } as unknown as D1Database
  return { d1, raw, sqls }
}

/** 5 已发布 + 2 草稿 + 1 已发布但软删：wbPubCount 的正确值是 5 */
function seedWeibo(raw: DatabaseSync): { publishedId: number; draftId: number; deletedId: number } {
  const ins = raw.prepare('INSERT INTO weibo (content, topics, status, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  const now = Date.now()
  let publishedId = 0
  let draftId = 0
  let deletedId = 0
  for (let i = 0; i < 5; i++) {
    const r = ins.run(`微博 ${i}`, '["日常"]', 'published', now - i * 1000, now - i * 1000, now - i * 1000)
    if (i === 0) publishedId = Number(r.lastInsertRowid)
  }
  for (let i = 0; i < 2; i++) {
    const r = ins.run(`草稿 ${i}`, '["日常"]', 'draft', null, now, now)
    if (i === 0) draftId = Number(r.lastInsertRowid)
  }
  const r = ins.run('已删微博', '["日常"]', 'published', now, now, now)
  deletedId = Number(r.lastInsertRowid)
  raw.prepare('UPDATE weibo SET deleted_at = ? WHERE id = ?').run(now, deletedId)
  return { publishedId, draftId, deletedId }
}

const settingOf = (raw: DatabaseSync, key: string): string | undefined =>
  (raw.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value

test('recountWeiboCount：全量校准只数已发布未删除行', async () => {
  const { d1, raw } = seedDb()
  seedWeibo(raw)
  await recountWeiboCount(d1)
  assert.equal(settingOf(raw, 'wbPubCount'), '5')
})

test('bumpWeiboCount：键缺失是 no-op（留给热路径播种），在场则 ±1，delta 0 不扰', async () => {
  const { d1, raw } = seedDb()
  seedWeibo(raw)
  await bumpWeiboCount(d1, 1)
  assert.equal(settingOf(raw, 'wbPubCount'), undefined, '键缺失时不得凭空造行')
  await recountWeiboCount(d1)
  await bumpWeiboCount(d1, -1)
  assert.equal(settingOf(raw, 'wbPubCount'), '4')
  await bumpWeiboCount(d1, 0)
  assert.equal(settingOf(raw, 'wbPubCount'), '4')
})

test('bumpWeiboCountById：按执行时刻的行状态条件增减，草稿/已删/不存在都 no-op', async () => {
  const { d1, raw } = seedDb()
  const { publishedId, draftId, deletedId } = seedWeibo(raw)
  await recountWeiboCount(d1)
  // 已发布存活行 -1 生效
  await bumpWeiboCountById(d1, -1, publishedId)
  assert.equal(settingOf(raw, 'wbPubCount'), '4')
  // 草稿 / 已软删 / 不存在的 id 都不该动账
  for (const id of [draftId, deletedId, 99999]) {
    await bumpWeiboCountById(d1, 1, id)
    assert.equal(settingOf(raw, 'wbPubCount'), '4', `id=${id} 不得改账`)
  }
})

test('listWeibo 快路径：公开口径读快照 0 全表 COUNT，键缺失当场播种', async () => {
  const { d1, raw, sqls } = seedDb()
  seedWeibo(raw)
  // 键缺失：真 COUNT + 回填播种
  const r1 = await listWeibo(d1, { status: 'published' })
  assert.equal(r1.total, 5)
  assert.equal(settingOf(raw, 'wbPubCount'), '5')
  // 键在场：不再发 COUNT，读快照（把账拨到 99 验证真的走的快照）
  sqls.length = 0
  raw.prepare("UPDATE settings SET value = '99' WHERE key = 'wbPubCount'").run()
  const r2 = await listWeibo(d1, { status: 'published', page: 2, limit: 2 })
  assert.equal(r2.total, 99)
  assert.equal(sqls.some((s) => s.includes('COUNT(*) AS n FROM weibo')), false, '快路径不得发全表 COUNT')
  // 带过滤的口径照旧真 COUNT（话题 / 可见窗口 / 后台状态），不受记账位污染
  raw.prepare("UPDATE settings SET value = '99' WHERE key = 'wbPubCount'").run()
  sqls.length = 0
  const r3 = await listWeibo(d1, { status: 'published', topic: '日常' })
  assert.equal(r3.total, 5)
  assert.equal(sqls.some((s) => s.includes('COUNT(*) AS n FROM weibo')), true, '话题筛选必须真 COUNT')
  const r4 = await listWeibo(d1, { status: 'published', afterTs: Date.now() - 1000 })
  assert.ok(r4.total < 99, '可见窗口口径不走快照')
  const r5 = await listWeibo(d1, { status: 'all' })
  assert.equal(r5.total, 7, '后台「全部」口径不走快照（含草稿）')
})

test('listOnThisDay 快照：首渲计算回填，当天复用 0 查询，翻天/脏快照重算', async () => {
  const { d1, raw, sqls } = seedDb()
  // 往年今日：北京口径取今天月-日，去年一篇文章 + 前年一条微博；今年的不算
  const bj = cstDate(Date.now())
  const y = bj.getUTCFullYear()
  const m = bj.getUTCMonth()
  const d = bj.getUTCDate()
  const bjNoon = (year: number) => Date.UTC(year, m, d, 4, 0, 0) // 北京当天 12:00 = UTC 04:00
  raw
    .prepare("INSERT INTO posts (slug, title, content, status, published_at, created_at, updated_at) VALUES (?, ?, '<p>x</p>', 'published', ?, ?, ?)")
    .run('old-post', '去年的今天', bjNoon(y - 1), bjNoon(y - 1), bjNoon(y - 1))
  raw.prepare('INSERT INTO weibo (content, status, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('前年的今天', 'published', bjNoon(y - 2), bjNoon(y - 2), bjNoon(y - 2))
  raw.prepare('INSERT INTO weibo (content, status, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('今年的今天不算', 'published', bjNoon(y), bjNoon(y), bjNoon(y))

  const items = await listOnThisDay(d1)
  assert.deepEqual(
    items.map((i) => [i.kind, i.text]),
    [
      ['post', '去年的今天'],
      ['weibo', '前年的今天'],
    ]
  )
  const snap = JSON.parse(settingOf(raw, 'onThisDay') ?? '{}') as { day: string; items: unknown[] }
  assert.equal(snap.day, fmtDate(Date.now()), '快照带北京日期守卫')
  assert.equal(snap.items.length, 2)

  // 当天再读：不发 strftime 全表扫（读快照）
  sqls.length = 0
  assert.equal((await listOnThisDay(d1)).length, 2)
  assert.equal(sqls.some((s) => s.includes('strftime')), false, '当天复用不得全表扫')

  // 翻天（day 不匹配）→ 重算并回填
  raw.prepare("UPDATE settings SET value = ? WHERE key = 'onThisDay'").run(JSON.stringify({ day: '2000-01-01', items: [] }))
  sqls.length = 0
  assert.equal((await listOnThisDay(d1)).length, 2)
  assert.equal(sqls.some((s) => s.includes('strftime')), true, '翻天必须重算')

  // 脏快照（非 JSON）→ 当没配重算，不报错
  raw.prepare("UPDATE settings SET value = 'not-json' WHERE key = 'onThisDay'").run()
  assert.equal((await listOnThisDay(d1)).length, 2)
})

test('refreshOnThisDay：显式重算总是执行（cron / 导入收尾用）', async () => {
  const { d1, raw } = seedDb()
  await refreshOnThisDay(d1)
  const snap = JSON.parse(settingOf(raw, 'onThisDay') ?? '{}') as { day: string }
  assert.equal(snap.day, fmtDate(Date.now()))
})

test('ensureSchema：FTS docsize 复核按 ftsCheckedAt 节流，6h 内不重复', async () => {
  const { d1, raw, sqls } = seedDb()
  // 先放一篇正文，保证 rebuild 后索引非空（复核能通过并记账）
  raw
    .prepare("INSERT INTO posts (slug, title, content, status, published_at, created_at, updated_at) VALUES (?, ?, ?, 'published', ?, ?, ?)")
    .run('p1', '有正文', '<p>FTS 复核素材</p>', Date.now(), Date.now(), Date.now())
  await ensureSchema(d1) // 首次：ftsSeeded 缺失 → rebuild，不经过 docsize 复核
  await ensureSchema(d1) // 第二次：ftsSeeded 在场、ftsCheckedAt 缺失 → 复核一次并记账
  await ensureSchema(d1) // 第三次：6h 内 → 跳过
  const docsizeQueries = sqls.filter((s) => s.includes('FROM posts_fts_docsize')).length
  assert.equal(docsizeQueries, 1, '三次冷启动只复核一次')
  assert.ok(Number(settingOf(raw, 'ftsCheckedAt')) > 0, '复核通过要记账')
  // 记账过期（拨回 7h 前）→ 下次冷启动恢复复核
  raw.prepare("UPDATE settings SET value = ? WHERE key = 'ftsCheckedAt'").run(String(Date.now() - 7 * 3600_000))
  sqls.length = 0
  await ensureSchema(d1)
  assert.equal(sqls.filter((s) => s.includes('FROM posts_fts_docsize')).length, 1, '过期后恢复复核')
})
