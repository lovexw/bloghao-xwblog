import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awardPoints, awardCommentPoints, cstDayStart, POINTS_RULES } from '../src/points.ts'
import { listMembersAdmin, listRankTop, updateMemberAdmin } from '../src/db.ts'

// ── 会员体系（契约见 docs/DEVPLAN-2026-10-07.md 附录 A）：积分引擎 / 会员查询 SQL 形状 ──

// ── 积分规则常量表：2026-10-07 拍板数值（评论 +2、每日登录 +1），数值只许改 points.ts 一处 ──

test('POINTS_RULES：拍板数值与关键字段', () => {
  assert.equal(POINTS_RULES.comment.delta, 2)
  assert.equal(POINTS_RULES.dailyLogin.delta, 1)
  assert.equal(POINTS_RULES.dailyLogin.dailyCap, 1, '每日登录当天只计一次')
  assert.equal(POINTS_RULES.adminAdjust.dailyCap, 0, '管理员调整不受日上限约束')
})

test('cstDayStart：北京时间当日 0 点（UTC 分量 + 去掉 +8 偏移）', () => {
  // 2026-10-07 02:00 UTC = 北京时间 10:00 → 当日 0 点 = 2026-10-06 16:00 UTC
  const ts = Date.UTC(2026, 9, 7, 2, 30, 0)
  assert.equal(cstDayStart(ts), Date.UTC(2026, 9, 7) - 8 * 3600_000)
  // 北京时间 0:30（UTC 前一天 16:30）归当日（北京 10-08）0 点
  const early = Date.UTC(2026, 9, 7, 16, 30, 0)
  assert.equal(cstDayStart(early), Date.UTC(2026, 9, 8) - 8 * 3600_000)
})

// ── awardPoints：日上限 / 幂等 / adminAdjust 旁路 / 非法 reason 拒绝 ──

function fakePointsDb(initial = 0) {
  const log: { member_id: number; delta: number; reason: string; ref_id: number }[] = []
  let balance = initial
  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      const stmt = {
        bind: (...a: unknown[]) => {
          args = a
          return stmt
        },
        run: async () => {
          if (sql.includes('INSERT INTO member_points_log')) {
            log.push({
              member_id: args[0] as number,
              delta: args[1] as number,
              reason: args[2] as string,
              ref_id: args[3] as number,
            })
          } else if (sql.includes('UPDATE members SET points')) {
            balance += args[0] as number
          }
          return { success: true, meta: { changes: 1 } }
        },
        first: async <T>(): Promise<T | null> => {
          if (sql.includes('SUM(delta)')) {
            const s = log
              .filter((l) => l.member_id === args[0] && l.reason === args[1])
              .reduce((x, l) => x + l.delta, 0)
            return { s } as T
          }
          if (sql.includes('SELECT 1 AS x FROM member_points_log')) {
            const hit = log.some((l) => l.reason === 'comment' && l.member_id === args[0] && l.ref_id === args[1])
            return (hit ? { x: 1 } : null) as T
          }
          if (sql.includes('SELECT points FROM members')) return { points: balance } as T
          return null
        },
        all: async () => ({ results: [] }),
      }
      return stmt
    },
    batch: async (stmts: { run(): Promise<unknown> }[]) => {
      for (const s of stmts) await s.run()
      return []
    },
  }
  return { db: db as unknown as D1Database, log, balance: () => balance }
}

test('awardPoints：评论 +2 落账本并加余额，refId 入账', async () => {
  const { db, log, balance } = fakePointsDb()
  const r = await awardPoints(db, 7, 'comment', { refId: 42 })
  assert.ok(r.ok)
  assert.equal(r.delta, 2)
  assert.equal(r.balance, 2)
  assert.equal(balance(), 2)
  assert.deepEqual(log, [{ member_id: 7, delta: 2, reason: 'comment', ref_id: 42 }])
})

test('awardPoints：每日登录当天只计一次（cap=1 幂等）', async () => {
  const { db, log, balance } = fakePointsDb()
  const first = await awardPoints(db, 1, 'dailyLogin')
  assert.ok(first.ok)
  const second = await awardPoints(db, 1, 'dailyLogin')
  assert.equal(second.ok, false)
  assert.equal(second.delta, 0)
  assert.equal(log.length, 1)
  assert.equal(balance(), 1)
})

test('awardPoints：评论单日上限 10 条（第 11 条起拦下），账本不落', async () => {
  const { db, log } = fakePointsDb()
  for (let i = 1; i <= 10; i++) {
    const r = await awardPoints(db, 3, 'comment', { refId: i })
    assert.ok(r.ok, `第 ${i} 条应计分`)
  }
  const overflow = await awardPoints(db, 3, 'comment', { refId: 11 })
  assert.equal(overflow.ok, false)
  assert.equal(log.length, 10)
})

test('awardPoints：adminAdjust 用给定 delta（可负）且不受日上限约束', async () => {
  const { db, log, balance } = fakePointsDb(100)
  const r = await awardPoints(db, 5, 'adminAdjust', { delta: -30, note: '作弊扣回' })
  assert.ok(r.ok)
  assert.equal(r.delta, -30)
  assert.equal(balance(), 70)
  const bump = await awardPoints(db, 5, 'adminAdjust', { delta: 500 })
  assert.ok(bump.ok, '管理员调整不受日上限')
  assert.equal(log.length, 2)
})

test('awardPoints：非法 reason（含原型链属性）拒绝且不落账', async () => {
  const { db, log } = fakePointsDb()
  for (const reason of ['toString', 'constructor', 'hasOwnProperty', 'commentX', '']) {
    const r = await awardPoints(db, 1, reason)
    assert.equal(r.ok, false, reason)
  }
  assert.equal(log.length, 0)
})

test('awardCommentPoints：同一评论 ref_id 去重，反复通过不重复记', async () => {
  const { db, log } = fakePointsDb()
  await awardCommentPoints(db, 9, 1001)
  await awardCommentPoints(db, 9, 1001) // 后台「通过↔待审」再通过
  await awardCommentPoints(db, 9, 1002)
  assert.equal(log.length, 2)
  assert.deepEqual(
    log.map((l) => l.ref_id).sort(),
    [1001, 1002]
  )
})

// ── db.ts 会员查询：SQL 形状守卫（防泄漏/防注入面回退） ──

function fakeCaptureDb(firstResult: Record<string, unknown> = { n: 0 }) {
  const sqls: string[] = []
  const allBinds: unknown[][] = []
  const db = {
    prepare(sql: string) {
      sqls.push(sql)
      let args: unknown[] = []
      const stmt = {
        bind: (...a: unknown[]) => {
          args = a
          allBinds.push(a)
          return stmt
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
        first: async <T>(): Promise<T | null> => firstResult as T,
        all: async <T>(): Promise<{ results: T[] }> => ({ results: [] as T[] }),
      }
      return stmt
    },
    batch: async () => [],
  }
  return { db: db as unknown as D1Database, sqls, allBinds }
}

test('listRankTop：只含 active 且积分 > 0，积分倒序', async () => {
  const { db, sqls } = fakeCaptureDb()
  await listRankTop(db, 10)
  assert.match(sqls[0], /status = 'active'/, '排行榜不得泄漏封禁会员')
  assert.match(sqls[0], /points > 0/)
  assert.match(sqls[0], /ORDER BY points DESC, id ASC/)
  assert.match(sqls[0], /LIMIT \?/)
})

test('listMembersAdmin：搜索走 LIKE + ESCAPE 转义，分页 clamp 在合法页码', async () => {
  const { db, sqls, allBinds } = fakeCaptureDb({ n: 55 })
  await listMembersAdmin(db, 'a_b%c', 99)
  assert.match(sqls[0], /username LIKE \? ESCAPE '\\' OR email LIKE \? ESCAPE '\\'/, '搜索必须 ESCAPE（likePattern 同口径）')
  assert.equal(allBinds[0][0], '%a\\_b\\%c%')
  // 55 条 → 3 页，page=99 clamp 到 3：OFFSET = 40
  assert.match(sqls[1], /LIMIT 20 OFFSET \?/)
  assert.equal(allBinds[1][allBinds[1].length - 1], 40)
  const empty = fakeCaptureDb({ n: 0 })
  await listMembersAdmin(empty.db, '', 0)
  assert.ok(!empty.sqls[0].includes('LIKE'), '无关键词时不带 LIKE 条件')
})

test('updateMemberAdmin：缺键即保留（只更新传入列），命中行看 changes', async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ status: 'banned' }, /SET status = \?, updated_at = \? WHERE id = \?/],
    [{ tier: 'coffee', status: 'active' }, /SET tier = \?, status = \?, updated_at = \? WHERE id = \?/],
  ]
  for (const [patch, re] of cases) {
    const { db, sqls } = fakeCaptureDb()
    const ok = await updateMemberAdmin(db, 1, patch)
    assert.ok(ok)
    assert.match(sqls[0], re)
  }
  const empty = fakeCaptureDb()
  assert.ok(await updateMemberAdmin(empty.db, 1, {}), '空 patch 视为无操作成功')
  assert.equal(empty.sqls.length, 0, '空 patch 不得发 UPDATE')
})
