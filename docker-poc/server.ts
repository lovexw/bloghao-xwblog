/**
 * xwblog 自托管 POC —— 单进程多租户入口（docker-poc/ 独立目录，不影响仓库主代码）。
 *
 * 职责：
 *  1. Node http ↔ fetch(Request/Response) 适配（waitUntil 注入、Set-Cookie 多值、
 *     会话 cookie 的 Secure 按有无 TLS 反代自动摘除）
 *  2. Host → 租户路由：每个域名一套独立的 node:sqlite 库 + 磁盘图床目录，互不可见
 *  3. 静态资源直出 public/（对齐 wrangler assets「文件优先、其余进 Worker」的行为）
 *  4. cron：每分钟扫定时发布；北京时间 00:30（UTC 16:30）触发备份/清理/回收站滚动
 *
 * 业务代码零改动：直接 import src/index.ts 的默认导出（fetch + scheduled）。
 * 运行方式见同目录 README.md / package.json。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import xwblog from '../src/index'
import { ensureSchema } from '../src/db'
import { createD1 } from './shims/d1'
import { createR2Disk } from './shims/r2disk'
// D1 的建表靠部署时 `wrangler d1 execute schema.sql`，ensureSchema 只管增量补列——
// 租户库是全新文件，这里要自己先跑一遍 schema.sql（官方幂等设计，可重复执行），
// 与演示站 src/demo.ts 的 ensureTables 同款思路
import SCHEMA_SQL from '../schema.sql'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
// 默认值按「打包产物在 docker-poc/dist/server.js」的层级推导：dist/../.. = 仓库根、
// dist/.. = docker-poc/；Docker 里保持同样层级，仅 TENANTS_DIR 用环境变量指到挂载卷
const PUBLIC_ROOT = path.resolve(process.env.PUBLIC_ROOT || path.resolve(__dirname, '../../public'))
const TENANTS_DIR = path.resolve(process.env.TENANTS_DIR || path.resolve(__dirname, '../data/tenants'))
const TENANTS_CONFIG = path.resolve(process.env.TENANTS_CONFIG || path.resolve(__dirname, '../tenants.json'))

interface Tenant {
  host: string
  env: Record<string, unknown>
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/

/** 按配置逐个初始化租户：域名 → 自己的 blog.db（WAL）+ uploads/ 图床目录 */
async function loadTenants(): Promise<Map<string, Tenant>> {
  const raw = JSON.parse(fs.readFileSync(TENANTS_CONFIG, 'utf8')) as Record<string, { demo?: boolean }>
  const map = new Map<string, Tenant>()
  for (const [host, cfg] of Object.entries(raw)) {
    if (!HOST_RE.test(host)) throw new Error(`tenants.json 里的域名不合法: ${host}`)
    const dir = path.join(TENANTS_DIR, host)
    fs.mkdirSync(dir, { recursive: true })
    const env: Record<string, unknown> = {
      DB: createD1(path.join(dir, 'blog.db')),
      IMAGES: createR2Disk(path.join(dir, 'uploads')),
      // 业务代码从不调用 ASSETS（静态资源在适配层直出），兜底防误用
      ASSETS: { fetch: async () => new Response('ASSETS binding is handled by the self-host adapter', { status: 404 }) },
    }
    if (cfg?.demo) env.DEMO_MODE = '1'
    const db = env.DB as { exec: (sql: string) => Promise<unknown> }
    await db.exec(SCHEMA_SQL)
    await ensureSchema(env.DB as never)
    map.set(host, { host, env })
    console.log(`[tenant] ${host} 就绪（${cfg?.demo ? '演示种子' : '空库'}）→ ${dir}`)
  }
  return map
}

/** Workers ExecutionContext 的等价物：waitUntil 的异步任务失败只记日志，不炸请求 */
const execCtx = {
  waitUntil(p: Promise<unknown>) {
    Promise.resolve(p).catch((e) => console.error('[waitUntil]', e))
  },
  passThroughOnException() {},
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

/** 静态资源直出（对齐 wrangler assets：精确文件命中才返回，其余进应用） */
function serveStatic(pathname: string, search: string): Response | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const file = path.resolve(PUBLIC_ROOT, `.${decoded}`)
  if (file !== PUBLIC_ROOT && !file.startsWith(PUBLIC_ROOT + path.sep)) return null
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  // 目录路径不带斜杠：301 补斜杠（对齐 wrangler assets 的 auto-trailing-slash）。
  // 否则 index.html 在 /admin 下被直出，页面里的相对路径资源 ./admin.css 会解析成
  // /admin.css → 404 → 后台整页空白（甲骨文服务器实测抓出）
  if (!decoded.endsWith('/') && st.isDirectory()) {
    return new Response(null, { status: 301, headers: { Location: `${decoded}/${search}` } })
  }
  const candidates = [file, path.join(file, 'index.html')]
  for (const f of candidates) {
    let fst: fs.Stats
    try {
      fst = fs.statSync(f)
    } catch {
      continue
    }
    if (!fst.isFile()) continue
    return new Response(fs.readFileSync(f), {
      headers: {
        'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=120',
      },
    })
  }
  return null
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
  'content-length',
  'te',
  'trailer',
])

function sendToNode(req: http.IncomingMessage, res: http.ServerResponse, appRes: Response) {
  const headers: Record<string, string | string[]> = {}
  appRes.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value
  })
  // 会话 cookie 带 Secure：明文 http（本地冒烟 / 未挂 TLS）浏览器和 curl 都不会携带。
  // 生产由 Caddy/nginx 终结 TLS（X-Forwarded-Proto: https），原样保留
  const isHttps = req.headers['x-forwarded-proto'] === 'https'
  const cookies = appRes.headers.getSetCookie()
  if (cookies.length) {
    headers['set-cookie'] = cookies.map((sc) =>
      isHttps ? sc : sc.split('; ').filter((p) => p !== 'Secure').join('; ')
    )
  }
  res.writeHead(appRes.status, headers)
  if (req.method === 'HEAD' || !appRes.body) {
    res.end()
    return
  }
  Readable.fromWeb(appRes.body as never).pipe(res)
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, tenants: Map<string, Tenant>) {
  const started = Date.now()
  const hostHeader = req.headers.host || 'localhost'
  const host = hostHeader.split(':')[0].toLowerCase()
  const url = new URL(req.url || '/', `http://${hostHeader}`)
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'

  // 1) 静态资源（/admin/ SPA、插件、favicon 等；public/ 里没有的路径自然落空）
  if (req.method === 'GET' || req.method === 'HEAD') {
    const hit = serveStatic(url.pathname, url.search)
    if (hit) {
      res.writeHead(hit.status, Object.fromEntries(hit.headers as never))
      if (req.method === 'HEAD') res.end()
      else res.end(Buffer.from(await hit.arrayBuffer()))
      console.log(`[http] ${req.method} ${host}${url.pathname} ${hit.status} ${Date.now() - started}ms (static)`)
      return
    }
  }

  // 2) 租户路由：未登记域名直接 404，不落到任何租户
  const tenant = tenants.get(host)
  if (!tenant) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`未登记的站点域名：${host}\n请在 docker-poc/tenants.json 里登记后重启。`)
    return
  }

  // 3) 组装 fetch Request 交给 Hono 应用（环境与执行上下文按租户注入）
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || value === undefined) continue
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
    else headers.set(key, value)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const appReq = new Request(`${proto}://${hostHeader}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as never) : undefined,
    duplex: 'half',
  } as RequestInit)
  const appRes = await xwblog.fetch(appReq, tenant.env as never, execCtx)
  sendToNode(req, res, appRes)
  console.log(`[http] ${req.method} ${host}${url.pathname} ${appRes.status} ${Date.now() - started}ms`)
}

let firedBackupDay = ''
const CRON_TICK_MS = 60_000

/**
 * cron：与 wrangler triggers.crons 同口径——每分钟扫定时发布；
 * 北京时间 00:30（UTC 16:30）那一分钟换成备份 cron，备份/visit 清理/回收站滚动一起跑。
 */
function startCron(tenants: Map<string, Tenant>) {
  const timer = setInterval(async () => {
    const now = new Date()
    const backupWindow = now.getUTCHours() === 16 && now.getUTCMinutes() === 30
    const day = now.toISOString().slice(0, 10)
    if (backupWindow) {
      if (firedBackupDay === day) return // 同一天只触发一次，防 tick 漂移双发
      firedBackupDay = day
    }
    const controller = { cron: backupWindow ? '30 16 * * *' : '* * * * *', scheduledTime: now.getTime() }
    for (const t of tenants.values()) {
      try {
        await xwblog.scheduled(controller as never, t.env as never, execCtx)
      } catch (e) {
        console.error(`[cron:${t.host}]`, e)
      }
    }
  }, CRON_TICK_MS)
  timer.unref()
}

const tenants = await loadTenants()

const server = http.createServer((req, res) => {
  handle(req, res, tenants).catch((e) => {
    console.error('[server] unhandled', e)
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('服务开小差了，请稍后再试。')
  })
})

server.listen(PORT, () => {
  console.log(`\nxwblog 自托管 POC 已启动：http://127.0.0.1:${PORT}`)
  console.log(`  租户：${[...tenants.keys()].join('  ')}（*.localhost 浏览器自动解析到 127.0.0.1）`)
  console.log(`  静态根：${PUBLIC_ROOT}`)
  console.log(`  数据根：${TENANTS_DIR}\n`)
})

startCron(tenants)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在退出…`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
