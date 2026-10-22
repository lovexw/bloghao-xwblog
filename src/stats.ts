/**
 * 访客统计：前台 site.js 打点 → POST /api/public/track 落 visit_log 表，
 * 后台「统计」页 GET /api/admin/visits 聚合展示（见 tests/stats.test.ts）。
 *
 * 隐私边界：只存匿名 vid（localStorage 随机 id）、来源域名、国家码（CF-IPCountry），
 * 不存 IP、不存原始 UA；日志保留 180 天，由每晚备份 cron 顺带清理（purgeVisits）。
 * 文章页「阅读量」仍是 posts.views（pages.ts SSR 自增），与本表互不相干。
 */
import { fmtDate } from './utils'

/** 访客日志保留天数 */
export const VISIT_KEEP_DAYS = 180

/** UA → 设备类型。先判 tablet 再判 mobile：Android 平板 UA 同样含 Android 但不含 Mobile */
export function classifyDevice(ua: string): 'mobile' | 'tablet' | 'desktop' {
  const s = ua || ''
  if (/iPad|Tablet|PlayBook|Silk/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) return 'tablet'
  if (/Mobi|iPhone|Android|Windows Phone|Phone/.test(s)) return 'mobile'
  return 'desktop'
}

/** UA → 浏览器族。微信内置浏览器（MicroMessenger）的 UA 里嵌着整串 Chrome 串、
 *  Edge（Edg/）也是 Chromium——判断顺序不能换：微信 → Edge → Firefox → Chrome → Safari */
export function classifyBrowser(ua: string): string {
  const s = ua || ''
  if (/MicroMessenger/i.test(s)) return 'wechat'
  if (/Edg\//.test(s)) return 'edge'
  if (/Firefox|FxiOS/.test(s)) return 'firefox'
  if (/Chrome|CriOS/.test(s)) return 'chrome'
  if (/Safari/.test(s)) return 'safari'
  return 'other'
}

/** 来源页 → 只留域名。先剥 \t\r\n 再 new URL 解析（URL 解析器会忽略这些字符，
 *  原始串判断不可靠）；解析失败 / 非 http(s) 一律空串。 */
export function cleanRef(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[\t\r\n]/g, '')
    .trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.host.slice(0, 100)
  } catch {
    return ''
  }
}

/** 上报路径：剥控制字符、必须以 / 开头且第二字符不是 /（拒协议相对 URL //evil.com，
 *  防伪打点把跨站链接塞进后台统计页的「受欢迎的页面」）、截 300（含 query）。
 *  裸 `/`（首页）合法：第二字符「不是 /」的拒绝对它按「不存在第二字符」放行。 */
export function cleanPath(raw: unknown): string {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '')
  return /^\/(?:$|[^/])/.test(s) ? s.slice(0, 300) : ''
}

/** 匿名访客 id：只放行 [A-Za-z0-9_-]，截 64 */
export function cleanVid(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64)
}

/** 页面标题：剥控制字符，截 200（展示时在后台再过 esc） */
export function cleanTitle(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 200)
}

/** 写入一条访客日志（day 按北京时间落好，聚合不再算时区） */
export async function recordVisit(
  db: D1Database,
  input: { vid: string; path: string; title: string; ref: string; dev: string; br: string; country: string }
): Promise<void> {
  const ts = Date.now()
  await db
    .prepare(
      'INSERT INTO visit_log (ts, day, vid, path, title, ref, dev, br, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(ts, fmtDate(ts), input.vid, input.path, input.title, input.ref, input.dev, input.br, input.country)
    .run()
}

/** 清理过期访客日志（每晚备份 cron 调用） */
export async function purgeVisits(db: D1Database, keepDays = VISIT_KEEP_DAYS): Promise<void> {
  const cutoff = Date.now() - keepDays * 86_400_000
  await db.prepare('DELETE FROM visit_log WHERE ts < ?').bind(cutoff).run()
}

export interface VisitStats {
  days: number
  pv: number
  uv: number
  todayPv: number
  todayUv: number
  series: { day: string; pv: number; uv: number }[]
  topPages: { path: string; title: string; pv: number; uv: number }[]
  topRefs: { ref: string; pv: number; uv: number }[]
  devices: { name: string; pv: number }[]
  browsers: { name: string; pv: number }[]
  countries: { name: string; pv: number }[]
  hourly: { h: number; pv: number }[]
}

/** 后台「统计」页聚合：区间为含今天共 days 天（北京时间），缺数据的天补零。
 *  单次扫描 + JS 聚合（D1 读放大治理，2026-10-23）：原实现 8 条并行语句各自扫一遍窗口内全部行，
 *  visit_log 是量最大的日志表，站长每刷一次统计页 = 窗口行数 × 8 次行读。改为按 ≤7 天分片取回
 *  （响应体与内存有界，总行读 = 窗口行数 × 1）、一次遍历聚合全部分组维度；分组计数流过即弃，
 *  内存只随分组数与 vid 集合增长。 */
export async function getVisitStats(db: D1Database, days: number): Promise<VisitStats> {
  const now = Date.now()
  const today = fmtDate(now)
  const totalVids = new Set<string>()
  const dayAgg = new Map<string, { pv: number; vids: Set<string> }>()
  const pageAgg = new Map<string, { title: string; pv: number; vids: Set<string> }>()
  const refAgg = new Map<string, { pv: number; vids: Set<string> }>()
  const devAgg = new Map<string, number>()
  const brAgg = new Map<string, number>()
  const countryAgg = new Map<string, number>()
  const hourAgg = new Map<number, number>()
  let pv = 0
  const DAY_MS = 86_400_000
  // ≤7 天一片取回（与 startDay 同式的北京日毫秒步进，无 DST 不跨日界）；
  // 小时聚合沿用 strftime 口径：+8h 后取 UTC 分量
  for (let s = now - (days - 1) * DAY_MS; s <= now; s += 7 * DAY_MS) {
    const { results } = await db
      .prepare('SELECT ts, day, vid, path, title, ref, dev, br, country FROM visit_log WHERE day >= ? AND day <= ?')
      .bind(fmtDate(s), fmtDate(Math.min(s + 6 * DAY_MS, now)))
      .all<{ ts: number; day: string; vid: string; path: string; title: string; ref: string; dev: string; br: string; country: string }>()
    for (const r of results ?? []) {
      pv++
      totalVids.add(r.vid)
      const d = dayAgg.get(r.day)
      if (d) {
        d.pv++
        d.vids.add(r.vid)
      } else {
        dayAgg.set(r.day, { pv: 1, vids: new Set([r.vid]) })
      }
      const p = pageAgg.get(r.path)
      if (p) {
        p.pv++
        p.vids.add(r.vid)
        if (r.title > p.title) p.title = r.title // 原 SQL MAX(title) 同义（取代表标题）
      } else {
        pageAgg.set(r.path, { title: r.title, pv: 1, vids: new Set([r.vid]) })
      }
      if (r.ref !== '') {
        const f = refAgg.get(r.ref)
        if (f) {
          f.pv++
          f.vids.add(r.vid)
        } else {
          refAgg.set(r.ref, { pv: 1, vids: new Set([r.vid]) })
        }
      }
      if (r.dev !== '') devAgg.set(r.dev, (devAgg.get(r.dev) || 0) + 1)
      if (r.br !== '') brAgg.set(r.br, (brAgg.get(r.br) || 0) + 1)
      if (r.country !== '') countryAgg.set(r.country, (countryAgg.get(r.country) || 0) + 1)
      if (r.day === today) {
        const h = new Date(r.ts + 8 * 3_600_000).getUTCHours()
        hourAgg.set(h, (hourAgg.get(h) || 0) + 1)
      }
    }
  }

  const series: VisitStats['series'] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = fmtDate(now - i * 86_400_000)
    const r = dayAgg.get(day)
    series.push({ day, pv: r?.pv ?? 0, uv: r?.vids.size ?? 0 })
  }
  // 今天的数据直接取自 series 同源的 dayAgg，不再单发一条查询
  const todayRow = dayAgg.get(today)
  const hourly: VisitStats['hourly'] = []
  for (let h = 0; h < 24; h++) hourly.push({ h, pv: hourAgg.get(h) ?? 0 })

  return {
    days,
    pv,
    uv: totalVids.size,
    todayPv: todayRow?.pv ?? 0,
    todayUv: todayRow?.vids.size ?? 0,
    series,
    topPages: [...pageAgg]
      .map(([path, p]) => ({ path, title: p.title, pv: p.pv, uv: p.vids.size }))
      .sort((a, b) => b.pv - a.pv || a.path.localeCompare(b.path))
      .slice(0, 10),
    topRefs: [...refAgg]
      .map(([ref, f]) => ({ ref, pv: f.pv, uv: f.vids.size }))
      .sort((a, b) => b.pv - a.pv || a.ref.localeCompare(b.ref))
      .slice(0, 10),
    devices: [...devAgg].map(([name, n]) => ({ name, pv: n })).sort((a, b) => b.pv - a.pv || a.name.localeCompare(b.name)),
    browsers: [...brAgg].map(([name, n]) => ({ name, pv: n })).sort((a, b) => b.pv - a.pv || a.name.localeCompare(b.name)).slice(0, 8),
    countries: [...countryAgg]
      .map(([name, n]) => ({ name, pv: n }))
      .sort((a, b) => b.pv - a.pv || a.name.localeCompare(b.name))
      .slice(0, 10),
    hourly,
  }
}
