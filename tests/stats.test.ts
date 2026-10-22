import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBrowser, classifyDevice, cleanPath, cleanRef, cleanTitle, cleanVid } from '../src/stats.ts'

// ── 设备识别：先判 tablet 再判 mobile（Android 平板 UA 含 Android 但不含 Mobile）──
test('classifyDevice 区分手机/平板/电脑', () => {
  assert.equal(classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'), 'mobile')
  assert.equal(classifyDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'), 'mobile')
  assert.equal(classifyDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'), 'tablet')
  assert.equal(classifyDevice('Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'), 'tablet')
  assert.equal(classifyDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'), 'desktop')
  assert.equal(classifyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), 'desktop')
  assert.equal(classifyDevice(''), 'desktop')
})

// ── 浏览器识别：微信 UA 内嵌整串 Chrome、Edge 也是 Chromium，判定顺序不能换 ──
test('classifyBrowser 微信优先于 Chrome', () => {
  const wechat =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 MicroMessenger/8.0.49'
  assert.equal(classifyBrowser(wechat), 'wechat')
  const wechatIos =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.49'
  assert.equal(classifyBrowser(wechatIos), 'wechat')
})

test('classifyBrowser Edge/Firefox/Chrome/Safari 与兜底', () => {
  assert.equal(classifyBrowser('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120.0'), 'edge')
  assert.equal(classifyBrowser('Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0'), 'firefox')
  assert.equal(classifyBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120 Mobile/15E148 Safari/604.1'), 'chrome')
  assert.equal(classifyBrowser('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36'), 'chrome')
  assert.equal(classifyBrowser('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'), 'safari')
  assert.equal(classifyBrowser('curl/8.4.0'), 'other')
  assert.equal(classifyBrowser(''), 'other')
})

// ── 来源域名：先剥 \t\r\n 再解析（URL 解析器会忽略这些字符，同 sanitize.safeUrl 的规矩）──
test('cleanRef 只留 http(s) 域名，剥控制字符', () => {
  assert.equal(cleanRef('https://www.google.com/search?q=x'), 'www.google.com')
  assert.equal(cleanRef('https://weixin.qq.com/cgi-bin/abc'), 'weixin.qq.com')
  assert.equal(cleanRef('jav\tascript:alert(1)'), '')
  assert.equal(cleanRef('https://evil.example\n.com/'), 'evil.example.com')
  assert.equal(cleanRef('javascript:alert(1)'), '')
  assert.equal(cleanRef('ftp://files.example.com/x'), '')
  assert.equal(cleanRef('/post/hello'), '')
  assert.equal(cleanRef('not a url'), '')
  assert.equal(cleanRef(''), '')
  assert.equal(cleanRef(null), '')
  assert.equal(cleanRef('https://' + 'a'.repeat(120) + '.com/'), 'a'.repeat(100))
})

// ── 上报路径：控制字符剥除、必须 / 开头、截 300 ──
test('cleanPath 清洗非法路径', () => {
  assert.equal(cleanPath('/post/hello?utm=x'), '/post/hello?utm=x')
  assert.equal(cleanPath('/weibo?page=2&topic=日常'), '/weibo?page=2&topic=日常')
  assert.equal(cleanPath('/'), '/') // 裸首页合法：访客打点不许丢首页
  assert.equal(cleanPath('\n/post/x'), '/post/x')
  assert.equal(cleanPath('https://evil.com/x'), '')
  assert.equal(cleanPath('post/x'), '')
  assert.equal(cleanPath(''), '')
  assert.equal(cleanPath(undefined), '')
  assert.equal(cleanPath('/' + 'a'.repeat(400)), '/' + 'a'.repeat(299))
})

// ── 匿名访客 id：只放行 [A-Za-z0-9_-]，截 64 ──
test('cleanVid 限定字符集', () => {
  assert.equal(cleanVid('abc123_-XYZ'), 'abc123_-XYZ')
  assert.equal(cleanVid('abc; drop table x'), 'abcdroptablex')
  assert.equal(cleanVid('a'.repeat(100)), 'a'.repeat(64))
  assert.equal(cleanVid(''), '')
  assert.equal(cleanVid(null), '')
})

test('cleanTitle 剥控制字符并截断', () => {
  assert.equal(cleanTitle('我的文章 - 博客号'), '我的文章 - 博客号')
  assert.equal(cleanTitle('标题\x00<script>'), '标题<script>')
  assert.equal(cleanTitle('好'.repeat(300)), '好'.repeat(200))
  assert.equal(cleanTitle(null), '')
})

// ── 回归（2026-10 安全复查）：协议相对 URL 是跨站链接，访客可借打点把它塞进后台统计页 ──
test('cleanPath 拒绝协议相对 URL（// 开头不进统计）', () => {
  assert.equal(cleanPath('//evil.com/x'), '')
  assert.equal(cleanPath('///evil'), '')
  assert.equal(cleanPath('/正常/path'), '/正常/path')
})

/* ---------------- getVisitStats 聚合（2026-10-23 单次扫描改写）----------------
 * 原实现 8 条并行 GROUP BY 各扫一遍窗口（站长每刷一次统计页 = 窗口行数 × 8 行读）；
 * 改写为按 ≤7 天分片单次扫描 + JS 聚合，以下用例锁定聚合语义与排序口径不漂移。
 * getBotStats 的同款改写由 tests/bots.test.ts 的真库聚合用例兜着。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { getVisitStats } from '../src/stats.ts'
import { fmtDate } from '../src/utils.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

/** 极简 D1 适配（同 tests/bots.test.ts） */
function d1FromSqlite(db: DatabaseSync): D1Database {
  const cache = new Map<string, StatementSync>()
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

test('getVisitStats 聚合：pv/uv、逐日补零、topPages/topRefs、去空分组、今日小时分布', async () => {
  const raw = new DatabaseSync(':memory:')
  raw.exec(SCHEMA_SQL)
  const now = Date.now()
  const dayMs = 86_400_000
  const ins = raw.prepare('INSERT INTO visit_log (ts, day, vid, path, title, ref, dev, br, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  // 今天：3 个访客、2 个页面、1 个来源、设备/浏览器/国家各两组（含应被排除的空串）
  const t1 = now - 3_600_000
  ins.run(t1, fmtDate(t1), 'v1', '/post/a', '文章 A', 'https://ref.example/', 'desktop', 'Chrome', 'CN')
  const t2 = now - 2_000_000
  ins.run(t2, fmtDate(t2), 'v1', '/post/a', '文章 A2（更晚的标题）', '', 'mobile', 'Safari', 'US')
  const t3 = now - 1_000_000
  ins.run(t3, fmtDate(t3), 'v2', '/weibo', '微博页', 'https://ref.example/', 'desktop', 'Chrome', 'CN')
  const t4 = now - 500_000
  ins.run(t4, fmtDate(t4), 'v3', '/weibo', '微博页', '', '', '', '')
  // 昨天：1 访客 1 页；40 天前：30 天窗口外
  const y = now - dayMs
  ins.run(y, fmtDate(y), 'v1', '/post/b', '文章 B', '', 'desktop', 'Chrome', 'JP')
  const old = now - 40 * dayMs
  ins.run(old, fmtDate(old), 'v9', '/post/old', '旧文', '', 'desktop', 'Chrome', 'CN')

  const s = await getVisitStats(d1FromSqlite(raw), 30)
  assert.equal(s.days, 30)
  assert.equal(s.pv, 5) // 窗口外那条不计
  assert.equal(s.uv, 3)
  assert.equal(s.todayPv, 4)
  assert.equal(s.todayUv, 3)
  assert.equal(s.series.length, 30)
  assert.equal(s.series[s.series.length - 1].pv, 4)
  assert.equal(s.series[s.series.length - 1].uv, 3)
  assert.equal(s.series[s.series.length - 2].pv, 1)
  assert.equal(s.series[0].pv, 0) // 30 天前那天无数据，补零

  // topPages：pv 倒序；同 path 的 title 取字典序最大（原 SQL MAX(title)）；uv 按 path 去重
  assert.deepEqual(
    s.topPages.map((p) => [p.path, p.pv, p.uv]),
    [
      ['/post/a', 2, 1],
      ['/weibo', 2, 2],
      ['/post/b', 1, 1],
    ]
  )
  assert.equal(s.topPages[0].title, '文章 A2（更晚的标题）')
  assert.equal(s.topPages[1].title, '微博页')
  // topRefs：空串来源排除，pv 倒序
  assert.deepEqual(
    s.topRefs.map((r) => [r.ref, r.pv, r.uv]),
    [['https://ref.example/', 2, 2]]
  )
  // 设备/浏览器/国家：空串排除，pv 倒序同计数按名字稳定排序
  assert.deepEqual(s.devices, [
    { name: 'desktop', pv: 3 },
    { name: 'mobile', pv: 1 },
  ])
  assert.deepEqual(s.browsers, [
    { name: 'Chrome', pv: 3 },
    { name: 'Safari', pv: 1 },
  ])
  assert.deepEqual(
    s.countries.map((c) => c.name),
    ['CN', 'JP', 'US']
  )
  // 小时分布：只有今天的小时有数，桶位 = 北京时间小时（+8h 取 UTC 分量）
  assert.equal(s.hourly.reduce((n, x) => n + x.pv, 0), 4)
  const beijingHourOf = (ts: number) => new Date(ts + 8 * 3_600_000).getUTCHours()
  const hourOfT1 = s.hourly.find((x) => x.h === beijingHourOf(t1))
  assert.ok(hourOfT1 && hourOfT1.pv >= 1, `t1 的小时桶 ${beijingHourOf(t1)} 应有计数`)
})

test('getVisitStats 单天窗口与空库骨架', async () => {
  const raw = new DatabaseSync(':memory:')
  raw.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(raw)
  const empty = await getVisitStats(d1, 7)
  assert.equal(empty.pv, 0)
  assert.equal(empty.uv, 0)
  assert.equal(empty.todayPv, 0)
  assert.deepEqual(empty.topPages, [])
  assert.deepEqual(empty.topRefs, [])
  assert.equal(empty.series.length, 7)
  assert.ok(empty.series.every((d) => d.pv === 0 && d.uv === 0))
  assert.equal(empty.hourly.length, 24)
  assert.ok(empty.hourly.every((h) => h.pv === 0))

  const now = Date.now()
  raw
    .prepare('INSERT INTO visit_log (ts, day, vid, path, title, ref, dev, br, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now, fmtDate(now), 'v1', '/', '首页', '', 'desktop', 'Chrome', 'CN')
  const one = await getVisitStats(d1, 1)
  assert.equal(one.pv, 1)
  assert.equal(one.series.length, 1)
  assert.equal(one.series[0].pv, 1)
  assert.equal(one.todayPv, 1)
  assert.equal(one.hourly.reduce((n, x) => n + x.pv, 0), 1)
})
