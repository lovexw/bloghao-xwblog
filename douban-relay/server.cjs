#!/usr/bin/env node
/**
 * 豆瓣中转（douban-relay）——书影音卡片插件的自建数据源代理
 *
 * 跑在自己的服务器上（如 Oracle Cloud 骨干网机器），给博客 Worker 一个「住宅级
 * 网络环境 + 持久 cookie + 低频节奏」的豆瓣访问通道。只做四件事，不解析内容
 * （解析在博客端 src/douban.ts，中转保持笨而稳）：
 *
 *   1. 域名白名单代理：/api/fetch 只代理 *.douban.com，/img 只代理 *.doubanio.com
 *   2. 磁盘缓存：搜索与条目页 6h、封面图 30d——同一本书第二个人搜不再碰豆瓣
 *   3. 节奏与退避：每主机请求间隔 ≥1.6s（+抖动），被风控（sec 挑战 / 403 / 429）
 *      指数冷却 5min → 1h，冷却期内直接回 blocked，不再触碰豆瓣
 *   4. cookie 维持：自动持久化豆瓣下发的 bid 等 Cookie；支持 DOUBAN_COOKIE 注入
 *      登录态（强烈建议，风控最低的一档）
 *
 * 零依赖（Node ≥ 18），单文件。鉴权：/api/* 需要 Bearer DOUBAN_RELAY_TOKEN；
 * /img 不带鉴权（<img> 标签无法携带请求头），靠域名白名单 + 客户端限频 + 缓存兜底。
 *
 * 用法：DOUBAN_RELAY_TOKEN=改我 node server.cjs   （部署见 README.md）
 */
'use strict'

const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const PORT = parseInt(process.env.PORT || '8787', 10)
const BIND = process.env.BIND || '127.0.0.1'
const TOKEN = process.env.DOUBAN_RELAY_TOKEN || ''
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const MIN_INTERVAL_MS = parseInt(process.env.MIN_INTERVAL_MS || '1600', 10)
/** 登录态 Cookie（可选）：从浏览器里复制豆瓣的 Cookie 头整段贴进来，风控最松的一档 */
const USER_COOKIE = (process.env.DOUBAN_COOKIE || '').trim()

const FETCH_TTL_MS = 6 * 3600 * 1000
const IMG_TTL_MS = 30 * 24 * 3600 * 1000
const UPSTREAM_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 3 * 1024 * 1024

if (!TOKEN) {
  console.error('[douban-relay] 缺少 DOUBAN_RELAY_TOKEN，拒绝启动（防止被扫白嫖）')
  process.exit(1)
}

const CACHE_FETCH_DIR = path.join(DATA_DIR, 'fetch')
const CACHE_IMG_DIR = path.join(DATA_DIR, 'img')
const COOKIES_FILE = path.join(DATA_DIR, 'cookies.json')
for (const d of [DATA_DIR, CACHE_FETCH_DIR, CACHE_IMG_DIR]) fs.mkdirSync(d, { recursive: true })

/* ---------------- cookie jar：跨重启维持豆瓣会话（bid 等） ---------------- */

let jar = {}
try {
  jar = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')) || {}
} catch {
  jar = {}
}

function mergeSetCookies(resHeaders) {
  const raw = resHeaders['set-cookie'] || []
  let changed = false
  for (const line of raw) {
    const pair = String(line).split(';')[0]
    const i = pair.indexOf('=')
    if (i < 1) continue
    const k = pair.slice(0, i).trim()
    const v = pair.slice(i + 1).trim()
    if (!k || !/^[A-Za-z0-9_-]+$/.test(k)) continue
    if (jar[k] !== v) {
      jar[k] = v
      changed = true
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(COOKIES_FILE, JSON.stringify(jar))
    } catch {}
  }
}

function cookieHeader() {
  const parts = []
  if (USER_COOKIE) parts.push(USER_COOKIE.replace(/\s*;\s*/g, '; '))
  for (const [k, v] of Object.entries(jar)) {
    // 用户注入的登录态优先：跳过 jar 里同名键
    if (USER_COOKIE && new RegExp(`(?:^|;)\\s*${k}=`).test(USER_COOKIE)) continue
    parts.push(`${k}=${v}`)
  }
  return parts.join('; ')
}

/* ---------------- 节奏与退避（每主机独立） ---------------- */

const hostQueues = new Map() // host → Promise，串行化同主机请求
const lastHit = new Map() // host → ts
const blockStreak = new Map() // host → 连续被风控次数
const cooldownUntil = new Map() // host → ts

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function hostOf(urlStr) {
  try {
    return new URL(urlStr).host
  } catch {
    return ''
  }
}

/** 冷却期内不碰豆瓣：直接回 blocked，等下一次自然探测 */
function inCooldown(host) {
  const until = cooldownUntil.get(host) || 0
  return until > Date.now() ? until : 0
}

function markBlocked(host) {
  const streak = (blockStreak.get(host) || 0) + 1
  blockStreak.set(host, streak)
  // 5min 起步指数退避，封顶 1h
  const ms = Math.min(5 * 60_000 * 2 ** (streak - 1), 3600_000)
  cooldownUntil.set(host, Date.now() + ms)
  console.log(`[cooldown] ${host} 连续被风控 ${streak} 次，冷却 ${Math.round(ms / 60000)} 分钟`)
}

function markOk(host) {
  if (blockStreak.get(host)) blockStreak.set(host, 0)
  cooldownUntil.delete(host)
}

/** 同主机串行 + 最小间隔（+抖动）：慢而稳是整套方案的地基 */
async function acquireSlot(host) {
  const min = MIN_INTERVAL_MS + Math.floor(Math.random() * 400)
  const prev = lastHit.get(host) || 0
  const wait = prev + min - Date.now()
  if (wait > 0) await sleep(wait)
  lastHit.set(host, Date.now())
}

/* ---------------- 上游请求（node:http 手写，redirect 自己跟） ---------------- */

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
}

function rawRequest(urlStr, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(urlStr)
    } catch {
      return reject(new Error('bad url'))
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      u,
      { method: 'GET', headers, timeout: timeoutMs },
      (res) => {
        const chunks = []
        let size = 0
        let done = false
        res.on('data', (c) => {
          size += c.length
          if (size > MAX_BODY_BYTES) {
            if (!done) {
              done = true
              res.destroy()
              resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0), tooLarge: true })
            }
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          if (!done) resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        })
        res.on('error', (e) => {
          if (!done) {
            done = true
            reject(e)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('upstream timeout')))
    req.on('error', reject)
    req.end()
  })
}

const isSecLocation = (loc) => /^https?:\/\/sec\.douban\.com\//.test(String(loc || ''))

/** GET 豆瓣页面：跟普通重定向（≤3 跳），sec 挑战不跟、直接判 blocked */
async function fetchUpstream(urlStr, { img = false } = {}) {
  let current = urlStr
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current)
    const headers = {
      ...BROWSER_HEADERS,
      ...(img ? { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' } : {}),
      Referer: `${u.protocol}//${u.host}/`,
      Cookie: cookieHeader(),
    }
    const res = await rawRequest(current, headers, UPSTREAM_TIMEOUT_MS)
    if (res.tooLarge) return { status: 502, blocked: false, body: Buffer.alloc(0), headers: {} }
    mergeSetCookies(res.headers)
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.location || ''
      if (isSecLocation(loc)) return { status: 403, blocked: true, body: Buffer.alloc(0), headers: {} }
      if (hop === 3 || !loc) return { status: res.status, blocked: false, body: Buffer.alloc(0), headers: {} }
      current = new URL(loc, current).href
      continue
    }
    const bodyText = img ? '' : res.body.toString('utf8')
    // 部分风控直接 200 回挑战页（HTML 里带 sec 跳转脚本），同样识别
    const blocked = res.status === 403 || res.status === 429 || (!img && isSecLocation(bodyText.match(/https?:\/\/sec\.douban\.com\/c\?[^"']*/)?.[0]))
    return { status: res.status, blocked, body: res.body, headers: res.headers, finalUrl: current }
  }
  return { status: 508, blocked: false, body: Buffer.alloc(0), headers: {} }
}

/* ---------------- 磁盘缓存 ---------------- */

const cacheKey = (urlStr) => crypto.createHash('sha256').update(urlStr).digest('hex').slice(0, 32)

function cacheRead(dir, key, ttlMs) {
  try {
    const file = path.join(dir, key)
    const stat = fs.statSync(file)
    if (Date.now() - stat.mtimeMs > ttlMs) return null
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

function cacheWrite(dir, key, buf) {
  try {
    fs.writeFileSync(path.join(dir, key), buf)
  } catch {}
}

/** 启动与每小时清一次过期缓存文件（TTL 判定靠 mtime，读时跳过 + 这里兜底删除） */
function sweep() {
  const now = Date.now()
  for (const [dir, ttl] of [
    [CACHE_FETCH_DIR, FETCH_TTL_MS],
    [CACHE_IMG_DIR, IMG_TTL_MS],
  ]) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const stat = fs.statSync(path.join(dir, name))
        if (now - stat.mtimeMs > ttl) fs.unlinkSync(path.join(dir, name))
      } catch {}
    }
  }
}
sweep()
setInterval(sweep, 3600_000).unref()

/* ---------------- 客户端限频（/img 无鉴权，靠这个防白嫖流量） ---------------- */

const ipHits = new Map() // ip → { windowStart, count }
const IMG_RATE = 120 // 次 / 分钟 / IP

function imgRateOk(ip) {
  const now = Date.now()
  const rec = ipHits.get(ip)
  if (!rec || now - rec.windowStart > 60_000) {
    ipHits.set(ip, { windowStart: now, count: 1 })
    return true
  }
  rec.count++
  if (ipHits.size > 10_000) {
    for (const [k, v] of ipHits) if (now - v.windowStart > 60_000) ipHits.delete(k)
  }
  return rec.count <= IMG_RATE
}

/* ---------------- 鉴权（常数时间比较，防时序侧信道） ---------------- */

function authOk(req) {
  const h = String(req.headers.authorization || '')
  const m = /^Bearer\s+(.+)$/i.exec(h)
  if (!m) return false
  const a = crypto.createHash('sha256').update(m[1]).digest()
  const b = crypto.createHash('sha256').update(TOKEN).digest()
  return crypto.timingSafeEqual(a, b)
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || ''
  let u
  try {
    u = new URL(req.url, 'http://internal')
  } catch {
    return json(res, 400, { error: 'bad request' })
  }
  const pathname = u.pathname

  try {
    /* 健康检查（鉴权后开放：不向扫描器暴露部署细节） */
    if (pathname === '/api/health') {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' })
      const cooling = [...cooldownUntil.values()].filter((t) => t > Date.now())
      return json(res, 200, {
        ok: true,
        uptime: Math.round(process.uptime()),
        cacheFetch: entryCount(CACHE_FETCH_DIR),
        cacheImg: entryCount(CACHE_IMG_DIR),
        cooldownUntil: cooling.length ? Math.max(...cooling) : 0,
      })
    }

    /* 页面 / 接口代理（*.douban.com） */
    if (pathname === '/api/fetch') {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' })
      const target = u.searchParams.get('u') || ''
      const host = hostOf(target)
      if (!/^https:\/\//.test(target)) return json(res, 400, { error: '只代理 https' })
      if (host !== 'douban.com' && !host.endsWith('.douban.com')) return json(res, 403, { error: '域名不在白名单' })

      const key = cacheKey(target)
      const hit = cacheRead(CACHE_FETCH_DIR, key, FETCH_TTL_MS)
      if (hit) {
        const data = JSON.parse(hit.toString('utf8'))
        return json(res, 200, { ...data, cached: true })
      }

      const cooling = inCooldown(host)
      if (cooling) return json(res, 200, { blocked: true, cooldownUntil: cooling })

      // 同主机串行（单飞：并发同 URL 共享同一次上游请求）
      const prev = hostQueues.get(host) || Promise.resolve()
      const task = prev.catch(() => {}).then(async () => {
        await acquireSlot(host)
        const r = await fetchUpstream(target)
        if (r.blocked) {
          markBlocked(host)
          return { blocked: true }
        }
        if (r.status !== 200) return { status: r.status, body: '' }
        markOk(host)
        return { status: 200, body: r.body.toString('utf8'), finalUrl: r.finalUrl }
      })
      hostQueues.set(host, task)
      const out = await task
      if (out.blocked) return json(res, 200, { blocked: true })
      if (out.status !== 200) return json(res, 200, { status: out.status, body: '' })
      const payload = { status: out.status, body: out.body, finalUrl: out.finalUrl }
      cacheWrite(CACHE_FETCH_DIR, key, Buffer.from(JSON.stringify(payload)))
      return json(res, 200, payload)
    }

    /* 封面图代理（*.doubanio.com，无鉴权但限频 + 缓存） */
    if (pathname === '/img') {
      if (!imgRateOk(ip)) return json(res, 429, { error: 'too many requests' })
      const target = u.searchParams.get('u') || ''
      const host = hostOf(target)
      if (!/^https:\/\//.test(target)) return json(res, 400, { error: '只代理 https' })
      if (host !== 'doubanio.com' && !host.endsWith('.doubanio.com')) return json(res, 403, { error: '域名不在白名单' })

      const key = cacheKey(target)
      const hit = cacheRead(CACHE_IMG_DIR, key, IMG_TTL_MS)
      if (hit) {
        const meta = JSON.parse(fs.readFileSync(path.join(CACHE_IMG_DIR, key + '.meta'), 'utf8'))
        res.writeHead(200, { 'Content-Type': meta.ct, 'Cache-Control': 'public, max-age=604800', 'X-Cache': 'hit' })
        return res.end(hit)
      }

      const r = await fetchUpstream(target, { img: true })
      if (r.status !== 200 || !r.body.length) return json(res, 502, { error: 'upstream ' + r.status })
      const ct = String(r.headers['content-type'] || 'image/jpeg').split(';')[0]
      if (!/^image\/(jpeg|png|webp|gif)$/.test(ct)) return json(res, 502, { error: '非图片响应' })
      cacheWrite(CACHE_IMG_DIR, key, r.body)
      fs.writeFileSync(path.join(CACHE_IMG_DIR, key + '.meta'), JSON.stringify({ ct, ts: Date.now() }))
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=604800', 'X-Cache': 'miss' })
      return res.end(r.body)
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    console.error('[error]', pathname, e.message)
    json(res, 500, { error: 'internal' })
  }
})

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length })
  res.end(buf)
}

function entryCount(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.endsWith('.meta')).length
  } catch {
    return 0
  }
}

server.listen(PORT, BIND, () => {
  console.log(`[douban-relay] listening on ${BIND}:${PORT}，缓存目录 ${DATA_DIR}`)
  console.log(`[douban-relay] 登录态 Cookie：${USER_COOKIE ? '已注入' : '未注入（建议配置 DOUBAN_COOKIE 降低风控）'}`)
})
