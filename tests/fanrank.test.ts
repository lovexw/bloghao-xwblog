import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { FAN_TIERS, fanDay, fanLevel, fanLevelName, nextStreak } from '../src/fanrank'
import { POINTS_RULES } from '../src/points'

/* ── 等级判定纯函数 ── */

test('fanLevel：五档判定（L1 或门槛、L2 起且门槛、边界值）', () => {
  assert.equal(fanLevel(0, 0).level, 0)
  assert.equal(fanLevel(0, 0).name, '路人')
  // L1 是「或」：单积分或单活跃都行
  assert.equal(fanLevel(10, 0).level, 1)
  assert.equal(fanLevel(0, 3).level, 1)
  assert.equal(fanLevel(9, 2).level, 0)
  // L2 起是「且」：只富不勤不行
  assert.equal(fanLevel(50, 6).level, 1)
  assert.equal(fanLevel(50, 7).level, 2)
  assert.equal(fanLevel(200, 20).level, 2)
  assert.equal(fanLevel(200, 21).level, 3)
  assert.equal(fanLevel(500, 60).level, 4)
  assert.equal(fanLevel(9999, 999).name, '至交')
  // next 差距
  const l0 = fanLevel(0, 0)
  assert.deepEqual(l0.next, { name: '读者', points: 10, days: 3 })
  assert.equal(fanLevel(9999, 999).next, null)
})

test('fanLevel：负数/脏值兜底为 0 档（不抛错）', () => {
  assert.equal(fanLevel(-5, -1).level, 0)
  assert.equal(fanLevelName(NaN, undefined), '路人')
})

test('nextStreak：昨签延续 / 断签归 1 / 今日已签维持 / 脏值兜底', () => {
  assert.equal(nextStreak('2026-10-17', '2026-10-18', '2026-10-17', 5), 6)
  assert.equal(nextStreak('2026-10-15', '2026-10-18', '2026-10-17', 9), 1)
  assert.equal(nextStreak('2026-10-18', '2026-10-18', '2026-10-17', 5), 5)
  assert.equal(nextStreak('', '2026-10-18', '2026-10-17', 0), 1)
})

test('fanDay：北京墙上日期口径（UTC 16 点起算次日，签到/活跃/展示共用这一份）', () => {
  // 2026-10-18 15:59 UTC = 北京 23:59 → 还是 18 日；再过 1 小时跨到 19 日
  assert.equal(fanDay(Date.UTC(2026, 9, 18, 15, 59)), '2026-10-18')
  assert.equal(fanDay(Date.UTC(2026, 9, 18, 16, 0)), '2026-10-19')
  // 北京 0 点 = UTC 前一日 16 点，0-8 点发布的内容不落前一天（时间口径防线同源）
  assert.equal(fanDay(Date.UTC(2026, 0, 1, 0, 0)), '2026-01-01')
})

test('POINTS_RULES：checkin / streakBonus 已登记且日上限 1（幂等靠 ref_id 日序号）', () => {
  assert.equal(POINTS_RULES.checkin.delta, 2)
  assert.equal(POINTS_RULES.checkin.dailyCap, 1)
  assert.equal(POINTS_RULES.streakBonus.delta, 1)
  assert.equal(POINTS_RULES.streakBonus.dailyCap, 1)
  // 等级表与名号一一对应
  assert.equal(FAN_TIERS.length, 4)
  assert.deepEqual(FAN_TIERS.map((t) => t.name), ['读者', '常客', '铁粉', '至交'])
})

/* ── 端到端：真库签到链路（薄壳模式，同 tests/mcp.test.ts） ── */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

// api.ts 经 render.ts 引主题（.css）——先挂顶替 hook 再动态加载（同 tests/themes.test.ts）
register('./tests/css-loader.mjs', pathToFileURL(`${process.cwd()}/`))

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

test('端到端：注册即活跃 1 天 → 签到 +2 且 streak=1 → 重复签到 400 → /me 带 fan 字段', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  const { ensureSchema } = await import('../src/db')
  await ensureSchema(d1)
  // 会员功能默认关——开它（settings 裸写后 getSettings 直查退化，Node 无 caches.default）
  const { saveSettings } = await import('../src/db')
  await saveSettings(d1, { membersEnabled: '1' })
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as never
  const ec = { waitUntil: () => {}, passThroughOnException: () => {} } as never
  const { api } = await import('../src/api')

  const reg = await api.request('https://x.example.com/member/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'fan01', password: 'fan-pass-123' }),
  }, env, ec)
  assert.equal(reg.status, 200)
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0]

  // 注册（=首次登录）已累计活跃 1 天 + dailyLogin 1 分
  const me1 = (await (await api.request('https://x.example.com/member/me', { headers: { Cookie: cookie } }, env, ec)).json()) as { member: { points: number; activeDays: number; fanName: string; checkedToday: boolean } }
  assert.equal(me1.member.points, 1)
  assert.equal(me1.member.activeDays, 1)
  // 注册单日：points 1、days 1 都不达 L1 → 路人
  assert.equal(me1.member.fanName, '路人')

  // 签到：+2 → streak 1
  const ck = await api.request('https://x.example.com/member/checkin', { method: 'POST', headers: { Cookie: cookie } }, env, ec)
  assert.equal(ck.status, 200)
  const ckData = (await ck.json()) as { delta: number; bonus: number; streak: number; points: number }
  assert.equal(ckData.delta, 2)
  assert.equal(ckData.bonus, 0) // 首日 streak=1 < 7
  assert.equal(ckData.streak, 1)
  assert.equal(ckData.points, 3) // dailyLogin 1 + checkin 2

  // 重复签到 400
  const ck2 = await api.request('https://x.example.com/member/checkin', { method: 'POST', headers: { Cookie: cookie } }, env, ec)
  assert.equal(ck2.status, 400)

  // /me 带签到态与等级
  const me2 = (await (await api.request('https://x.example.com/member/me', { headers: { Cookie: cookie } }, env, ec)).json()) as { member: { fanName: string; checkedToday: boolean; checkinStreak: number } }
  assert.equal(me2.member.checkedToday, true)
  assert.equal(me2.member.checkinStreak, 1)
  assert.equal(me2.member.fanName, '路人') // points 3、days 1 均未达 L1（10 分或 3 天）
})
