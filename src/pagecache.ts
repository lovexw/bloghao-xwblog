import type { MiddlewareHandler } from 'hono'
import { MEMBER_SESSION_COOKIE, SESSION_COOKIE } from './auth'
import { getSettings, PAGE_CACHE_EPOCH_KEY, saveSettings } from './db'
import { PP_COOKIE } from './protect'
import type { Env, SessionUser } from './types'
import { isDemo } from './utils'

/* ---------------- 页面边缘缓存（公开面 · 匿名访客 5 分钟副本） ----------------
 * 单文件自洽模块（同 protect.ts / closed.ts 三件套口径），Node 测试可直接导入。
 *
 * 是什么：Cache API（caches.default，colo 级共享）给公开面存一份短 TTL 副本，
 * 匿名访客命中直接吐响应，跳过 SSR/API 与 D1 回源——对跨境访客（TTFB 大头在回源链路）
 * 与爬虫流量（D1 行读取的大头）收益最大。浏览器侧仍拿 SSR 的 no-cache（每次回源验证、
 * 回源命中边缘层），不存在「浏览器持有旧页面」。
 *
 * 覆盖面（P0-2 扩面，D1 读放大优化）：
 * - 页面白名单 CACHEABLE_PAGE_RE：无 query 语义的公开 HTML 页
 * - 数据白名单 CACHEABLE_DATA_RE：RSS/JSON Feed/sitemap（爬虫订阅器高频）与
 *   /api/public/weibo、/api/public/posts（广场 hub pull 与外部的分页 API）
 * - 带 query 的请求走受控白名单 normalizeCacheQuery：page/limit/wb/topic/q/sort/tag
 *   逐参数镜像服务端 clamp/trim/slice 语义后进键——/weibo?page=2、/weibo?wb=x（TG 通知
 *   与朋友圈同步的深链，正是爬虫放大器）、/tag/x?page=2、/search?q=… 都可缓存且键空间有界
 *
 * 永不进缓存的面（pageCacheKeyFor 单点判定）：
 * - 管理员 / 会员 / 文章解锁任一 Cookie 在场（登录视角永远实时——站长发完文自查不受缓存干扰）
 * - 白名单之外的一切路由、未知 query 参数（评论成功后 site.js reloadFresh 的 _r 参数就靠
 *   这条立刻看到新评论）、sort=random（seed 现生成，同 URL 两次结果不同）
 * - 演示站（每 2 小时重灌，不值得缓存）、灰度模式（整站去色是特殊状态，回源渲染）
 * - 闭站中间件注册在本中间件之前，503 短路在缓存之前
 *
 * 失效：settings 键 pageCacheEpoch 进缓存键。saveSettings 每次保存自动换新（db.ts 单点，
 * 改设置 = 全站页面即刻作废）；后台「概览 → 系统」一键清理 = purgePageCache 显式写一次。
 * 内容发布/删除【不】自动清理——发布入口太散（后台/开放 API/TG/MCP/定时发布），故意只靠
 * 5 分钟 TTL + 手动按钮；访客最多滞后 5 分钟，新文章直链本身是 miss 即时可见。
 *
 * Node 测试与 docker-poc 无 caches.default：整层自动退化为直查直渲染，无需 shim。
 * 访客统计不受影响：visit_log 走 /api/public/track POST（永不缓存），bot_log 中间件注册
 * 在缓存之前照常记录；posts.views 阅读数只在回源渲染时 +1，边缘命中不计数——属预期取舍。
 */

export const PAGE_CACHE_TTL_S = 300

/** 可缓存的公开页面路由白名单：新增公开页要过一遍「这个页对匿名访客是否千人一面」 */
const CACHEABLE_PAGE_RE =
  /^(\/|\/tag\/[^/]+|\/category\/[^/]+|\/post\/[^/]+|\/page\/[^/]+|\/about|\/archives|\/guestbook|\/weibo|\/links|\/member|\/rank|\/search)$/

/**
 * 可缓存的订阅源与公开只读 API（P0-2 扩面）：URL 规整、匿名千人一面。
 * RSS 别名清单与 index.ts 的 RSS_ALIASES 镜像（订阅器盲猜路径同样高频，一并吃缓存）。
 */
const CACHEABLE_DATA_RE =
  /^(\/rss\.xml|\/rss|\/rss\/|\/feed|\/feed\/|\/feed\.xml|\/feed\/rss\.xml|\/feed\/rss|\/atom|\/atom\/|\/atom\.xml|\/index\.xml|\/feeds\/posts\/default|\/feed\.json|\/sitemap\.xml|\/api\/public\/weibo|\/api\/public\/posts)$/

/** 列表排序白名单（render.ts HOME_SORTS 的 key）：random 每次现生成 seed，绝不缓存 */
const CACHEABLE_SORTS = ['latest', 'views', 'likes', 'comments']

const encTrimmed = (v: string) => (v ? encodeURIComponent(v) : '')

/**
 * 单参数规范化（纯函数）：返回 null = 整个请求回源；'' = 服务端按「没传」处理
 * （clamp 回退默认 / 非法忽略），从键里省略；其余 = 进键的规范值。
 * 每个参数的语义必须与消费它的服务端代码逐字镜像，两侧改动要同跑 tests/pagecache.test.ts。
 */
function normalizeCacheParam(key: string, raw: string): string | null {
  switch (key) {
    case 'page': {
      // clampInt(v, 1, 1000, 1) 镜像：NaN 回退默认 1 = 没传；0/负数夹回 1 与「没传」同义但保留键
      const n = parseInt(raw, 10)
      return Number.isNaN(n) ? '' : String(Math.min(1000, Math.max(1, n)))
    }
    case 'limit': {
      // 公开 API 的 clampInt(v, 1, 50, …) 镜像
      const n = parseInt(raw, 10)
      return Number.isNaN(n) ? '' : String(Math.min(50, Math.max(1, n)))
    }
    case 'wb':
      // renderWeibo 深链定位：非 /^\d{1,12}$/ 按没传处理（同款正则镜像）
      return /^\d{1,12}$/.test(raw) ? raw : ''
    case 'topic':
      return encTrimmed(raw.trim().slice(0, 24)) // renderWeibo：trim + slice(0, 24) 镜像
    case 'q':
      return encTrimmed(raw.trim().slice(0, 60)) // renderList：trim + slice(0, 60) 镜像
    case 'sort':
      if (raw === 'random') return null // 随机排序的 seed 是现生成的，同 URL 两次结果不同
      return CACHEABLE_SORTS.includes(raw) ? raw : '' // 未知值服务端回落 latest = 没传
    case 'tag': {
      const v = raw.trim() // 服务端不截断 tag，超长值进键会撑爆键空间——直接回源
      if (!v) return ''
      return v.length <= 64 ? encodeURIComponent(v) : null
    }
    default:
      return null // 未知参数一律回源（宁可少数页面吃不到缓存，不可把错页发给访客）
  }
}

/**
 * query 键规范化（纯函数，tests 直接导入）：只有白名单参数可进缓存键。
 * 返回 null = 不可缓存；返回串 = 参数名排序后的规范 query（空串与「无 query」同键）。
 */
export function normalizeCacheQuery(sp: URLSearchParams): string | null {
  const out: string[] = []
  for (const key of [...new Set(sp.keys())].sort()) {
    const vals = sp.getAll(key)
    if (vals.length > 1) return null // 重复参数服务端取第一个，语义含糊不缓存
    const v = normalizeCacheParam(key, vals[0] ?? '')
    if (v === null) return null
    if (v !== '') out.push(`${key}=${v}`)
  }
  return out.join('&')
}

/** 一键清理：换 pageCacheEpoch，旧边缘副本整代作废（TTL 到期前不会再被命中）。
 *  与 saveSettings 的自动换代取 max(now, 旧值+1)：同一毫秒内连续两次也保证严格递增 */
export async function purgePageCache(db: D1Database): Promise<void> {
  const s = await getSettings(db)
  const old = Number(s[PAGE_CACHE_EPOCH_KEY] || 0)
  await saveSettings(db, { [PAGE_CACHE_EPOCH_KEY]: String(Math.max(Date.now(), old + 1)) })
}

function sharedCache(): Cache | null {
  const c = (globalThis as { caches?: { default?: Cache } }).caches
  return c?.default ?? null
}

/** 缓存键判定（纯函数，tests 直接导入）：可缓存返回键 URL，否则 null */
export function pageCacheKeyFor(input: {
  method: string
  url: string
  cookie: string
  demo: boolean
  grayscale: boolean
  epoch: string
}): string | null {
  if (input.method !== 'GET') return null
  if (input.demo || input.grayscale) return null
  let u: URL
  try {
    u = new URL(input.url)
  } catch {
    return null
  }
  if (!CACHEABLE_PAGE_RE.test(u.pathname) && !CACHEABLE_DATA_RE.test(u.pathname)) return null
  const cookie = input.cookie
  if (
    cookie.includes(SESSION_COOKIE) ||
    cookie.includes(MEMBER_SESSION_COOKIE) ||
    cookie.includes(PP_COOKIE)
  ) {
    return null
  }
  const q = normalizeCacheQuery(u.searchParams)
  if (q === null) return null
  // 键带 hostname：workers.dev 预览域名与绑定域名共享同一 colo 缓存，不带 host 会把
  // A 域名渲染的绝对地址副本发给 B 域名（/api/public/weibo 出参与 RSS 内含请求 origin）
  return `https://xwblog-internal.invalid/__page/${input.epoch}/${u.host}${u.pathname}${q ? '?' + q : ''}`
}

/** 可回填判据：200 + 无 Set-Cookie + 内容类型是页面/订阅源/JSON API（重定向 / 404 / 报错页不缓存） */
const STORABLE_TYPE_RE = /text\/html|application\/json|application\/rss\+xml|application\/xml|text\/xml/

function isStorable(res: Response): boolean {
  if (res.status !== 200) return false
  if (res.headers.has('set-cookie')) return false
  return STORABLE_TYPE_RE.test(res.headers.get('content-type') || '')
}

type AppEnv = { Bindings: Env; Variables: { user: SessionUser | null } }

/** 页面缓存中间件：注册位必须在所有页面路由与 /api、/mcp 子应用之前（终点 handler 不调
 *  next），且在闭站 / 爬虫统计之后（503 与 bot_log 优先） */
export function pageCacheMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cache = sharedCache()
    if (!cache) return next()
    const settings = await getSettings(c.env.DB)
    const key = pageCacheKeyFor({
      method: c.req.method,
      url: c.req.url,
      cookie: c.req.header('cookie') || '',
      demo: isDemo(c.env),
      grayscale: settings.siteGrayscale === '1',
      epoch: settings[PAGE_CACHE_EPOCH_KEY] || '0',
    })
    if (!key) return next()

    let hit: Response | undefined
    try {
      hit = (await cache.match(key)) ?? undefined
    } catch {
      /* 缓存层异常按 miss 走 */
    }
    if (hit) {
      const headers = new Headers(hit.headers)
      headers.set('X-Page-Cache', 'hit')
      return new Response(hit.body, { status: hit.status, headers })
    }

    await next()
    const res = c.res
    if (!isStorable(res)) return
    try {
      // 存边缘层的副本显式带 max-age（覆盖 SSR 的 no-cache）；浏览器拿到的原响应保持 no-cache
      const stored = res.clone()
      stored.headers.set('Cache-Control', `public, max-age=${PAGE_CACHE_TTL_S}`)
      c.executionCtx.waitUntil(cache.put(key, stored).catch(() => {}))
      res.headers.set('X-Page-Cache', 'miss')
    } catch {
      /* 回填失败不影响本次响应 */
    }
  }
}
