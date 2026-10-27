#!/usr/bin/env node
/**
 * 把微博里「浏览器放不出来」的 HEVC / H.265 视频批量转成 H.264 并原地替换
 * （2026-10-22 站长反馈：微博有些视频黑屏 0:00，有的能放有的不行）。
 *
 * 为什么需要这个脚本：Cloudflare Workers 没有转码能力，站点只能如实提示编码
 * 不兼容（src/store.ts sniffVideoCodec + public/site.js 的提示），救不回已经
 * 传上去的 HEVC 文件。修复只有一条路：本地用 ffmpeg 转码后重新上传。
 *
 * 做法（全程走后台 API，和人在后台点一遍等价）：
 *   1. 登录后台 → 翻完 /api/admin/weibo 全部页
 *   2. 逐条下载视频，按容器 box 判编码（不看扩展名 / mime）
 *   3. HEVC 的：ffmpeg 转 H.264（yuv420p + faststart，全平台可播）→ /api/admin/upload
 *      落新 key → PUT 回该条微博（新地址 = 新的缓存键，访客不会拿到旧的黑屏文件）
 *   4. 可选 --delete-old 顺手删掉旧 HEVC 文件（确认没有别的微博还在引用才删）
 *
 * 用法（Node 20+，需要本地 ffmpeg）：
 *   node scripts/fix-hevc-videos.mjs --site https://blog.xiaowuleyi.com --user 小吴 --password '***'
 *   node scripts/fix-hevc-videos.mjs --site ... --user ... --password ... --dry-run   # 只体检不改
 *   node scripts/fix-hevc-videos.mjs ... --limit 3 --delete-old                        # 先小批量试
 *
 * 参数：
 *   --site <url>        站点地址（默认 BLOGHAO_SITE 或 https://blog.xiaowuleyi.com）
 *   --user <name>       管理员账号（默认 BLOGHAO_USER）
 *   --password <pwd>    管理员密码（默认 BLOGHAO_PASSWORD）
 *   --totp <code>       开了两步验证时的一次性验证码（默认 BLOGHAO_TOTP）
 *   --ffmpeg <path>     ffmpeg 可执行文件（默认 FFMPEG 或 PATH 里的 ffmpeg）
 *   --dry-run           只列出哪些视频需要转码，不改任何数据
 *   --limit <n>         最多处理 n 条（先小批量验证）
 *   --only <ids>        只处理指定微博 id（逗号分隔，例如 --only 5834,5835）
 *   --max-mb <n>        转码后单文件上限，默认 24（站点上传硬限 25MB）
 *   --max-width <n>     缩到最宽 n 像素（默认 1280：H.264 比 HEVC 费码率，720p 卡片里看不亏）
 *   --delete-old        替换成功后删除旧 HEVC 文件（默认保留）
 *   --include-drafts    草稿也一起处理（默认只处理已发布）
 *
 * 幂等：已经转过的视频编码是 H.264，再跑会被跳过。
 */
import { execFile } from 'node:child_process'
import { setDefaultResultOrder } from 'node:dns'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// 有的网络环境解析出 Cloudflare 的 IPv6 地址却走不通（连上就超时，表现为 fetch failed），
// 优先 IPv4 能省掉一轮 Happy Eyeballs 的等待。
try { setDefaultResultOrder('ipv4first') } catch {}

const run = promisify(execFile)

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const out = { dryRun: false, deleteOld: false, includeDrafts: false, maxMB: 24, maxWidth: 1280, limit: 0, only: [] }
  const map = {
    '--site': 'site',
    '--user': 'user',
    '--password': 'password',
    '--totp': 'totp',
    '--ffmpeg': 'ffmpeg',
    '--limit': 'limit',
    '--max-mb': 'maxMB',
    '--max-width': 'maxWidth',
    '--only': 'only',
  }
  const numeric = new Set(['limit', 'maxMB', 'maxWidth'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--delete-old') out.deleteOld = true
    else if (a === '--include-drafts') out.includeDrafts = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (map[a]) {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} 缺少值`)
      out[map[a]] = numeric.has(map[a]) ? Number(v) : v
    } else throw new Error(`不认识的参数：${a}`)
  }
  out.site = String(out.site || process.env.BLOGHAO_SITE || 'https://blog.xiaowuleyi.com').replace(/\/+$/, '')
  out.user = out.user || process.env.BLOGHAO_USER || ''
  out.password = out.password || process.env.BLOGHAO_PASSWORD || ''
  out.totp = out.totp || process.env.BLOGHAO_TOTP || ''
  out.ffmpeg = out.ffmpeg || process.env.FFMPEG || 'ffmpeg'
  out.only = String(out.only || '')
    .split(/[,\s]+/)
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0)
  return out
}

/* ---------------- 视频编码嗅探（与 src/store.ts sniffVideoCodec 同口径） ---------------- */

const SAMPLE_ENTRY = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', vp09: 'vp9', av01: 'av1' }
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const fourcc = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3])

function codecFromBoxes(b, start, end, depth) {
  if (depth > 8) return null
  let at = start
  while (at + 8 <= end) {
    const size = u32(b, at)
    const type = fourcc(b, at + 4)
    let header = 8
    let boxSize = size
    if (size === 1) {
      if (at + 16 > end) return null
      boxSize = u32(b, at + 8) * 4294967296 + u32(b, at + 12)
      header = 16
    } else if (size === 0) boxSize = end - at
    if (boxSize < header || at + boxSize > end) return null
    if (type === 'stsd') {
      const p = at + header + 8
      return (p + 8 <= end && SAMPLE_ENTRY[fourcc(b, p + 4)]) || null
    }
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
      const found = codecFromBoxes(b, at + header, at + boxSize, depth + 1)
      if (found) return found
    }
    at += boxSize
  }
  return null
}

export function sniffCodec(buf) {
  const b = new Uint8Array(buf)
  if (b.length < 16) return null
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const s = Buffer.from(b.subarray(0, Math.min(b.length, 512 * 1024))).toString('latin1')
    if (s.includes('V_MPEGH/ISO/HEVC')) return 'hevc'
    if (s.includes('V_AV1')) return 'av1'
    if (s.includes('V_VP9') || s.includes('V_VP8')) return 'vp9'
    if (s.includes('V_MPEG4/ISO/AVC')) return 'h264'
    return null
  }
  if (fourcc(b, 4) === 'ftyp') return codecFromBoxes(b, 0, b.length, 0)
  return null
}

/* ---------------- HTTP 小工具（带会话 Cookie） ---------------- */

const state = { cookie: '' }

/** 网络抖动 / 本机 DNS 偶发超时很常见：GET 与小请求重试三次，别让一次失败中断整批 */
async function fetchRetry(url, init = {}, tries = 4) {
  let last
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, init)
    } catch (e) {
      last = e
      if (i < tries) await new Promise((r) => setTimeout(r, 800 * i))
    }
  }
  throw last
}

async function api(path, init = {}) {
  const headers = { ...(init.headers || {}) }
  if (state.cookie) headers.cookie = state.cookie
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json'
    // 后台全局中间件校验同源 Origin（form POST 也一样），带上站点源即可
    headers.origin = new URL(opts.site).origin
    init = { ...init, body: JSON.stringify(init.json) }
  }
  delete init.json
  const res = await fetchRetry(opts.site + path, { ...init, headers })
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  if (setCookies.length) {
    state.cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
  }
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const msg = body && typeof body === 'object' && body.error ? body.error : text.slice(0, 200)
    throw new Error(`${init.method || 'GET'} ${path} → HTTP ${res.status} ${msg}`)
  }
  return body
}

/* ---------------- 主流程 ---------------- */

let opts

function log(msg) {
  console.log(msg)
}

async function main() {
  opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    log('用法见脚本顶部注释：node scripts/fix-hevc-videos.mjs --site <url> --user <账号> --password <密码> [--dry-run]')
    return
  }
  if (!opts.user || !opts.password) throw new Error('缺少管理员账号密码（--user / --password 或环境变量）')

  // ffmpeg 先探一步：缺了在下载后才发现就白跑一趟
  if (!opts.dryRun) {
    await run(opts.ffmpeg, ['-version']).catch(() => {
      throw new Error(`找不到 ffmpeg（${opts.ffmpeg}）——装好后用 --ffmpeg 指定完整路径`)
    })
  }

  const login = await api('/api/auth/login', {
    method: 'POST',
    json: { username: opts.user, password: opts.password, totp: opts.totp || undefined },
  })
  log(`已登录：${login?.user?.username || opts.user}（${opts.site}）`)
  if (login?.user?.role && login.user.role !== 'admin') throw new Error('该账号不是管理员，转码替换需要管理员权限')

  // 1) 翻完微博列表（后台口径，不受站点可见窗口限制）
  const status = opts.includeDrafts ? 'all' : 'published'
  const items = []
  for (let page = 1; ; page++) {
    const r = await api(`/api/admin/weibo?status=${status}&page=${page}&limit=100`)
    for (const w of r.items || []) if (w.videoView && w.videoView.url) items.push({ id: w.id, video: w.videoView, status: w.status })
    if (!r.totalPages || page >= r.totalPages) break
  }
  log(`带视频的微博：${items.length} 条（${status === 'all' ? '含草稿' : '仅已发布'}）`)
  if (opts.only.length) {
    const want = new Set(opts.only)
    const kept = items.filter((it) => want.has(it.id))
    log(`--only 指定 ${opts.only.length} 条，其中带视频且在扫描范围内 ${kept.length} 条`)
    items.splice(0, items.length, ...kept)
  }

  // 引用计数：删旧文件前确认没有别的微博还在用同一个地址
  const refs = new Map()
  for (const it of items) refs.set(it.video.url, (refs.get(it.video.url) || 0) + 1)

  const tmp = await mkdtemp(join(tmpdir(), 'xwblog-hevc-'))
  const fixed = []
  const skipped = []
  const failed = []
  let scanned = 0
  let bytesBefore = 0
  let bytesAfter = 0

  let stopped = false
  const seen = new Set()
  // 失败原因按 id 记账：重排队列里只放原始条目（曾经混进过 {item, reason} 包装对象，
  // 第二轮重试时 it.video 就成了 undefined，整个任务在收尾阶段崩掉）
  const failReason = new Map()
  try {
    // 慢网 / 长途链路经常「抖一下就整条失败」，一条几百 KB 的重传远比事后人工补跑便宜：
    // 失败的条目收尾再排两轮重试，三轮都过不去才记进失败清单。
    let queue = items.slice()
    for (let pass = 0; pass < 3 && queue.length && !stopped; pass++) {
      if (pass) {
        log(`\n— 第 ${pass + 1} 轮重试：${queue.length} 条（等 10 秒再开始）`)
        await new Promise((r) => setTimeout(r, 10000))
      }
      const retry = []
      for (const it of queue) {
        if (opts.limit && fixed.length >= opts.limit) {
          stopped = true
          break
        }
        if (!seen.has(it.id)) {
          seen.add(it.id)
          scanned++
        }
        const abs = it.video.url.startsWith('http') ? it.video.url : opts.site + it.video.url
        let got
        try {
          got = await downloadAndSniff(abs)
        } catch (e) {
          log(`  ✗ #${it.id} 下载失败：${e.message}`)
          failReason.set(it.id, '下载失败：' + e.message)
          retry.push(it)
          continue
        }
        const codec = got.codec
        if (codec !== 'hevc') {
          // H.264 等浏览器都能放的编码读到 moov 就停，不整包下载（400 多条视频能省下大半流量）
          log(`  · #${it.id} ${codec || '未知编码'}，跳过`)
          continue
        }
        const buf = got.complete ? got.buf : await downloadFull(abs)
        const mb = (buf.length / 1048576).toFixed(1)
        if (opts.dryRun) {
          log(`  ! #${it.id} HEVC ${mb}MB → 需要转码（dry-run 不改）`)
          fixed.push({ id: it.id, from: it.video.url, size: buf.length })
          continue
        }

        log(`  → #${it.id} HEVC ${mb}MB 转码中…`)
        try {
          const row = (await api(`/api/admin/weibo/${it.id}`)).weibo
          const input = join(tmp, `${it.id}.mp4`)
          await writeFile(input, buf)
          const { out, size } = await transcode(input, tmp)
          // 乐观锁：转码这几秒里站长可能正在改这条微博（换视频 / 改正文 / 删进回收站）。
          // 回写前再取一次，updated_at 变了或已进回收站就跳过——宁可不转，也不能拿旧快照覆盖人家的新内容。
          const again = (await api(`/api/admin/weibo/${it.id}`)).weibo
          if (again.deleted_at || again.updated_at !== row.updated_at) {
            log(`  ! #${it.id} 转码期间被改动（或已删除），跳过，不动它的内容`)
            skipped.push({ id: it.id, reason: again.deleted_at ? '已进回收站' : '转码期间被编辑' })
            continue
          }
          const newUrl = await upload(out)
          if (size > opts.maxMB * 1048576) log(`  ! 转码后 ${(size / 1048576).toFixed(1)}MB 仍偏大，已按最高压缩档处理`)
          // PUT 是全量更新：正文 / 配图 / 状态都要原样带上，视频换成新地址
          await api(`/api/admin/weibo/${it.id}`, {
            method: 'PUT',
            json: {
              content: row.content || '',
              images: row.imageList || [],
              status: row.status === 'published' ? 'published' : 'draft',
              video: { url: newUrl, poster: it.video.poster || '', w: it.video.w || 0, h: it.video.h || 0 },
            },
          })
          log(`  ✓ #${it.id} → ${newUrl}（${(size / 1048576).toFixed(1)}MB）`)
          fixed.push({ id: it.id, from: it.video.url, to: newUrl, size, sizeBefore: buf.length })
          bytesBefore += buf.length
          bytesAfter += size
          if (opts.deleteOld && (refs.get(it.video.url) || 0) <= 1 && it.video.url.startsWith('/images/u/')) {
            const key = it.video.url.slice('/images/'.length)
            await api(`/api/admin/uploads?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch((e) =>
              log(`  ! #${it.id} 旧文件删除失败（不影响播放）：${e.message}`)
            )
          }
        } catch (e) {
          log(`  ✗ #${it.id} 失败：${e.message}`)
          failReason.set(it.id, e.message)
          retry.push(it)
        }
      }
      queue = retry
      if (pass === 2) for (const it of retry) failed.push({ id: it.id, reason: failReason.get(it.id) || '失败' })
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }

  log('')
  log(`扫描 ${scanned} 条视频：HEVC ${fixed.length} 条，跳过 ${skipped.length} 条，失败 ${failed.length} 条`)
  if (bytesBefore) {
    log(`体积 ${(bytesBefore / 1048576).toFixed(1)}MB → ${(bytesAfter / 1048576).toFixed(1)}MB`)
  }
  if (fixed.length) {
    log('已处理：')
    for (const f of fixed) log(`  #${f.id} ${f.from}${f.to ? ' → ' + f.to : '（dry-run 未改）'}`)
  }
  if (failed.length) {
    log('失败（可单独重跑，已转过的会被跳过）：')
    for (const f of failed) log(`  #${f.id} ${f.reason}`)
    process.exitCode = 1
  }
  if (skipped.length) {
    log('跳过（运行期间被改动，重跑一次即可）：')
    for (const s of skipped) log(`  #${s.id} ${s.reason}`)
  }
  if (opts.dryRun) log('\n（dry-run：未改动任何数据）')
  if (!opts.dryRun && fixed.length) {
    // 页面边缘缓存里可能还留着「旧视频地址」的副本（编辑触发的清理走 waitUntil，偶有没跑到的情况），
    // 收尾主动清一次，免得站长刷新了发现还是黑屏——其实是缓存里的旧页面。
    await api('/api/admin/cache/purge', { method: 'POST', json: {} }).then(
      () => log('已清理页面缓存（访客刷新生效）'),
      (e) => log('页面缓存清理失败（30 分钟内会自动过期）：' + e.message)
    )
  }
}

/** 边下边判：读到能认出编码就停（H.264 之类直接省掉剩余流量；HEVC 要整包转码，交给 downloadFull） */
async function downloadAndSniff(url) {
  const res = await fetchRetry(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    return { codec: sniffCodec(buf), buf, complete: true }
  }
  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    chunks.push(Buffer.from(chunk))
    total += chunk.length
    if (total >= 256 * 1024) {
      const codec = sniffCodec(Buffer.concat(chunks, total))
      // for-await 里 return 会自动 cancel 掉响应流，不再继续下
      if (codec && codec !== 'hevc') return { codec, buf: Buffer.concat(chunks, total), complete: false }
    }
  }
  const buf = Buffer.concat(chunks, total)
  return { codec: sniffCodec(buf), buf, complete: true }
}

async function downloadFull(url) {
  const res = await fetchRetry(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** 转 H.264：先在 CRF 23 试，超过上限就逐档加压缩（分辨率已按 --max-width 收窄，宁可多丢一点画质也要能全平台播） */
async function transcode(input, dir) {
  const ratios = [23, 26, 28, 32]
  // 只缩不放：原片比 max-width 窄就保持原尺寸；out_range=tv 把 iPhone 的全范围（yuvj）拉回标准 limited range
  const vf = `scale='min(iw,${opts.maxWidth})':-2:out_range=tv`
  for (const crf of ratios) {
    const out = join(dir, `out-${crf}.mp4`)
    await run(opts.ffmpeg, [
      '-y',
      '-i', input,
      '-vf', vf,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p', // Chrome / Safari 都吃 8bit 4:2:0，10bit 会再踩一次兼容坑
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart', // moov 前置：边下边播，首帧不用等整段
      out,
    ])
    const size = (await stat(out)).size
    if (size <= opts.maxMB * 1048576) return { out, size }
    await rm(out, { force: true })
  }
  throw new Error(`转码后仍超过 ${opts.maxMB}MB，请手动剪辑后再传`)
}

/** 走后台上传端点落新 key（新地址 = 全新缓存键，旧的黑屏文件不会继续被浏览器缓存复用） */
async function upload(file) {
  const bytes = await readFile(file)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'video-h264.mp4')
  const r = await api('/api/admin/upload', { method: 'POST', body: form })
  if (!r?.url) throw new Error('上传返回缺少 url')
  if (r.codec && r.codec !== 'h264') throw new Error(`上传后服务端嗅探到 ${r.codec}，转码未生效`)
  return r.url
}

// 只在直接执行时跑主流程：被测试 / 其它脚本 import 时只拿到纯函数（sniffCodec）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('出错：' + (e instanceof Error ? e.message : String(e)))
    process.exitCode = 1
  })
}
