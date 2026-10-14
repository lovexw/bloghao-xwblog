import type { MiddlewareHandler } from 'hono'
import { MEMBER_SESSION_COOKIE, SESSION_COOKIE } from './auth'
import { getSettings, PAGE_CACHE_EPOCH_KEY, saveSettings } from './db'
import { PP_COOKIE } from './protect'
import type { Env, SessionUser } from './types'
import { isDemo } from './utils'

/* ---------------- 页面边缘缓存（公开页 · 匿名访客 5 分钟副本） ----------------
 * 单文件自洽模块（同 protect.ts / closed.ts 三件套口径），Node 测试可直接导入。
 *
 * 是什么：Cache API（caches.default，colo 级共享）给公开 HTML 页存一份短 TTL 副本，
 * 匿名访客命中直接吐 HTML，跳过 SSR 与 D1 回源——对跨境访客（TTFB 大头在回源链路）收益最大。
 * 浏览器侧仍拿 SSR 的 no-cache（每次回源验证、回源命中边缘层），不存在「浏览器持有旧页面」。
 *
 * 永不进缓存的面（pageCacheKeyFor 单点判定）：
 * - 管理员 / 会员 / 文章解锁任一 Cookie 在场（登录视角永远实时——站长发完文自查不受缓存干扰）
 * - 带 query 的请求（评论成功后 site.js reloadFresh 的 _r 参数就靠这条立刻看到新评论）
 * - /search（每人一个查询词）与白名单 CACHEABLE_PAGE_RE 之外的一切路由
 * - 演示站（每 2 小时重灌，不值得缓存）、灰度模式（整站去色是特殊状态，回源渲染）
 * - 闭站中间件注册在本中间件之前，503 短路在缓存之前
 *
 * 失效：settings 键 pageCacheEpoch 进缓存键。saveSettings 每次保存自动换新（db.ts 单点，
 * 改设置 = 全站页面即刻作废）；后台「概览 → 系统」一键清理 = purgePageCache 显式写一次。
 * 内容发布/删除【不】自动清理——发布入口太散（后台/开放 API/TG/MCP/定时发布），故意只靠
 * 5 分钟 TTL + 手动按钮；访客最多滞后 5 分钟，新文章直链本身是 miss 即时可见。
 *
 * Node 测试与 docker-poc 无 caches.default：整层自动退化为直查直渲染，无需 shim。
 * 访客统计（visit_log / bot_log 的中间件注册在缓存之前）照常记录；posts.views 阅读数
 * 只在回源渲染时 +1，边缘命中不计数——属预期取舍。
 */

export const PAGE_CACHE_TTL_S = 300

/** 可缓存的公开页面路由白名单：新增公开页要过一遍「这个页对匿名访客是否千人一面」 */
const CACHEABLE_PAGE_RE =
  /^(\/|\/tag\/[^/]+|\/category\/[^/]+|\/post\/[^/]+|\/page\/[^/]+|\/about|\/archives|\/guestbook|\/weibo|\/links|\/member|\/rank)$/

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
  if (u.search) return null
  if (!CACHEABLE_PAGE_RE.test(u.pathname)) return null
  const cookie = input.cookie
  if (
    cookie.includes(SESSION_COOKIE) ||
    cookie.includes(MEMBER_SESSION_COOKIE) ||
    cookie.includes(PP_COOKIE)
  ) {
    return null
  }
  return `https://xwblog-internal.invalid/__page/${input.epoch}${u.pathname}`
}

/** 可回填判据：只有 200 且无 Set-Cookie 的 HTML 才进边缘层（重定向 / 404 / 报错页不缓存） */
function isStorable(res: Response): boolean {
  if (res.status !== 200) return false
  if (res.headers.has('set-cookie')) return false
  return (res.headers.get('content-type') || '').includes('text/html')
}

type AppEnv = { Bindings: Env; Variables: { user: SessionUser | null } }

/** 页面缓存中间件：注册位必须在所有页面路由之前（终点 handler 不调 next），且在闭站/统计之后 */
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
