import { type Context, Hono } from 'hono'
import { runBackup } from './backup'
import { analyticsScriptHtml, cleanAnalyticsScript, cleanCategoryDescription, cleanRobotsExtra, cleanVerifyMetas, verifyMetaTagsHtml, AI_POLICY_VALUES, type AiPolicy } from './seo'
import {
  clearMemberSessionCookie,
  clearSessionCookie,
  clientIp,
  createMemberSession,
  createSession,
  destroyMemberSession,
  destroyMemberSessionsByMember,
  destroyOtherMemberSessions,
  destroyOtherSessions,
  destroySession,
  getCookie,
  getMemberUser,
  getSessionUser,
  hashPassword,
  MEMBER_SESSION_COOKIE,
  rateLimit,
  safeEqual,
  SESSION_COOKIE,
  sessionCookie,
  isSecureRequest,
  tokenHash,
  memberSessionCookie,
} from './auth'
import { verifyTurnstile } from './turnstile'
import { updateStatus, validateUpdateManifest, UPDATE_GUIDE_URL, UPDATE_MANIFEST_URL } from './update'
import { APP_VERSION } from './version'
import {
  countUsers,
  createCategory,
  categoryNameMap,
  createMember,
  bumpWeiboCount,
  bumpWeiboCountById,
  DEFAULT_SETTINGS,
  getCategoryById,
  getFriendLinkById,
  getMemberById,
  getMemberByUsername,
  getPostById,
  getPostBySlug,
  getPostCategoryId,
  getSettings,
  getWeiboById,
  listCategories,
  listFriendLinks,
  listMembersAdmin,
  listPages,
  getPageById,
  uniquePageSlug,
  listPosts,
  listWeibo,
  likeDelta,
  MAX_CONTENT_BYTES,
  parseTags,
  parseWeiboImages,
  parseWeiboVideo,
  postAdminView,
  invalidateSharedSettings,
  recordMemberLike,
  recordMemberVisit,
  removeMemberLike,
  saveSettings,
  SECRET_SETTINGS,
  seedWelcomePost,
  setPostCategory,
  uniqueSlug,
  updateMemberAdmin,
  updateMemberNickname,
  updateMemberQQ,
  weiboCommentCountMap,
  weiboImageList,
  weiboTopicList,
  weiboVideoView,
  WEIBO_MAX_CHARS,
  type WeiboVideoView,
} from './db'
import { mdToHtml } from './markdown'
import { purgeImageCache, purgePageCache } from './pagecache'
import { appearanceMeta, cleanAppearanceSettings } from './appearance'
import { cleanCustomCss } from './skinpack'
import {
  cleanPluginId,
  pluginFileKey,
  PLUGIN_SRC_MAX_BYTES,
  readInstalled,
  removeInstalled,
  sanityCheckPluginSource,
  upsertInstalled,
} from './pluginpkg'
import { EMOJI_BASE, WECHAT_EMOJI } from './emoji'
import { awardCommentPoints, awardPoints, bumpActiveDay, normalizeMinTier } from './points'
import { fanDay, fanLevel, nextStreak } from './fanrank'
import { cleanMemberTiers, effectiveTier, parseMemberTiers, tierByKey, type MemberTierDef } from './tiers'
import { collectRoutes } from './collect'
import { exportRoutes } from './export'
import { adminExternalRoutes, externalRoutes, notifyAdminComment, telegramRoutes } from './external'
import {
  BUNDLE_PREFIX,
  buildBundleStream,
  bundleFileName,
  finishBundleImport,
  getBundleImportState,
  markBundleImportFailed,
  RESET_CONFIRM_PHRASE,
  resetConfirmOk,
  resetSiteContent,
  runBundleImportStep,
  startBundleImport,
} from './sitebundle'
import { fetchPublicResource } from './fetchsafe'
import { isEn } from './i18n'
import { ipRegionLabel, regionSnapshot } from './ipregion'
import {
  cleanServerPluginConfig,
  fireBackupCompleted,
  fireCommentCreated,
  firePlazaRetract,
  firePostDeleted,
  firePostPublished,
  firePostUpdated,
  fireWeiboDeleted,
  fireWeiboPublished,
  listBufferChannels,
  listServerPlugins,
  PLAZA_OFFICIAL_HUB,
} from './hooks'
import { SITE_MODE_VALUES, siteBase, toHomePost, type SiteMode } from './render'
import { sanitizeHtml } from './sanitize'
import { cleanupUnreferenced, backfillHashes, mergeDuplicate, runAudit } from './audit'
import { imageExtOf, MAX_REMOTE_IMAGES, MAX_UPLOAD_BYTES, saveUpload, sniffImageExt, sniffUploadExt, sniffVideoCodec, transferImage } from './store'
import { hashPostPassword } from './protect'
import { generateTotpSecret, totpProvisioningUri, verifyTotp } from './totp'
import { qrMatrix } from './qrcode'
import { notifyAdminText } from './external'
import {
  IMPORT_IMAGE_BATCH,
  mapWxrImport,
  MAX_IMPORT_IMAGES,
  MAX_IMPORT_PAGES,
  MAX_IMPORT_PASSWORDS,
  MAX_IMPORT_POSTS,
  MAX_WXR_BYTES,
  parseWxr,
} from './import-wxr'
import { listTrash, restorePostStatus, trashTable, type TrashTable } from './trash'
import { classifyBrowser, classifyDevice, cleanPath, cleanRef, cleanTitle, cleanVid, getVisitStats, recordVisit } from './stats'
import { getBotStats } from './bots'
import { fetchLinkMeta, fetchableUrl } from './linkmeta'
import { BROWSER_UA, buildCardHtml, coverProxyHostOk, coverReferer, fetchDoubanDetail, probeRelay, resolveCardCover, sanitizeMediaItem, searchMedia, subjectIdFromUrl, validateRelay, type MediaItem } from './douban'
import { THEMES } from './themes/registry'
import type { CommentRow, Env, MemberRow, PostRow, SessionUser } from './types'
import { appendOldSlug, clampInt, cleanDisabledPlugins, cleanNickname, cleanSlug, excerpt, extractWeiboTopics, fmtDateCN, isDemo, isValidQQ, jsonItemLikePattern, LIST_RANGES, listRangeCutoff, nicknameCooldown, normalizeLinkUrl, pageWindowCutoff, siteVisibleCutoff, slugify, visibleRangeAppliesToMembers, weiboVisibleCutoff } from './utils'

type AppEnv = { Bindings: Env; Variables: { user: SessionUser } }

const VIDEO_MIMES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status })
}

export const api = new Hono<AppEnv>()

/* ---------------- 全局：入站体积预检（防超大 body 打爆 isolate） ----------------
 * Workers 平台请求体上限（100MB）远大于 isolate 128MB 内存，json()/parseBody() 整读前先看
 * Content-Length 早拒；正文自有 MAX_CONTENT_BYTES(1MB) 后置校验，这里 2MB 给 JSON 结构留余量。
 * 上传/外部微博是 multipart 带二进制（单文件上限 25MB），给 30MB；chunked 无 CL 放行属残余
 * 风险（正常客户端与 curl 都带 CL），公开写端点另有限流与蜜罐在前 */
const BODY_LIMIT_BYTES = 2 * 1024 * 1024
const BODY_LIMIT_UPLOAD_BYTES = 30 * 1024 * 1024
/** 整站包上传（B26）：包含全部图片，可能几百 MB，单独给平台请求体上限（CF ≈100MB） */
const BODY_LIMIT_BUNDLE_BYTES = 100 * 1024 * 1024
/* 上传豁免路径**必须写全前缀**：api 路由挂在 /api 下（index.ts `app.route('/api', api)`），
 * 而 c.req.path 是完整路径（/api/admin/upload）。这里曾漏写 /api 前缀，于是上传端点一直按
 * 2MB 的普通限额预检——超过 2MB 的视频 / 大图 / 开放接口配图直接 413（前端只看到「上传失败」）。
 * 2026-10-13 站长上传 20MB 视频失败暴露：此前没有 >2MB 请求体的测试，所以一路潜伏到线上。
 * 冒烟「上传体积预检」用例守着（3MB mp4 必须 200，26MB 必须 413）。 */
const UPLOAD_PATH_PREFIXES = ['/api/admin/upload', '/api/admin/og-image', '/api/external/weibo', '/api/admin/import/wxr']
/** 整站包上传：独立档位（比普通上传高），同样必须写全前缀 */
const BUNDLE_PATH_PREFIXES = ['/api/admin/bundle/upload']
api.use('*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const p = c.req.path
    const limit = BUNDLE_PATH_PREFIXES.some((x) => p.startsWith(x))
      ? BODY_LIMIT_BUNDLE_BYTES
      : UPLOAD_PATH_PREFIXES.some((x) => p.startsWith(x))
        ? BODY_LIMIT_UPLOAD_BYTES
        : BODY_LIMIT_BYTES
    const cl = Number(c.req.header('Content-Length') || '0')
    if (cl > limit) return c.text('请求体过大', 413)
  }
  await next()
})

/* ---------------- 全局：同源校验（防 CSRF） ---------------- */
api.use('*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin')
    if (origin && origin !== new URL(c.req.url).origin) {
      return jsonError('跨站请求被拒绝', 403)
    }
  }
  await next()
})

api.get('/health', (c) => c.json({ ok: true, time: Date.now() }))

/* ---------------- 认证 ---------------- */
api.get('/auth/state', async (c) => {
  const [user, n, settings] = await Promise.all([getSessionUser(c.env.DB, c.req.raw), countUsers(c.env.DB), getSettings(c.env.DB)])
  // demo 标记给后台前端用：登录页公示演示账号、禁用改密码与闭站开关；
  // needsTotp（B13）驱动登录表单预显「两步验证码」输入框（开了 TOTP 才显示，别让全员看到多余框）
  return c.json({ needsSetup: n === 0, user, demo: isDemo(c.env), needsTotp: settings.totpEnabled === '1' })
})

api.post('/auth/setup', async (c) => {
  if ((await countUsers(c.env.DB)) > 0) return jsonError('管理员已存在', 403)
  if (!rateLimit(`setup:${clientIp(c.req.raw)}`, 5, 10 * 60_000)) return jsonError('请求过于频繁，请稍后再试', 429)
  const body = await c.req.json<{ username?: string; password?: string; displayName?: string }>().catch(() => null)
  const username = (body?.username || '').trim()
  const password = body?.password || ''
  if (!/^[a-zA-Z0-9_-]{2,24}$/.test(username)) return jsonError('用户名需为 2-24 位字母、数字、_ 或 -')
  if (password.length < 8 || password.length > 64) return jsonError('密码长度需为 8-64 位')
  // 原子占位锁：countUsers 是 check-then-insert，并发首个请求都能通过检查，
  // 靠 settings 一次性 INSERT 的 changes 判定唯一归属，杜绝双管理员
  const lock = await c.env.DB
    .prepare("INSERT INTO settings (key, value) VALUES ('setupLock', '1') ON CONFLICT(key) DO NOTHING")
    .run()
  if ((lock.meta.changes ?? 0) !== 1) return jsonError('管理员已存在', 403)
  await invalidateSharedSettings(c.env.DB)
  try {
    const { hash, salt } = await hashPassword(password)
    const now = Date.now()
    const res = await c.env.DB.prepare(
      'INSERT INTO users (username, password_hash, salt, display_name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(username, hash, salt, (body?.displayName || username).slice(0, 32), '', now, now)
      .run()
    const userId = Number(res.meta.last_row_id)
    await seedWelcomePost(c.env.DB, userId)
    // 新手引导记账位（后台概览页清单卡）：仅首装点亮，老站无此键永不显示；
    // 裸写 settings 后必须失效共享快照（db.ts 防线）。失败随 catch 释放锁——
    // 此时用户行已落库，重试会撞「管理员已存在」，但直接登录不受影响，最坏退化为「无引导卡」
    await c.env.DB
      .prepare("INSERT INTO settings (key, value) VALUES ('onboarding', '1') ON CONFLICT(key) DO NOTHING")
      .run()
    await invalidateSharedSettings(c.env.DB)
    const token = await createSession(c.env.DB, userId)
    c.header('Set-Cookie', sessionCookie(token, isSecureRequest(c.req.raw)))
    return c.json({ ok: true, user: { id: userId, username, display_name: body?.displayName || username, avatar: '' } })
  } catch (e) {
    // 建号中途失败要释放锁，否则首次安装被永久卡死
    await c.env.DB.prepare("DELETE FROM settings WHERE key = 'setupLock'").run().catch(() => undefined)
    throw e
  }
})

/** 单账号同时存活的会话上限（v2.8.0 反馈）：超过即从最旧开始删——防重复登录无限堆积 */
const SESSIONS_PER_USER_CAP = 10

/** 登录失败 TG 告警（B13）：每 IP 10 分钟最多 1 条防爆破刷屏；TG 未配置时 notifyAdminText 内部静默；
 *  异步发送不阻塞登录响应。用户名来自请求体（截断 40），纯文本消息无注入面 */
function alertLoginFailure(env: Env, ip: string, username: string): void {
  if (!rateLimit(`login-alert:${ip}`, 1, 10 * 60_000)) return
  void notifyAdminText(env, `⚠️ 后台登录失败：用户名「${String(username || '').slice(0, 40)}」IP ${ip}。若非本人操作，请改密码或到「设置 → 两步验证」加固`).catch(() => {})
}

/** TOTP 配对二维码（B13）：qrMatrix（src/qrcode.ts 零依赖实现）→ 内联 SVG，随 setup 一次性回显 */
function qrSvgData(text: string): string {
  const m = qrMatrix(text)
  if (!m) return ''
  const n = m.length
  let path = ''
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) path += `M${x} ${y}h1v1h-1z`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" width="180" height="180"><rect width="${n}" height="${n}" fill="#ffffff"/><path d="${path}" fill="#211d19"/></svg>`
}

api.post('/auth/login', async (c) => {
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`login:${ip}`, 10, 10 * 60_000)) return jsonError('尝试次数过多，请 10 分钟后再试', 429)
  const body = await c.req.json<{ username?: string; password?: string; totp?: string }>().catch(() => null)
  const username = (body?.username || '').trim()
  const password = body?.password || ''
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<{
    id: number
    username: string
    password_hash: string
    salt: string
    display_name: string
    avatar: string
    role?: 'admin' | 'author'
  }>()
  if (user) {
    const { hash } = await hashPassword(password, user.salt)
    if (safeEqual(hash, user.password_hash)) {
      // 两步验证（B13）：密码验证通过之后、会话签发之前——路径唯一不可绕过；
      // 登录页由 /auth/state 的 needsTotp 预显验证码框，这里只认 6 位码
      const totpSettings = await getSettings(c.env.DB)
      if (totpSettings.totpEnabled === '1' && totpSettings.totpSecret) {
        if (!(await verifyTotp(totpSettings.totpSecret, body?.totp || ''))) {
          alertLoginFailure(c.env, ip, username)
          return jsonError('两步验证码不对', 401)
        }
      }
      const token = await createSession(c.env.DB, user.id)
      // 会话膨胀防护（v2.8.0 反馈）：登录时顺手清本账号的过期会话；活跃会话超过上限删最旧——
      // 否则每次登录新增一行，30 天有效期内无限堆积，「活跃会话」列表长到没法看
      await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(user.id, Date.now()).run()
      const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(user.id).first<{ n: number }>()
      const over = (cnt?.n ?? 0) - SESSIONS_PER_USER_CAP
      if (over > 0)
        await c.env.DB.prepare(
          'DELETE FROM sessions WHERE token IN (SELECT token FROM sessions WHERE user_id = ? ORDER BY created_at ASC, expires_at ASC LIMIT ?)'
        )
          .bind(user.id, over)
          .run()
      c.header('Set-Cookie', sessionCookie(token, isSecureRequest(c.req.raw)))
      return c.json({
        ok: true,
        user: { id: user.id, username: user.username, display_name: user.display_name, avatar: user.avatar, role: user.role },
      })
    }
  } else {
    // 用户不存在也跑一次等开销的哈希：响应耗时对齐，防时序侧信道枚举用户名
    await hashPassword(password, 'timing-equalizer-salt-0000')
  }
  alertLoginFailure(c.env, ip, username)
  return jsonError('用户名或密码错误', 401)
})

api.post('/auth/logout', async (c) => {
  await destroySession(c.env.DB, c.req.raw)
  c.header('Set-Cookie', clearSessionCookie())
  return c.json({ ok: true })
})

/* ---------------- 会员（访客注册/登录，契约见 docs/archive/DEVPLAN-2026-10-07.md 附录 A） ---------------- */

/** 对外视图裁剪：公开口径只有昵称/档位/积分；self = 本人视角（另给 email/username/createdAt），管理口径走 listMembersAdmin 原始行。
 *  档位出参按生效档位（src/tiers.ts：过期即时降级基础档）解析——tierName/tierColor 供前台直接渲染认证徽标 */
function memberView(m: MemberRow, self = false, defs: MemberTierDef[] = parseMemberTiers(undefined)) {
  const eff = effectiveTier(defs, m.tier, m.tier_expires_at)
  const v: Record<string, unknown> = {
    nickname: (m.display_name || m.username).slice(0, 24),
    tier: m.tier,
    tierName: eff.name,
    tierColor: eff.color,
    tierIsBase: eff.isBase,
    tierExpiresAt: m.tier_expires_at ?? null,
    tierExpired: eff.expired,
    points: m.points,
  }
  if (m.avatar) v.avatarUrl = m.avatar
  if (self) {
    v.username = m.username
    v.email = m.email
    v.qq = m.qq
    v.createdAt = m.created_at
    v.displayNameChangedAt = m.display_name_changed_at ?? null
    // 铁粉体系（3.0-M1）：等级与签到状态本人视角可见（会员卡渲染签到按钮态）
    const fan = fanLevel(m.points, m.active_days ?? 0)
    v.fanLevel = fan.level
    v.fanName = fan.name
    v.activeDays = m.active_days ?? 0
    v.checkinStreak = m.checkin_streak ?? 0
    v.checkedToday = m.last_checkin_day === fanDay()
  }
  return v
}

api.post('/member/register', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  // 注册开关（会员 3.0 预备，settings.memberRegOpen）：关闭 = 老会员照常登录、新用户不再进人
  if (settings.memberRegOpen === '0') return jsonError('本站暂不开放注册，稍后再来看看', 403)
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`mreg:${ip}`, 5, 10 * 60_000)) return jsonError('注册太频繁，请稍后再试', 429)
  const body = await c.req.json<{ username?: string; password?: string; email?: string; nickname?: string; link?: string; turnstileToken?: string }>().catch(() => null)
  // 蜜罐字段 link：正常用户看不到、机器人会填 —— 静默丢弃（同 publicComment 口径）
  if (body?.link) return c.json({ ok: true })
  // 注册人机验证（Turnstile，A2 根治）：配置了 Secret 才启用，放在字段校验之前让无令牌机器人
  // 最早出局；演示站跳过（凭据公示的体验站不外发 siteverify，也不给体验者加验证负担）。
  // verifyTurnstile 拿不到结论一律 false —— 端点抖动时宁可挡注册，不留无验证窗口
  if (settings.turnstileSecret && !isDemo(c.env)) {
    const ok = await verifyTurnstile(settings.turnstileSecret, String(body?.turnstileToken || ''), ip)
    if (!ok) return jsonError('人机验证未通过，请刷新页面后重试')
  }
  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')
  const email = String(body?.email || '').trim().slice(0, 100)
  // 昵称选填（中英文均可，仅展示不做唯一约束）；注册时填写不占用 30 天修改窗口
  const nickname = cleanNickname(body?.nickname)
  if (!/^[a-zA-Z0-9_-]{2,24}$/.test(username)) return jsonError('用户名需为 2-24 位字母、数字、_ 或 -')
  if (password.length < 8 || password.length > 64) return jsonError('密码长度需为 8-64 位')
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError('邮箱格式不正确')
  if (await getMemberByUsername(c.env.DB, username)) return jsonError('用户名已被占用')
  const { hash, salt } = await hashPassword(password)
  let memberId: number
  try {
    memberId = await createMember(c.env.DB, { username, hash, salt, email, displayName: nickname })
  } catch {
    return jsonError('用户名已被占用') // 并发注册撞 UNIQUE 约束的兜底
  }
  const token = await createMemberSession(c.env.DB, memberId)
  c.header('Set-Cookie', memberSessionCookie(token, isSecureRequest(c.req.raw)))
  await awardPoints(c.env.DB, memberId, 'dailyLogin')
  await bumpActiveDay(c.env.DB, memberId)
  const row = await getMemberById(c.env.DB, memberId)
  return c.json({ ok: true, member: row ? memberView(row, true) : null })
})

api.post('/member/login', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`mlogin:${ip}`, 10, 10 * 60_000)) return jsonError('尝试次数过多，请 10 分钟后再试', 429)
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null)
  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')
  const m = await getMemberByUsername(c.env.DB, username)
  if (m) {
    const { hash } = await hashPassword(password, m.salt)
    if (safeEqual(hash, m.password_hash)) {
      // 先验口令再报封禁：不向未持有口令的人泄露账号状态（契约 A5：403 {error:'banned'}）
      if (m.status === 'banned') return jsonError('banned', 403)
      const token = await createMemberSession(c.env.DB, m.id)
      // 会员会话同款膨胀防护（每日签到每天都会登录一次，30 天有效期堆积更快）
      await c.env.DB.prepare('DELETE FROM member_sessions WHERE member_id = ? AND expires_at <= ?').bind(m.id, Date.now()).run()
      const mcnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions WHERE member_id = ?').bind(m.id).first<{ n: number }>()
      const mover = (mcnt?.n ?? 0) - SESSIONS_PER_USER_CAP
      if (mover > 0)
        await c.env.DB.prepare(
          'DELETE FROM member_sessions WHERE token IN (SELECT token FROM member_sessions WHERE member_id = ? ORDER BY created_at ASC, expires_at ASC LIMIT ?)'
        )
          .bind(m.id, mover)
          .run()
      c.header('Set-Cookie', memberSessionCookie(token, isSecureRequest(c.req.raw)))
      await awardPoints(c.env.DB, m.id, 'dailyLogin')
      await bumpActiveDay(c.env.DB, m.id)
      await c.env.DB.prepare('UPDATE members SET last_login_at = ? WHERE id = ?').bind(Date.now(), m.id).run()
      return c.json({ ok: true, member: memberView(m, true) })
    }
  } else {
    // 用户不存在也跑一次等开销哈希：响应耗时对齐，防时序侧信道枚举用户名（同 /auth/login 口径）
    await hashPassword(password, 'timing-equalizer-salt-0000')
  }
  return jsonError('用户名或密码错误', 401)
})

api.post('/member/logout', async (c) => {
  await destroyMemberSession(c.env.DB, c.req.raw)
  c.header('Set-Cookie', clearMemberSessionCookie())
  return c.json({ ok: true })
})

api.get('/member/me', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  const session = await getMemberUser(c.env.DB, c.req.raw)
  if (!session) return c.json({ member: null })
  const row = await getMemberById(c.env.DB, session.id)
  return c.json({ member: row ? memberView(row, true) : null })
})

/* 会员个人资料（/member 页会员卡，契约见 docs/archive/DEVPLAN-2026-10-07.md）：改昵称（30 天一次）与改密码 */

/** 抓取 QQ 头像并转存进站内图床，返回站内地址；失败返回 null（调用方容忍只存 qq 号，
 *  会员中心「重试头像」重跑同一请求补抓）。q1 主端点、q2 备用镜像，s=140 档（100 略糊、
 *  640 浪费流量）；只认文件魔数（同 collect 转存口径），落库统一走 saveUpload（EXIF 剥离同款兜底） */
async function fetchQQAvatar(env: Env, qq: string): Promise<string | null> {
  for (const host of ['q1.qlogo.cn', 'q2.qlogo.cn']) {
    try {
      const res = await fetch(`https://${host}/g?b=qq&nk=${encodeURIComponent(qq)}&s=140`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Referer: 'https://q.qlogo.cn/' },
        signal: AbortSignal.timeout(6_000),
      })
      if (!res.ok) continue
      if (Number(res.headers.get('content-length') || 0) > 1024 * 1024) continue
      const buf = await res.arrayBuffer()
      if (buf.byteLength === 0 || buf.byteLength > 1024 * 1024) continue
      const ext = sniffImageExt(buf)
      if (!ext || ext === 'gif') continue // 头像只收 jpg/png/webp
      return await saveUpload(env, buf, `image/${ext === 'jpg' ? 'jpeg' : ext}`, `qq-${qq}.${ext}`, ext)
    } catch {
      /* 单镜像失败换下一个，最终失败由调用方容忍 */
    }
  }
  return null
}

/** 每日签到（铁粉体系 3.0-M1）：+2 分、连续 ≥7 天当天额外 +1（streakBonus）、活跃天数同步累计。
 *  幂等三道：前置查 last_checkin_day、ref_id 北京日序号唯一索引、日上限 cap=1——连点/并发都只记一次 */
api.post('/member/checkin', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  if (!rateLimit(`mcheckin:${clientIp(c.req.raw)}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const m = await getMemberUser(c.env.DB, c.req.raw)
  if (!m) return jsonError('请先登录', 401)
  const row = await getMemberById(c.env.DB, m.id)
  if (!row || row.status === 'banned') return jsonError('账号不可用', 403)
  const today = fanDay()
  if (row.last_checkin_day === today) return jsonError('今天已经签到过啦，明天再来', 400)
  const streak = nextStreak(row.last_checkin_day || '', today, fanDay(Date.now() - 86_400_000), row.checkin_streak ?? 0)
  const res = await awardPoints(c.env.DB, m.id, 'checkin')
  let bonus = 0
  if (streak >= 7) bonus = (await awardPoints(c.env.DB, m.id, 'streakBonus')).delta
  await c.env.DB.prepare('UPDATE members SET checkin_streak = ?, last_checkin_day = ? WHERE id = ?').bind(streak, today, m.id).run()
  await bumpActiveDay(c.env.DB, m.id)
  const after = await getMemberById(c.env.DB, m.id)
  const fan = fanLevel(after?.points ?? 0, after?.active_days ?? 0)
  return c.json({ ok: true, delta: res.delta, bonus, points: after?.points ?? 0, streak, level: fan.level, levelName: fan.name })
})

api.post('/member/profile', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  const session = await getMemberUser(c.env.DB, c.req.raw)
  if (!session) return jsonError('请先登录', 401)
  const body = await c.req.json<{ nickname?: string; qq?: string }>().catch(() => null)
  const hasNickname = !!body && typeof body.nickname === 'string'
  const nickname = hasNickname ? cleanNickname(body?.nickname) : ''
  // qq 只在显式携带时处理：带键即意图（绑定/重试头像），不带键不碰
  const qq = body && typeof body.qq === 'string' ? body.qq.trim() : undefined
  if (!hasNickname && qq === undefined) return jsonError('没有要修改的内容')
  if (hasNickname && !nickname) return jsonError('昵称不能为空')
  const res: Record<string, unknown> = { ok: true }
  const now = Date.now()

  if (hasNickname) {
    const row = await getMemberById(c.env.DB, session.id)
    if (!row) return jsonError('请先登录', 401)
    const cd = nicknameCooldown(row.display_name_changed_at)
    if (!cd.allowed) return jsonError(`昵称每 30 天只能修改一次，${fmtDateCN(cd.nextAt)}后可再改`, 403)
    // 条件更新把窗口判定下沉进 SQL：并发双开同时过上面的前置检查时，只有一动能落库
    if (!(await updateMemberNickname(c.env.DB, session.id, nickname, now))) {
      return jsonError(`昵称每 30 天只能修改一次，${fmtDateCN(nicknameCooldown(now).nextAt)}后可再改`, 403)
    }
    res.nickname = nickname
    res.displayNameChangedAt = now
  }

  if (qq !== undefined) {
    // 评论头像（C2）：qq 号仅作头像抓取记账位，任何公开出参不携带；绑过再绑 = 幂等重试头像
    if (!isValidQQ(qq)) return jsonError('QQ 号格式不对（5-11 位数字，不以 0 开头）')
    if (!rateLimit(`qqbind:${session.id}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
    const avatarUrl = await fetchQQAvatar(c.env, qq)
    await updateMemberQQ(c.env.DB, session.id, qq, avatarUrl, now)
    res.qq = qq
    if (avatarUrl) res.avatarUrl = avatarUrl
    else res.avatarFailed = true
  }

  return c.json(res)
})

api.post('/member/password', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  const session = await getMemberUser(c.env.DB, c.req.raw)
  if (!session) return jsonError('请先登录', 401)
  // PBKDF2 是慢操作：按 IP 限流防滥用（口径同 /member/login）
  if (!rateLimit(`mpwd:${clientIp(c.req.raw)}`, 10, 10 * 60_000)) return jsonError('尝试次数过多，请 10 分钟后再试', 429)
  const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>().catch(() => null)
  const current = String(body?.currentPassword || '')
  const next = String(body?.newPassword || '')
  if (next.length < 8 || next.length > 64) return jsonError('新密码长度需为 8-64 位')
  const row = await getMemberById(c.env.DB, session.id)
  if (!row) return jsonError('请先登录', 401)
  const { hash } = await hashPassword(current, row.salt)
  if (!safeEqual(hash, row.password_hash)) return jsonError('当前密码不正确')
  const { hash: newHash, salt: newSalt } = await hashPassword(next)
  await c.env.DB
    .prepare('UPDATE members SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?')
    .bind(newHash, newSalt, Date.now(), row.id)
    .run()
  // 改密即其他设备全部下线（当前会话保留——改密码的人自己不能被登出去）
  const token = getCookie(c.req.raw, MEMBER_SESSION_COOKIE) || ''
  await destroyOtherMemberSessions(c.env.DB, row.id, token)
  return c.json({ ok: true })
})

/* ---------------- 需要登录的 /admin/* ---------------- */
/* 注意：本中间件必须注册在所有 /admin/* 路由之前（hono 按注册顺序执行，路由先命中即终止链条） */
api.use('/admin/*', async (c, next) => {
  const user = await getSessionUser(c.env.DB, c.req.raw)
  if (!user) return jsonError('请先登录', 401)
  c.set('user', user)
  await next()
})

/* 多作者权限门槛（3.0-M1）：author 角色在管理面 403，内容面（posts/weibo/comments/uploads/pages/links 等）放行。
 * 白名单用前缀常量写死——权限面越少越安全，别做成可配置。admin 角色不受限。 */
const AUTHOR_ALLOWED_PREFIXES = [
  '/admin/posts',
  '/admin/weibo',
  '/admin/comments',
  '/admin/uploads',
  '/admin/media',
  '/admin/pages',
  '/admin/categories',
  '/admin/tags',
  '/admin/links',
  '/admin/upload',
  '/admin/og-image',
  // 编辑器内容辅助（MD 预览 / 粘贴净化 / 链接卡片 / 媒体搜索）：作者写文要用的同一批工具，
  // 全是内容面助手（无站点配置语义），不放行会让作者的编辑器预览与插卡静默 403
  '/admin/tools',
]
api.use('/admin/*', async (c, next) => {
  const user = c.get('user')
  if (user && user.role === 'author') {
    // c.req.path 在测试薄壳（api 子应用直调）与生产挂载（/api 前缀）下形态不同——规范化后再匹配
    const norm = c.req.path.startsWith('/api/') ? c.req.path.slice(4) : c.req.path
    const allowed = AUTHOR_ALLOWED_PREFIXES.some((p) => norm === p || norm.startsWith(p + '/'))
    if (!allowed) return jsonError('作者账号没有该管理面的权限（多作者权限矩阵见 docs/DEVPLAN-3.0.md）', 403)
  }
  await next()
})

/* 后台会员管理（PUT 缺键即保留，同 posts PUT 语义） */

/** 生成「某日期当天结束」的毫秒时间戳（北京时间口径）：后台日期输入 YYYY-MM-DD → 到期时刻。
 *  非法输入返回 null（调用方按「清除有效期」处理） */
function expiryDateToMs(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59) - 8 * 3600_000
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

api.get('/admin/members', async (c) => {
  const page = clampInt(c.req.query('page'), 1, 1_000_000, 1)
  const q = (c.req.query('q') || '').trim().slice(0, 50)
  const [list, settings] = await Promise.all([listMembersAdmin(c.env.DB, q, page), getSettings(c.env.DB)])
  // tiers 随列表下发：后台「分配档位」弹窗与档位角标直接用（自定义档位的事实源是 settings.memberTiers）
  return c.json({ ...list, tiers: parseMemberTiers(settings.memberTiers) })
})

api.put('/admin/members/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('会员不存在', 404)
  const body = await c.req.json<{ tier?: string; status?: string; tierExpiresAt?: unknown }>().catch(() => null)
  if (!body || typeof body !== 'object') return jsonError('请求格式错误')
  const settings = await getSettings(c.env.DB)
  const defs = parseMemberTiers(settings.memberTiers)
  const patch: { tier?: string; status?: string; tierExpiresAt?: number | null } = {}
  if ('tier' in body) {
    // 档位必须是自定义定义里的 key（脏值 400 不静默降级——与 contentVisibleRange 同口径）
    if (!tierByKey(defs, String(body.tier || ''))) return jsonError('未知档位')
    patch.tier = String(body.tier)
    // 分配永久档 = 清除有效期；分配限时档且未显式给有效期 = 保持旧值（缺键即保留语义）
    if (tierByKey(defs, patch.tier)?.permanent) patch.tierExpiresAt = null
  }
  if ('tierExpiresAt' in body) {
    // null = 清除（转永久）；数字 = 到期毫秒；'YYYY-MM-DD' 字符串 = 当天结束（北京时间）
    const v = body.tierExpiresAt
    if (v === null) patch.tierExpiresAt = null
    else if (typeof v === 'number' && Number.isFinite(v) && v > 0) patch.tierExpiresAt = Math.trunc(v)
    else if (typeof v === 'string' && v.trim()) {
      const ms = expiryDateToMs(v)
      if (!ms) return jsonError('有效期格式不对')
      patch.tierExpiresAt = ms
    } else return jsonError('有效期格式不对')
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'banned') return jsonError('未知状态')
    patch.status = body.status
  }
  if (!(await updateMemberAdmin(c.env.DB, id, patch))) return jsonError('会员不存在', 404)
  // 拉黑即踢下线（getMemberUser 查询层已挡 banned，这里把会话 token 一并清掉）
  if (patch.status === 'banned') await destroyMemberSessionsByMember(c.env.DB, id)
  return c.json({ ok: true })
})

/** 档位定义只读出口（编辑器「谁能看」等管理面用）：定义本体走设置 PUT 的 memberTiers 键 */
api.get('/admin/member-tiers', async (c) => {
  const settings = await getSettings(c.env.DB)
  return c.json({ tiers: parseMemberTiers(settings.memberTiers) })
})

/* 采集插件（公众号文章 → 草稿），见 src/collect.ts */
api.route('/admin/collect', collectRoutes)
api.route('/admin/export', exportRoutes)

/* 外部发布：开放 API / Telegram 机器人（自鉴权）与后台管理端点，见 src/external.ts */
api.route('/admin/external', adminExternalRoutes)
api.route('/external', externalRoutes)
api.route('/telegram', telegramRoutes)

/* ---------------- 两步验证 + 活跃会话（B13 管理员安全包） ---------------- */

api.post('/admin/totp/setup', async (c) => {
  const user = c.get('user')
  if (!rateLimit(`totp-setup:${clientIp(c.req.raw)}`, 5, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const secret = generateTotpSecret()
  // 只写 pending：已开启状态下重新绑定不降级（旧 secret 在 enable 成功前继续生效）；
  // saveSettings 自动换代页缓存 + invalidateSharedSettings（AGENTS「写了 settings 就要失效缓存」）
  await saveSettings(c.env.DB, { totpSecretPending: secret })
  const uri = totpProvisioningUri(secret, user.username)
  return c.json({ ok: true, secret, uri, qrSvg: qrSvgData(uri) })
})

api.post('/admin/totp/enable', async (c) => {
  if (!rateLimit(`totp-enable:${clientIp(c.req.raw)}`, 5, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const body = await c.req.json<{ code?: string }>().catch(() => null)
  const s = await getSettings(c.env.DB)
  if (!s.totpSecretPending) return jsonError('请先点「开始绑定」生成密钥')
  if (!(await verifyTotp(s.totpSecretPending, body?.code || ''))) return jsonError('验证码不对——请确认手机时间已同步，并用绑定页的密钥重算', 400)
  await saveSettings(c.env.DB, { totpSecret: s.totpSecretPending, totpEnabled: '1', totpSecretPending: '' })
  return c.json({ ok: true })
})

api.post('/admin/totp/disable', async (c) => {
  const user = c.get('user')
  if (!rateLimit(`totp-disable:${clientIp(c.req.raw)}`, 5, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const body = await c.req.json<{ password?: string }>().catch(() => null)
  const row = await c.env.DB.prepare('SELECT password_hash, salt FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string; salt: string }>()
  if (!row) return jsonError('账号不存在', 404)
  const { hash } = await hashPassword(body?.password || '', row.salt)
  if (!safeEqual(hash, row.password_hash)) return jsonError('登录密码不对', 400)
  await saveSettings(c.env.DB, { totpEnabled: '0', totpSecret: '', totpSecretPending: '' })
  return c.json({ ok: true })
})

/** 活跃会话列表（B13）：token 落库即 SHA-256（AGENTS「会话 token」节），出参的 tokenHash 不可逆可作撤销标识 */
api.get('/admin/sessions', async (c) => {
  const user = c.get('user')
  const currentHash = await tokenHash(getCookie(c.req.raw, SESSION_COOKIE) || '')
  const rows = await c.env.DB.prepare(
    'SELECT token, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC'
  )
    .bind(user.id, Date.now())
    .all<{ token: string; created_at: number; expires_at: number }>()
  const sessions = (rows.results ?? []).map((r) => ({
    tokenHash: r.token,
    isCurrent: r.token === currentHash,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }))
  return c.json({ ok: true, sessions })
})

/** 撤销其他设备会话（B13）：按 token_hash 删且限定 user_id；当前会话不许自撤（退出走「退出」按钮） */
api.delete('/admin/sessions', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ tokenHash?: string }>().catch(() => null)
  const target = String(body?.tokenHash || '')
  if (!/^[0-9a-f]{64}$/.test(target)) return jsonError('会话标识非法')
  const currentHash = await tokenHash(getCookie(c.req.raw, SESSION_COOKIE) || '')
  if (target === currentHash) return jsonError('当前会话不能在这里撤销——退出登录请用侧栏「退出」')
  const res = await c.env.DB.prepare('DELETE FROM sessions WHERE token = ? AND user_id = ?').bind(target, user.id).run()
  if (!res.meta.changes) return jsonError('会话不存在或已过期', 404)
  return c.json({ ok: true })
})

/* ---------------- 多作者（3.0-M1）：管理员创建作者账号 ---------------- */

api.post('/admin/authors', async (c) => {
  const user = c.get('user')
  if (user.role !== 'admin') return jsonError('只有站长（admin）可以创建作者账号', 403)
  if (!rateLimit(`authors:${clientIp(c.req.raw)}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const body = await c.req.json<{ username?: string; password?: string; displayName?: string }>().catch(() => null)
  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')
  const displayName = String(body?.displayName || '').trim().slice(0, 24)
  if (!/^[a-zA-Z0-9_-]{2,24}$/.test(username)) return jsonError('用户名需 2-24 位字母、数字、_ 或 -')
  if (password.length < 8 || password.length > 64) return jsonError('密码 8-64 位')
  const dup = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
  if (dup) return jsonError('用户名已被占用')
  const { hash, salt } = await hashPassword(password)
  const now = Date.now()
  let res
  try {
    res = await c.env.DB
      .prepare(
        "INSERT INTO users (username, password_hash, salt, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'author', ?, ?)"
      )
      .bind(username, hash, salt, displayName || username, now, now)
      .run()
  } catch (e) {
    // 前置查与写入之间有并发窗口，同名作者撞 users.username UNIQUE 回可读的 400 而不是 500
    if (e instanceof Error && /UNIQUE/i.test(e.message)) return jsonError('用户名已被占用')
    throw e
  }
  return c.json({ ok: true, author: { id: Number(res.meta.last_row_id), username, displayName: displayName || username, role: 'author' } })
})

api.get('/admin/authors', async (c) => {
  const user = c.get('user')
  if (user.role !== 'admin') return jsonError('只有站长（admin）可以查看作者列表', 403)
  const rows = await c.env.DB.prepare("SELECT id, username, display_name, role, created_at FROM users WHERE role = 'author' ORDER BY created_at DESC").all<{
    id: number
    username: string
    display_name: string
    role: string
    created_at: number
  }>()
  return c.json({ ok: true, authors: rows.results ?? [] })
})

api.get('/admin/stats', async (c) => {
  const db = c.env.DB
  const [pub, drafts, pending, uploads, recent, pendingLinks, weibo, pages, comments, members, settings] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(views),0) AS v, COALESCE(SUM(likes),0) AS l FROM posts WHERE status = 'published' AND deleted_at IS NULL")
      .first<{ n: number; v: number; l: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'draft' AND deleted_at IS NULL").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'").first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS s FROM uploads').first<{ n: number; s: number }>(),
    // 概览「最近文章」只要五个小列：SELECT * 会把正文大列整行拉回（每行多读上百倍字节）
    db.prepare("SELECT id, title, slug, views, published_at FROM posts WHERE status = 'published' AND deleted_at IS NULL ORDER BY published_at DESC LIMIT 5").all<{ id: number; title: string; slug: string; views: number; published_at: number | null }>(),
    db.prepare("SELECT COUNT(*) AS n FROM friend_links WHERE status = 'pending'").first<{ n: number }>(),
    // 系统状态卡（B12）：三张软删表按口径过滤 deleted_at（回收站行不计入体量）
    db.prepare('SELECT COUNT(*) AS n FROM weibo WHERE deleted_at IS NULL').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM comments').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM members').first<{ n: number }>(),
    getSettings(db),
  ])
  return c.json({
    // 系统版本（src/version.ts 镜像 package.json）：仅管理面出口，供概览「系统」卡展示
    version: APP_VERSION,
    posts: pub?.n ?? 0,
    views: pub?.v ?? 0,
    likes: pub?.l ?? 0,
    drafts: drafts?.n ?? 0,
    pendingComments: pending?.n ?? 0,
    pendingLinks: pendingLinks?.n ?? 0,
    uploads: { count: uploads?.n ?? 0, bytes: uploads?.s ?? 0 },
    db: { weibo: weibo?.n ?? 0, pages: pages?.n ?? 0, comments: comments?.n ?? 0, members: members?.n ?? 0 },
    // 备份状态由 backup.ts 每晚回写（lastBackupAt/lastBackupBytes），这里只读不查
    backup: {
      enabled: settings.backupEnabled !== '0',
      at: Number(settings.lastBackupAt) || 0,
      bytes: Number(settings.lastBackupBytes) || 0,
    },
    // 收录守卫（2026-10-17）：整站 noindex / 闭站会把本域名整体切出搜索引擎与 AI 的索引面，
    // 概览页据此常驻提醒（防手滑开了长期不自知——blog.bloghao.com 就是这么漏的）。
    // 演示站本就刻意 noindex，单独给 demo 标志让前台不误报。
    crawl: {
      noindex: settings.siteNoindex === '1',
      closed: settings.siteClosed === '1',
      demo: isDemo(c.env),
    },
    recent: (recent.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      views: r.views,
      published_at: r.published_at,
    })),
  })
})

/* 更新中心（自选更新）——按需抓官网发布的机器可读版本清单（src/update.ts），比对当前版本给出
 * 「更新了什么 / 优化了什么」，用户自己决定「更新到最新」还是「保持当前版本」。**不做任何自动
 * 更新**：这里只读清单 + 报状态，真正换版本靠一次部署动作（Cloudflare 重新部署 / Docker 重建，
 * 见 docs/UPDATING.md）。出网端点是固定可信地址（同 api.telegram.org 口径），仅 https、无用户
 * 输入进路径；响应按不可信输入严格校验，拿不到就降级为「暂不可检查」。演示站禁外发，直接短路 */
api.get('/admin/update', async (c) => {
  const current = APP_VERSION
  if (isDemo(c.env)) return c.json({ ok: true, checkable: false, reason: 'demo', current, guide: UPDATE_GUIDE_URL })
  const settings = await getSettings(c.env.DB)
  let manifest = null
  try {
    const res = await fetch(UPDATE_MANIFEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    })
    if (res.ok) manifest = validateUpdateManifest(await res.json().catch(() => null))
  } catch {
    /* 网络异常 / 超时 / 非 JSON：一律按「拿不到最新版本信息」降级，不打扰用户 */
  }
  if (!manifest) return c.json({ ok: true, checkable: false, reason: 'unreachable', current, guide: UPDATE_GUIDE_URL })
  return c.json({ ok: true, checkable: true, ...updateStatus(current, manifest, settings.updateIgnoredVersion || ''), guide: UPDATE_GUIDE_URL })
})

/* 访客统计（后台「统计」页），聚合见 src/stats.ts；bot 为爬虫/AI 抓取维度（src/bots.ts） */
api.get('/admin/visits', async (c) => {
  const days = clampInt(c.req.query('days'), 1, 365, 30)
  const [visits, bot] = await Promise.all([getVisitStats(c.env.DB, days), getBotStats(c.env.DB, days)])
  return c.json({ ...visits, bot })
})

/* ---------------- 文章管理 ---------------- */
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS)

/** 路由 :id 参数 → 正整数；非法返回 null（调用方 404），防 NaN 直传 D1 变 500 */
function parseId(raw: string | undefined): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function readPostPayload(c: { req: { json: () => Promise<unknown> } }) {
  const raw = await c.req.json().catch(() => null)
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const title = String(b.title ?? '').slice(0, 150).trim()
  const content = String(b.content ?? '')
  // 上限按 UTF-8 字节数（与常量名、collect 一致）：100 万个 CJK 字符实际可存 ~3MB
  if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) return { tooBig: true as const }
  const status = b.status === 'published' ? 'published' : b.status === 'scheduled' ? 'scheduled' : 'draft'
  // 定时发布目标时间（毫秒）：不填或非法时由 PUT 沿用旧值；已过去的时间等价于「到点即发」。
  // 上限钳制在 [-24h, +5y]：防 1e300 之类异常值入库（超出 int64，定时扫描永不命中卡死在 scheduled）
  const rawPublishAt = Number(b.publishAt)
  const publishAt =
    Number.isFinite(rawPublishAt) && rawPublishAt > 0
      ? Math.floor(Math.min(Math.max(rawPublishAt, Date.now() - 86_400_000), Date.now() + 5 * 365 * 86_400_000))
      : null
  // PUT 部分更新语义：字段缺失 ≠ 空值。文章列表接口不带回 content/tags/categoryId，
  // 列表页的状态切换只发 {status}——缺这些键时 PUT 必须保留旧值而不是清空（has 记录来源）
  const has = {
    title: 'title' in b,
    slug: 'slug' in b,
    content: 'content' in b,
    summary: 'summary' in b,
    cover: 'cover' in b,
    tags: 'tags' in b,
    status: 'status' in b,
    pinned: 'pinned' in b,
    categoryId: 'categoryId' in b,
    minTier: 'minTier' in b,
    password: 'password' in b,
    aiGenerated: 'aiGenerated' in b,
  }
  const tags = Array.isArray(b.tags)
    ? b.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().slice(0, 20))
        .filter(Boolean)
        .slice(0, 8)
    : []
  const cover = String(b.cover ?? '').slice(0, 500)
  const rawCategoryId = b.categoryId
  const categoryId =
    rawCategoryId == null || rawCategoryId === '' ? null : Number.isFinite(Number(rawCategoryId)) ? Number(rawCategoryId) : null
  return {
    title,
    content,
    summary: String(b.summary ?? '').slice(0, 500),
    cover: cover.startsWith('/') || /^https?:\/\//i.test(cover) ? cover : '',
    tags,
    status,
    pinned: b.pinned ? 1 : 0,
    // 自定义 slug 清洗：只留字母/数字/中文/_/-，空白转连字符，防坏链与异常路由
    slug: cleanSlug(String(b.slug ?? '')),
    categoryId,
    publishAt,
    // 可见档位（契约 DEVPLAN 附录 A A7）：脏值归一为 all
    minTier: normalizeMinTier(typeof b.minTier === 'string' ? b.minTier : null),
    // 访问密码（src/protect.ts）：仅在键存在时参与写入；空串 = 解除加密，缺键 = 保持现状。
    // 明文只在本次请求内存在，落库前即转 PBKDF2，响应里永远只有 hasPassword 布尔
    password: String(b.password ?? '').slice(0, 64),
    // AI 生成标注（编辑器「更多」自愿申报）：缺键 = 保持现状（列表页状态切换的 {status} 载荷不会误清）
    aiGenerated: b.aiGenerated ? 1 : 0,
    has,
  }
}

// 服务端插件列表（后台「插件」页展示与启停，见 src/hooks.ts）
api.get('/admin/server-plugins', (c) => c.json({ plugins: listServerPlugins() }))

/* 广场数据卡（B25 P2.3）：后台「插件 → 广场同步」的「数据」按钮拉 hub /api/site-stats。
 * 站点 token 服务端代理（不出浏览器网络面板，demo 短路与其他外呼工具同口径）；
 * hub 地址走 plazaEndpoint（留空 = 官方 hub）。传 502 让前台展示「hub 连不上」而非 500 */
api.get('/admin/plaza-stats', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放广场数据卡', 404)
  const settings = await getSettings(c.env.DB)
  const token = (settings.plazaToken || '').trim()
  if (!token) return jsonError('还没填广场站点 Token（设置 → 服务端插件）')
  const endpoint = (settings.plazaEndpoint || PLAZA_OFFICIAL_HUB).trim().replace(/\/+$/, '')
  // 运行时复核公网地址并走 fetchPublicResource 逐跳复查（裸 fetch 自动跟跳是 SSRF 面，
  // 与出网安全防线同口径；也兜住配置被旁路写脏的形态——落库校验不是最后防线）
  const target = fetchableUrl(`${endpoint}/api/site-stats`)
  if (!target) return jsonError('广场地址无效（需公网 https 地址）', 502)
  const r = await fetchPublicResource(target.href, {
    maxBytes: 256 * 1024,
    timeoutMs: 10_000,
    headers: { 'x-plaza-token': token },
  })
  // fetchPublicResource 失败一律 null（网络异常与非 2xx 不区分），文案合并保证可行动
  if (!r) return jsonError('广场 hub 连不上或 Token 无效，请检查 Token 后稍后再试', 502)
  try {
    return c.json(JSON.parse(new TextDecoder().decode(r.buf)) as Record<string, unknown>)
  } catch {
    return jsonError('广场 hub 返回异常，稍后再试', 502)
  }
})

/* ---------------- 编辑器插件远程安装（B8 插件半边，机制 src/pluginpkg.ts） ----------------
 * 安装 = 抓 https 插件文件 → 内容安检 → 落 R2 → 登记 settings.pluginsInstalled；
 * 下发走 /plugins/installed.json 与 /plugin-files/:id（index.ts，管理员会话门槛）。
 * 演示站短路（装包是任意 JS 入口，凭据公示的体验站不开）。 */

api.post('/admin/plugins/install', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放插件安装', 404)
  if (!rateLimit(`plugin-install:${clientIp(c.req.raw)}`, 5, 60_000)) return jsonError('安装太频繁，请一分钟后再试', 429)
  const body = await c.req.json<{ url?: string; id?: string }>().catch(() => null)
  const url = String(body?.url ?? '').trim().slice(0, 2048)
  if (!/^https:\/\//i.test(url) || !fetchableUrl(url)) return jsonError('插件地址无效（需公网 https 地址）')
  const r = await fetchPublicResource(url, { maxBytes: PLUGIN_SRC_MAX_BYTES, timeoutMs: 15_000 })
  const src = r ? new TextDecoder().decode(r.buf) : ''
  if (!sanityCheckPluginSource(src)) return jsonError('插件文件抓取失败或内容不合法（需 ≤ 256KB 的文本 JS，且调用 registerPlugin）')
  const derived =
    cleanPluginId(String(body?.id ?? '').trim()) ||
    cleanPluginId((url.split('/').pop() || '').replace(/\.js$/i, ''))
  if (!derived) return jsonError('插件 id 只能包含字母、数字、_ 或 -（从地址文件名推导失败，请显式传 id）')
  await c.env.IMAGES.put(pluginFileKey(derived), src, {
    httpMetadata: { contentType: 'application/javascript; charset=utf-8' },
  })
  const bytes = new TextEncoder().encode(src).length
  const list = upsertInstalled(readInstalled((await getSettings(c.env.DB)).pluginsInstalled), {
    id: derived,
    url,
    at: Date.now(),
    bytes,
  })
  await saveSettings(c.env.DB, { pluginsInstalled: JSON.stringify(list) })
  return c.json({ ok: true, id: derived, bytes })
})

api.post('/admin/plugins/uninstall', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放插件卸载', 404)
  const body = await c.req.json<{ id?: string }>().catch(() => null)
  const id = cleanPluginId(String(body?.id ?? ''))
  if (!id) return jsonError('插件 id 不合法')
  const list = removeInstalled(readInstalled((await getSettings(c.env.DB)).pluginsInstalled), id)
  await c.env.IMAGES.delete(pluginFileKey(id))
  await saveSettings(c.env.DB, { pluginsInstalled: JSON.stringify(list) })
  return c.json({ ok: true })
})

api.get('/admin/plugins/installed', async (c) => {
  return c.json({ plugins: readInstalled((await getSettings(c.env.DB)).pluginsInstalled) })
})

api.get('/admin/posts', async (c) => {
  const statusParam = c.req.query('status')
  const status = statusParam === 'published' || statusParam === 'draft' || statusParam === 'scheduled' ? statusParam : 'all'
  const r = await listPosts(c.env.DB, {
    status,
    q: c.req.query('q') || undefined,
    page: clampInt(c.req.query('page'), 1, 1000, 1),
    limit: clampInt(c.req.query('limit'), 1, 100, 20),
    // 时间范围：客户端只传白名单语义值（3d/1m/6m/1y），cutoff 在服务端算——时间戳不可注入
    afterTs: listRangeCutoff(c.req.query('range')),
  })
  const catNames = await categoryNameMap(c.env.DB, r.items.map((p) => p.id))
  return c.json({
    items: r.items.map((p) => ({
      ...postAdminView(p),
      content: undefined,
      tagList: parseTags(p),
      categoryName: catNames.get(p.id) || '',
    })),
    total: r.total,
    page: r.page,
    totalPages: r.totalPages,
  })
})

api.post('/admin/posts', async (c) => {
  const p = await readPostPayload(c)
  if (!p) return jsonError('请求格式错误')
  if ('tooBig' in p) return jsonError('正文过长（上限约 1MB）')
  // 定时发布必须带时间（编辑器有校验，这里拦 API 直调）——否则 publish_at 落 NULL，
  // scheduler 只扫有时间的行，该文会无提示地永远卡在 scheduled
  if (p.status === 'scheduled' && p.publishAt == null) return jsonError('定时发布必须填写发布时间')
  const title = p.title || '无标题'
  const base = p.slug || slugify(title)
  const slug = await uniqueSlug(c.env.DB, base)
  const now = Date.now()
  // 访问密码：随创建一并写入（空 = 不加密）
  const passwordHash = p.password ? await hashPostPassword(p.password) : ''
  // 自动摘要取净化后的正文（与 PUT 更新同口径：粘贴内容里的标签/实体不进导读面）
  const clean = sanitizeHtml(p.content)
  const res = await c.env.DB.prepare(
    `INSERT INTO posts (slug, title, content, summary, cover, tags, status, pinned, author_id, published_at, publish_at, min_tier, password_hash, ai_generated, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      slug,
      title,
      clean,
      // 密码文的自动摘要留空：summary 列是对外导读面（RSS description / meta / 公开列表），
      // 不能拿加密正文截前 80 字泄出去；作者手填的摘要照常保留（作者主动公开的导读）
      p.summary || (passwordHash ? '' : excerpt(clean, 80)),
      p.cover,
      JSON.stringify(p.tags),
      p.status,
      p.pinned,
      c.get('user').id,
      p.status === 'published' ? now : null,
      p.status === 'scheduled' ? (p.publishAt ?? null) : null,
      p.minTier,
      passwordHash,
      p.aiGenerated,
      now,
      now
    )
    .run()
  const row = await getPostById(c.env.DB, Number(res.meta.last_row_id))
  if (p.categoryId != null && row) {
    const cat = await getCategoryById(c.env.DB, p.categoryId)
    if (cat) await setPostCategory(c.env.DB, row.id, cat.id)
  }
  // 广播发布事件（服务端插件钩子，见 src/hooks.ts）：新建即发布也算跃迁
  if (p.status === 'published' && row) {
    c.executionCtx.waitUntil(
      firePostPublished(c.env, {
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        via: 'admin',
        // 加密/会员锁文标志：广场同步插件据此跳过（防泄漏清单同口径）
        locked: !!row.password_hash || (!!row.min_tier && row.min_tier !== 'all'),
      })
    )
  }
  const categoryId = row ? await getPostCategoryId(c.env.DB, row.id) : null
  return c.json({ ok: true, post: row ? { ...postAdminView(row), tagList: parseTags(row), categoryId } : null })
})

/** 站内文章选择器（编辑器「插入站内文章」）：轻出参——只给标题/slug/摘要/封面/时间，
 *  无正文无口令；q 走 likePattern 模糊匹配标题（与后台列表搜索同口径） */
api.get('/admin/posts/lookup', async (c) => {
  const q = (c.req.query('q') || '').trim().slice(0, 50)
  const page = clampInt(c.req.query('page'), 1, 1000, 1)
  const r = await listPosts(c.env.DB, { status: 'published', q: q || undefined, page, limit: 8 })
  return c.json({
    items: r.items.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      summary: (p.summary || '').slice(0, 80),
      cover: p.cover || '',
      published_at: p.published_at,
      hasPassword: !!p.password_hash,
      minTier: normalizeMinTier(p.min_tier),
    })),
    total: r.total,
    page: r.page,
    totalPages: r.totalPages,
  })
})

api.get('/admin/posts/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('文章不存在', 404)
  const row = await getPostById(c.env.DB, id)
  if (!row) return jsonError('文章不存在', 404)
  const categoryId = await getPostCategoryId(c.env.DB, row.id)
  return c.json({ post: { ...postAdminView(row), tagList: parseTags(row), categoryId } })
})

api.put('/admin/posts/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('文章不存在', 404)
  const existing = await getPostById(c.env.DB, id)
  if (!existing) return jsonError('文章不存在', 404)
  const p = await readPostPayload(c)
  if (!p) return jsonError('请求格式错误')
  if ('tooBig' in p) return jsonError('正文过长（上限约 1MB）')
  // 缺键即保留（编辑器恒发全量；列表页状态切换只发 status——缺 content/tags 等键时不能清空）
  const title = p.has.title ? p.title || '无标题' : existing.title
  // slug 变更时把旧值追加进 old_slugs（B22）：旧地址此后永久 301 到新地址；缺键即保留语义下不追加
  const slugChanged = !!(p.has.slug && p.slug && p.slug !== existing.slug)
  const slug = slugChanged ? await uniqueSlug(c.env.DB, p.slug, id) : existing.slug
  const oldSlugs = slugChanged ? appendOldSlug(existing.old_slugs, existing.slug, slug) : existing.old_slugs || '[]'
  const content = p.has.content ? sanitizeHtml(p.content) : existing.content
  // status 先解析（部分更新语义：缺键沿用库里状态），summary 兜底按解析后的状态算，别用 payload 默认值。
  // 密码文的自动摘要同样留空（同 POST 创建口径）：summary 是公开导读面，加密正文不出前 80 字
  const status = p.has.status ? p.status : existing.status
  const willLock = p.has.password ? !!p.password : !!existing.password_hash
  let summary = p.has.summary ? p.summary || (willLock ? '' : status === 'published' ? excerpt(content, 80) : '') : existing.summary
  // 密码文只出作者自填摘要（防泄漏清单）：编辑器恒回传 summary（预填旧自动摘要）会短路上面的
  // 清空逻辑——发布后补设密码时，残留的自动摘要（=正文前 80 字）会继续从 RSS/meta/列表泄漏。
  // 与旧正文 excerpt 比对（覆盖「改正文+加密码同请求」），命中即清；手填恰好撞上自动摘要也会
  // 被（无法区分、误伤方向更安全）；不限定「本次新设」，存量泄漏行在下次保存时自愈
  if (willLock && summary && summary === excerpt(existing.content, 80)) summary = ''
  const cover = p.has.cover ? p.cover : existing.cover
  const tags = p.has.tags ? JSON.stringify(p.tags) : existing.tags
  const pinned = p.has.pinned ? p.pinned : existing.pinned
  const minTier = p.has.minTier ? p.minTier : normalizeMinTier(existing.min_tier)
  // 草稿也保留已有 published_at：采集插件会把原文发布时间写入草稿，
  // 自动保存不能把它抹掉；发布时若草稿已有时间则沿用。
  // publish_at 只在 scheduled 状态下有意义：定时保存写入目标时间，
  // 转发布/草稿时清空；scheduled 但没给时间则保留旧值（自动保存场景）
  const publishedAt = status === 'published' ? (existing.published_at ?? Date.now()) : existing.published_at
  const publishAt = status === 'scheduled' ? (p.publishAt ?? existing.publish_at ?? null) : null
  // scheduled 但新旧都没有时间：拒绝而不是落 NULL 卡死在定时态（编辑器有校验，这里拦 API 直调）
  if (status === 'scheduled' && publishAt == null) return jsonError('定时发布必须填写发布时间')
  // 访问密码：键存在才参与（空串解除、非空设置/更换），缺键保持原值——自动安全永远不误清
  const passwordHash = p.has.password ? (p.password ? await hashPostPassword(p.password) : '') : existing.password_hash || ''
  // AI 生成标注：同缺键即保留口径（列表页只发 {status} 的 PUT 不得误清）
  const aiGenerated = p.has.aiGenerated ? p.aiGenerated : (existing.ai_generated ?? 0)
  await c.env.DB.prepare(
    `UPDATE posts SET slug = ?, old_slugs = ?, title = ?, content = ?, summary = ?, cover = ?, tags = ?, status = ?, pinned = ?, published_at = ?, publish_at = ?, min_tier = ?, password_hash = ?, ai_generated = ?, updated_at = ? WHERE id = ?`
  )
    .bind(
      slug,
      oldSlugs,
      title,
      content,
      summary,
      cover,
      tags,
      status,
      pinned,
      publishedAt,
      publishAt,
      minTier,
      passwordHash,
      aiGenerated,
      Date.now(),
      id
    )
    .run()
  // 编辑已发布文章 → 页面边缘缓存整代作废（发布/下架广播只覆盖状态跃迁，重复编辑已发布
  // 不触发任何广播；草稿自动保存不进这个分支，省无谓的全站换代）
  if (existing.status === 'published') c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  const row = await getPostById(c.env.DB, id)
  if (p.categoryId != null) {
    const cat = await getCategoryById(c.env.DB, p.categoryId)
    if (cat) await setPostCategory(c.env.DB, id, cat.id)
  } else if (p.has.categoryId) {
    // 显式传了 null/空 = 清除分类；完全没传这个键 = 保持现有分类不动
    await setPostCategory(c.env.DB, id, null)
  }
  const categoryId = await getPostCategoryId(c.env.DB, id)
  // 编辑已发布且仍是发布态 → 广播更新事件（IndexNow 类「编辑也让搜索引擎重抓」接这个槽；
  // 转草稿/定时与锁文跃迁在下面的下架广播里，不重复报）
  if (status === 'published' && existing.status === 'published' && row) {
    c.executionCtx.waitUntil(firePostUpdated(c.env, { slug: row.slug, title: row.title, via: 'admin' }))
  }
  // 广播发布事件：只在草稿/定时 → 已发布的跃迁时触发，重复编辑已发布文章不重推
  if (status === 'published' && existing.status !== 'published' && row) {
    c.executionCtx.waitUntil(
      firePostPublished(c.env, {
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        via: 'admin',
        // 加密/会员锁文标志：广场同步插件据此跳过（防泄漏清单同口径）
        locked: !!row.password_hash || (!!row.min_tier && row.min_tier !== 'all'),
      })
    )
  }
  // 广场下架广播（条目生命周期闭环）：已发布文章转出发布态、或补设密码/升档锁文时，
  // 把条目从 hub 摘除（ref 用 existing.slug——hub 收录的是改 slug 前的旧引用）；
  // 解锁/恢复发布后 pull 会自愈补回
  if (
    existing.status === 'published' &&
    row &&
    (status !== 'published' ||
      (!!passwordHash && !existing.password_hash) ||
      (minTier !== 'all' && normalizeMinTier(existing.min_tier) === 'all'))
  ) {
    c.executionCtx.waitUntil(firePlazaRetract(c.env, [{ kind: 'post', ref: existing.slug }]))
  }
  return c.json({ ok: true, post: row ? { ...postAdminView(row), tagList: parseTags(row), categoryId } : null })
})

api.post('/admin/posts/:id/pin', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('文章不存在', 404)
  const body = await c.req.json<{ pinned?: boolean }>().catch(() => null)
  // 与 weibo 置顶同口径：存在性检查（不存在的 id 不能假装 ok）+ 草稿拒绝；
  // 多篇文章可同时置顶是产品语义，不加 weibo 的单置顶占位
  const existing = await getPostById(c.env.DB, id)
  if (!existing) return jsonError('文章不存在', 404)
  if (body?.pinned && !existing.pinned && existing.status !== 'published') return jsonError('草稿不能置顶，先发布吧')
  await c.env.DB.prepare('UPDATE posts SET pinned = ?, updated_at = ? WHERE id = ?')
    .bind(body?.pinned ? 1 : 0, Date.now(), id)
    .run()
  // 置顶改变首页/列表排序 → 页面边缘缓存整代作废（weibo 置顶同口径）
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

api.delete('/admin/posts/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('文章不存在', 404)
  // 软删进回收站（src/trash.ts）：评论与分类关联保留，恢复时一并跟回；彻底删除才级联清掉
  const row = await c.env.DB.prepare('SELECT slug, title FROM posts WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ slug: string; title: string }>()
  await c.env.DB.prepare('UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(Date.now(), id).run()
  // 广场下架广播：软删后 RSS 里不再有这条，hub 若曾收录会永久滞留——deleted 同步摘除
  if (row?.slug) {
    c.executionCtx.waitUntil(firePlazaRetract(c.env, [{ kind: 'post', ref: row.slug }]))
    // 删除事件广播（通用出站 Webhook 等同步类插件消费；内置 purge 幂等兜底）
    c.executionCtx.waitUntil(firePostDeleted(c.env, { slug: row.slug, title: row.title, via: 'admin' }))
  }
  return c.json({ ok: true })
})

/* ---------------- 微博管理（随手记） ---------------- */
const WEIBO_MAX_PINNED = 3

async function readWeiboPayload(c: { req: { json: () => Promise<unknown> } }) {
  const raw = await c.req.json().catch(() => null)
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const content = String(b.content ?? '').trim().slice(0, WEIBO_MAX_CHARS)
  const video = readWeiboVideoField(b)
  if (video === 'bad') return null
  return {
    content,
    // 话题从正文 #话题（或成对 #话题#）自动提取，不接受客户端直传
    topics: extractWeiboTopics(content),
    images: parseWeiboImages(b.images),
    video,
    status: b.status === 'published' ? 'published' : 'draft',
  }
}

/** 微博视频字段（B19）：缺键 = undefined（保留原值）——前台卡片编辑与后台旧调用点只发
 *  content+images+status，全量覆盖语义会把已有视频静默清掉；null / 空串 = 清除；
 *  其余必须是合法视频对象，非法回 'bad'（端点整体 400：宁可不保存，也不悄悄清视频）。
 *  「一条微博最多 1 个视频」由单值字段本身 + 前端入口共同保证。 */
function readWeiboVideoField(b: Record<string, unknown>): WeiboVideoView | null | undefined | 'bad' {
  if (!('video' in b)) return undefined
  const v = b.video
  if (v === null || v === '') return null
  return parseWeiboVideo(v) ?? 'bad'
}

api.get('/admin/weibo', async (c) => {
  const statusParam = c.req.query('status')
  const status = statusParam === 'published' || statusParam === 'draft' ? statusParam : 'all'
  const r = await listWeibo(c.env.DB, {
    status,
    page: clampInt(c.req.query('page'), 1, 1000, 1),
    limit: clampInt(c.req.query('limit'), 1, 100, 20),
    pinnedFirst: true,
    // 时间范围：客户端只传白名单语义值（3d/1m/6m/1y），cutoff 在服务端算——时间戳不可注入
    afterTs: listRangeCutoff(c.req.query('range')),
  })
  const cmtCounts = await weiboCommentCountMap(c.env.DB, r.items.map((w) => w.id))
  return c.json({
    items: r.items.map((w) => ({
      ...w,
      imageList: weiboImageList(w),
      topicList: weiboTopicList(w),
      videoView: weiboVideoView(w),
      commentCount: cmtCounts.get(w.id) || 0,
    })),
    total: r.total,
    page: r.page,
    totalPages: r.totalPages,
  })
})

/* 单条取原稿（前台卡片「编辑」用：正文要拿未转义原文，DOM 里的渲染文本反解不可靠） */
api.get('/admin/weibo/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('这条微博不存在', 404)
  const row = await getWeiboById(c.env.DB, id)
  if (!row) return jsonError('这条微博不存在', 404)
  return c.json({ weibo: { ...row, imageList: weiboImageList(row), topicList: weiboTopicList(row), videoView: weiboVideoView(row) } })
})

api.post('/admin/weibo', async (c) => {
  const p = await readWeiboPayload(c)
  if (!p) return jsonError('请求格式错误')
  if (!p.content && !p.images.length && !p.video) return jsonError('写点什么，或者配张图 / 加段视频吧')
  const now = Date.now()
  const res = await c.env.DB.prepare(
    'INSERT INTO weibo (content, images, video, topics, status, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      p.content,
      JSON.stringify(p.images),
      p.video ? JSON.stringify(p.video) : '',
      JSON.stringify(p.topics),
      p.status,
      p.status === 'published' ? now : null,
      now,
      now
    )
    .run()
  const row = await getWeiboById(c.env.DB, Number(res.meta.last_row_id))
  // 微博总数记账位（settings.wbPubCount）：listWeibo 分页 COUNT 的读放大治理，见 db.ts
  if (p.status === 'published') await bumpWeiboCount(c.env.DB, 1)
  // 广播微博发布事件（服务端插件钩子，见 src/hooks.ts）：新建即发布才算
  if (p.status === 'published' && row) {
    c.executionCtx.waitUntil(
      fireWeiboPublished(c.env, { id: row.id, content: row.content, images: weiboImageList(row), video: weiboVideoView(row) ?? undefined, via: 'admin' })
    )
  }
  return c.json({ ok: true, weibo: row ? { ...row, imageList: weiboImageList(row), topicList: weiboTopicList(row), videoView: weiboVideoView(row) } : null })
})

api.put('/admin/weibo/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('这条微博不存在', 404)
  const existing = await getWeiboById(c.env.DB, id)
  if (!existing) return jsonError('这条微博不存在', 404)
  const p = await readWeiboPayload(c)
  if (!p) return jsonError('请求格式错误')
  if (!p.content && !p.images.length && !p.video) return jsonError('写点什么，或者配张图 / 加段视频吧')
  const publishedAt = p.status === 'published' ? (existing.published_at ?? Date.now()) : null
  // 转回草稿时自动取消置顶
  const pinned = p.status === 'published' ? existing.pinned : 0
  // video 缺键即保留（undefined）：老调用点不发这个键，不能把已有视频清掉
  const video = p.video === undefined ? existing.video : p.video ? JSON.stringify(p.video) : ''
  await c.env.DB.prepare(
    'UPDATE weibo SET content = ?, images = ?, video = ?, topics = ?, status = ?, pinned = ?, published_at = ?, updated_at = ? WHERE id = ?'
  )
    .bind(p.content, JSON.stringify(p.images), video, JSON.stringify(p.topics), p.status, pinned, publishedAt, Date.now(), id)
    .run()
  // 微博总数记账位：状态跃迁才增减（草稿→发布 +1，发布→草稿 -1），原状态不变不扰
  if (p.status === 'published' && existing.status !== 'published') await bumpWeiboCount(c.env.DB, 1)
  else if (existing.status === 'published' && p.status !== 'published') await bumpWeiboCount(c.env.DB, -1)
  // 编辑已发布微博（含转回草稿）→ 页面边缘缓存作废；草稿→发布的跃迁由 fireWeiboPublished 附带清理
  if (existing.status === 'published') c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  const row = await getWeiboById(c.env.DB, id)
  // 广播微博发布事件（服务端插件钩子，见 src/hooks.ts）：仅草稿 → 发布的跃迁，编辑已发布微博不触发
  if (p.status === 'published' && row && existing.status !== 'published') {
    c.executionCtx.waitUntil(
      fireWeiboPublished(c.env, { id: row.id, content: row.content, images: weiboImageList(row), video: weiboVideoView(row) ?? undefined, via: 'draft' })
    )
  }
  return c.json({ ok: true, weibo: row ? { ...row, imageList: weiboImageList(row), topicList: weiboTopicList(row), videoView: weiboVideoView(row) } : null })
})

api.post('/admin/weibo/:id/pin', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('这条微博不存在', 404)
  const body = await c.req.json<{ pinned?: boolean }>().catch(() => null)
  const existing = await getWeiboById(c.env.DB, id)
  if (!existing) return jsonError('这条微博不存在', 404)
  if (body?.pinned && !existing.pinned) {
    if (existing.status !== 'published') return jsonError('草稿不能置顶，先发布吧')
    // 条件更新原子占位：并发置顶时只有凑满名额的那次生效（count-then-update 有竞态窗口）；
    // 名额统计排除回收站行，已删微博不占坑
    const res = await c.env.DB.prepare(
      `UPDATE weibo SET pinned = 1, updated_at = ? WHERE id = ?
       AND (SELECT COUNT(*) FROM weibo WHERE pinned = 1 AND deleted_at IS NULL AND id != ?) < ?`
    )
      .bind(Date.now(), id, id, WEIBO_MAX_PINNED)
      .run()
    if ((res.meta.changes ?? 0) !== 1) return jsonError(`最多置顶 ${WEIBO_MAX_PINNED} 条微博，先取消一条吧`)
    c.executionCtx.waitUntil(purgePageCache(c.env.DB))
    return c.json({ ok: true })
  }
  await c.env.DB.prepare('UPDATE weibo SET pinned = ?, updated_at = ? WHERE id = ?')
    .bind(body?.pinned ? 1 : 0, Date.now(), id)
    .run()
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

api.delete('/admin/weibo/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('这条微博不存在', 404)
  // 微博总数记账位：条件增减按「本语句执行时刻」求值，必须排在软删**之前**（删后行就不是
  // published 存活态了，EXISTS 判不中）；行非已发布时自动 no-op
  await bumpWeiboCountById(c.env.DB, -1, id)
  // 软删进回收站（src/trash.ts）：评论保留，恢复时一并跟回；彻底删除才级联清掉
  await c.env.DB.prepare('UPDATE weibo SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(Date.now(), id).run()
  // 广场下架广播：微博若曾同步 hub（ref = 微博 id），软删后摘除（未收录时 hub 空删幂等）
  c.executionCtx.waitUntil(firePlazaRetract(c.env, [{ kind: 'weibo', ref: String(id) }]))
  // 删除事件广播（通用出站 Webhook 等同步类插件消费）
  c.executionCtx.waitUntil(fireWeiboDeleted(c.env, { id, via: 'admin' }))
  return c.json({ ok: true })
})

/** 服务端插件「微博同步 Buffer」的渠道拉取：设置页一键填充渠道 ID（src/hooks.ts listBufferChannels） */
api.post('/admin/buffer/channels', async (c) => {
  // 演示站禁外发：Buffer 渠道拉取是出网请求，demo 下不存在（体验者填的 Key 不能打出去）
  if (isDemo(c.env)) return jsonError('演示站不开放服务端插件外呼', 404)
  const body = await c.req.json<{ token?: string }>().catch(() => null)
  // token 缺省时用已保存的（打码占位符提交 = 保持原值，与 SECRET_SETTINGS 同口径）
  const saved = (await getSettings(c.env.DB)).bufferAccessToken || ''
  const token = (body?.token || '').trim()
  const using = token || (saved && saved !== SECRET_MASK ? saved : '')
  if (!using) return jsonError('先填写 Buffer API Key，再拉取渠道')
  const r = await listBufferChannels(using)
  if (!r.ok) return jsonError(r.error, 502)
  return c.json({ ok: true, channels: r.channels })
})

/* ---------------- 友情链接管理 ---------------- */
const LINK_ICON_MAX_BYTES = 300 * 1024
const ICON_FETCH_UA = 'Mozilla/5.0 (compatible; BlogHaoBot/1.0; +https://github.com/bloghao/bloghao)'

/** 校验友链图标地址：只收站内 /images/ 与 http(s) 外链，防 javascript: 注入 */
function normalizeLinkIcon(input: unknown): string {
  const s = String(input ?? '').trim().slice(0, 500)
  return s.startsWith('/images/') || /^https?:\/\//i.test(s) ? s : ''
}

async function readLinkPayload(c: { req: { json: () => Promise<unknown> } }) {
  const raw = await c.req.json().catch(() => null)
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  return {
    name: String(b.name ?? '').trim().slice(0, 40),
    url: normalizeLinkUrl(String(b.url ?? '')),
    description: String(b.description ?? '').trim().slice(0, 120),
    icon: normalizeLinkIcon(b.icon),
    status: b.status === 'pending' ? 'pending' : 'approved',
    sort: clampInt(b.sort, 0, 9999, 0),
  }
}

/** 把抓到的 favicon 存进 R2 图床，返回站内地址；类型/大小不对或抓取失败返回空串 */
async function storeLinkIcon(env: Env, iconUrl: string, host: string): Promise<string> {
  try {
    // 出网统一走 fetchsafe（iconUrl 可能来自管理员手填或第三方页面 <link> 解析）：
    // 私网拒绝 + 重定向逐跳复查 + 流式限长；超限/超时/非 2xx 一律按抓不到处理
    const r = await fetchPublicResource(iconUrl, {
      maxBytes: LINK_ICON_MAX_BYTES,
      timeoutMs: 6000,
      headers: { 'user-agent': ICON_FETCH_UA },
    })
    if (!r || !r.buf.byteLength) return ''
    const buf = r.buf
    // 只认文件魔数、不信任源站 Content-Type（同 collect 转存口径）：favicon 常是 ICO（sniffImageExt 不认），单独判魔数
    const h = new Uint8Array(buf, 0, Math.min(4, buf.byteLength))
    const ext = h[0] === 0 && h[1] === 0 && h[2] === 1 && h[3] === 0 ? 'ico' : sniffImageExt(buf)
    if (!ext) return ''
    const mime = ext === 'ico' ? 'image/x-icon' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
    const key = `u/fav/${host.replace(/[^a-z0-9.-]/gi, '')}.${ext}`
    await env.IMAGES.put(key, buf, {
      // 短 TTL（2026-10-15 审计 F2）：这个键会被 refresh-icon 原地覆盖（非内容寻址），
      // 长 immutable 会让换图标后边缘与浏览器长期取旧图；1 天 + /images 尊重对象头
      httpMetadata: { contentType: mime, cacheControl: 'public, max-age=86400' },
    })
    return `/images/${key}`
  } catch {
    return ''
  }
}

/** 到目标站抓图标：先试 /favicon.ico，再解析首页 <link rel="…icon…"> 兜底 */
async function fetchLinkIcon(env: Env, siteUrl: string): Promise<string> {
  let origin = ''
  let host = ''
  try {
    const u = new URL(siteUrl)
    origin = u.origin
    host = u.host
  } catch {
    return ''
  }
  const direct = await storeLinkIcon(env, `${origin}/favicon.ico`, host)
  if (direct) return direct
  try {
    // 首页 HTML 抓取同走 fetchsafe；上限给足常见站点页面（读不动的超大页按抓不到处理）
    const r = await fetchPublicResource(origin + '/', {
      maxBytes: 2_000_000,
      timeoutMs: 6000,
      headers: { 'user-agent': ICON_FETCH_UA, accept: 'text/html' },
    })
    if (r) {
      const html = new TextDecoder().decode(r.buf).slice(0, 200_000)
      const tag = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i)?.[0]
      const href = tag?.match(/href=["']([^"']+)["']/i)?.[1]
      if (href) return storeLinkIcon(env, new URL(href, r.res.url || origin).toString(), host)
    }
  } catch {
    /* 超时 / 网络不通，按拿不到处理 */
  }
  return ''
}

api.get('/admin/links', async (c) => {
  const statusParam = c.req.query('status')
  const status = statusParam === 'approved' || statusParam === 'pending' ? statusParam : 'all'
  const r = await listFriendLinks(c.env.DB, { status })
  return c.json({
    // 不回传提交者 ip
    items: r.items.map((l) => ({
      id: l.id,
      name: l.name,
      url: l.url,
      description: l.description,
      icon: l.icon,
      status: l.status,
      sort: l.sort,
      source: l.source,
      created_at: l.created_at,
      updated_at: l.updated_at,
    })),
    total: r.total,
    pending: r.pending,
  })
})

api.post('/admin/links', async (c) => {
  const p = await readLinkPayload(c)
  if (!p) return jsonError('请求格式错误')
  if (!p.name || !p.url) return jsonError('站名和网址不能为空')
  const now = Date.now()
  const res = await c.env.DB.prepare(
    "INSERT INTO friend_links (name, url, description, icon, status, sort, source, ip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'admin', '', ?, ?)"
  )
    .bind(p.name, p.url, p.description, p.icon, p.status, p.sort, now, now)
    .run()
  // 友链进公开 /links 页（审计 C3）→ 默认 approved 的新链接出现后页面边缘缓存作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true, link: await getFriendLinkById(c.env.DB, Number(res.meta.last_row_id)) })
})

api.post('/admin/links/fetch-icon', async (c) => {
  // 演示站守卫：图标抓取是出网点（与 linkmeta 同口径短路）
  if (isDemo(c.env)) return jsonError('演示站不开放图标抓取', 404)
  const body = await c.req.json<{ url?: string }>().catch(() => null)
  const url = normalizeLinkUrl(String(body?.url ?? ''))
  if (!url) return jsonError('网址格式不对，填一下要抓图标的站点地址')
  const icon = await fetchLinkIcon(c.env, url)
  if (!icon) return jsonError('没能取到该站的图标，可以手动填图标地址')
  return c.json({ ok: true, icon })
})

/** 收录（pending → approved）；没图标的转到后台异步抓，不卡响应 */
api.post('/admin/links/:id/approve', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('友链不存在', 404)
  const existing = await getFriendLinkById(c.env.DB, id)
  if (!existing) return jsonError('友链不存在', 404)
  await c.env.DB.prepare("UPDATE friend_links SET status = 'approved', updated_at = ? WHERE id = ?")
    .bind(Date.now(), id)
    .run()
  // 收录改变公开 /links 页（审计 C3）→ 页面边缘缓存作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  // 演示站照常可走收录流程，只是不出网抓图标（demo 体验者凭据公示，出网点一律短路）
  if (!existing.icon && !isDemo(c.env)) {
    const origin = new URL(c.req.url).origin
    c.executionCtx.waitUntil(
      fetchLinkIcon(c.env, existing.url).then((icon) =>
        icon
          ? c.env.DB
              .prepare('UPDATE friend_links SET icon = ?, updated_at = ? WHERE id = ?')
              .bind(icon, Date.now(), id)
              .run()
              .then(() => purgeImageCache(origin, [icon.slice('/images/'.length)]))
          : undefined
      )
    )
  }
  return c.json({ ok: true })
})

api.post('/admin/links/:id/refresh-icon', async (c) => {
  // 演示站守卫：图标抓取是出网点（与 linkmeta 同口径短路）
  if (isDemo(c.env)) return jsonError('演示站不开放图标抓取', 404)
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('友链不存在', 404)
  const existing = await getFriendLinkById(c.env.DB, id)
  if (!existing) return jsonError('友链不存在', 404)
  const icon = await fetchLinkIcon(c.env, existing.url)
  if (!icon) return jsonError('没能取到该站的图标，可在编辑里手动填图标地址')
  await c.env.DB.prepare('UPDATE friend_links SET icon = ?, updated_at = ? WHERE id = ?').bind(icon, Date.now(), id).run()
  // 图标键（u/fav/<host>.<ext>）会被原地覆盖（审计 F2）→ 清页面与图床边缘缓存，刷新立即生效
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  c.executionCtx.waitUntil(purgeImageCache(new URL(c.req.url).origin, [icon.slice('/images/'.length)]))
  return c.json({ ok: true, icon })
})

/** 上移 / 下移：按当前顺序交换后整体回写 sort = 下标（幂等，不怕历史脏数据） */
api.post('/admin/links/reorder', async (c) => {
  const body = await c.req.json<{ id?: number; dir?: string }>().catch(() => null)
  const id = Number(body?.id)
  const dir = body?.dir === 'down' ? 'down' : 'up'
  const items = (await listFriendLinks(c.env.DB, { status: 'approved' })).items
  const idx = items.findIndex((l) => l.id === id)
  if (idx < 0) return jsonError('友链不存在', 404)
  const to = dir === 'up' ? idx - 1 : idx + 1
  if (to < 0 || to >= items.length) return c.json({ ok: true })
  ;[items[idx], items[to]] = [items[to], items[idx]]
  await c.env.DB.batch(
    items.map((l, i) => c.env.DB.prepare('UPDATE friend_links SET sort = ? WHERE id = ?').bind(i, l.id))
  )
  // 排序改变公开 /links 页展示顺序（审计 C3）→ 页面边缘缓存作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

api.put('/admin/links/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('友链不存在', 404)
  const existing = await getFriendLinkById(c.env.DB, id)
  if (!existing) return jsonError('友链不存在', 404)
  const p = await readLinkPayload(c)
  if (!p) return jsonError('请求格式错误')
  if (!p.name || !p.url) return jsonError('站名和网址不能为空')
  await c.env.DB.prepare(
    'UPDATE friend_links SET name = ?, url = ?, description = ?, icon = ?, status = ?, sort = ?, updated_at = ? WHERE id = ?'
  )
    .bind(p.name, p.url, p.description, p.icon, p.status, p.sort, Date.now(), id)
    .run()
  // 编辑（含改状态隐藏/恢复、换图标）影响公开 /links 页（审计 C3）→ 页面边缘缓存作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true, link: await getFriendLinkById(c.env.DB, id) })
})

api.delete('/admin/links/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('友链不存在', 404)
  await c.env.DB.prepare('DELETE FROM friend_links WHERE id = ?').bind(id).run()
  // 删除改变公开 /links 页（审计 C3）→ 页面边缘缓存作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

/* ---------------- 分类管理 ---------------- */

/** 校验并规整分类的 slug：留空则用名称本身（中文可作 slug，URL 会编码） */
function normalizeCategorySlug(input: string, name: string): string {
  const s = (input || name).trim().slice(0, 80)
  if (!s || /[\/\\#?%\s]/.test(s)) return ''
  return s
}

api.get('/admin/categories', async (c) => {
  const categories = await listCategories(c.env.DB, { withCount: true })
  return c.json({ categories })
})

api.post('/admin/categories', async (c) => {
  const body = await c.req.json<{ name?: string; slug?: string; sort?: number; description?: string }>().catch(() => null)
  const name = String(body?.name ?? '').trim().slice(0, 20)
  if (!name) return jsonError('分类名称不能为空')
  const slug = normalizeCategorySlug(String(body?.slug ?? ''), name)
  if (!slug) return jsonError('分类标识只能用字母、数字、中文和短横线')
  const dup = await c.env.DB.prepare('SELECT id FROM categories WHERE name = ? OR slug = ?').bind(name, slug).first<{ id: number }>()
  if (dup) return jsonError('同名或同标识的分类已存在')
  const sort = clampInt(body?.sort, 0, 9999, 0)
  // 分类描述（B23）：纯文本一行说明，兼作归档页 meta description
  const description = cleanCategoryDescription(body?.description)
  const cat = await createCategory(c.env.DB, name, slug, sort, description)
  // 分类进公开面（导航 / 分类页，审计 C4）→ 页面边缘缓存作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true, category: cat })
})

api.put('/admin/categories/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('分类不存在', 404)
  const existing = await getCategoryById(c.env.DB, id)
  if (!existing) return jsonError('分类不存在', 404)
  const body = await c.req.json<{ name?: string; slug?: string; sort?: number; description?: string }>().catch(() => null)
  const name = String(body?.name ?? existing.name).trim().slice(0, 20)
  if (!name) return jsonError('分类名称不能为空')
  const slug = normalizeCategorySlug(String(body?.slug ?? existing.slug), name)
  if (!slug) return jsonError('分类标识只能用字母、数字、中文和短横线')
  const dup = await c.env.DB
    .prepare('SELECT id FROM categories WHERE (name = ? OR slug = ?) AND id != ?')
    .bind(name, slug, id)
    .first<{ id: number }>()
  if (dup) return jsonError('同名或同标识的分类已存在')
  const sort = clampInt(body?.sort, 0, 9999, existing.sort)
  // 分类描述（B23）：缺键即保留（与 slug / sort 同口径）
  const description = body?.description === undefined ? existing.description || '' : cleanCategoryDescription(body.description)
  await c.env.DB.prepare('UPDATE categories SET name = ?, slug = ?, sort = ?, description = ? WHERE id = ?').bind(name, slug, sort, description, id).run()
  // 分类改名/改描述（页头 + meta description）影响公开分类页（审计 C4）→ 页面边缘缓存作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true, category: await getCategoryById(c.env.DB, id) })
})

api.delete('/admin/categories/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('分类不存在', 404)
  // 分类删除后文章变为未分类，文章本身不受影响
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM post_categories WHERE category_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id),
  ])
  // 分类从导航/公开面消失（审计 C4）→ 页面边缘缓存作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

/* ---------------- 独立页面 ---------------- */

api.get('/admin/pages', async (c) => {
  return c.json({ pages: await listPages(c.env.DB) })
})

api.post('/admin/pages', async (c) => {
  const body = await c.req
    .json<{ title?: string; slug?: string; content?: string; status?: string; show_in_nav?: boolean | string }>()
    .catch(() => null)
  const title = String(body?.title ?? '').trim().slice(0, 60)
  if (!title) return jsonError('页面标题不能为空')
  // slug 留空由标题生成（posts 同款 slugify），中文标题回退 dateSlug（北京日期 + 随机位）
  const base = cleanSlug(String(body?.slug ?? '')) || slugify(title)
  const slug = await uniquePageSlug(c.env.DB, base.slice(0, 80))
  const content = sanitizeHtml(String(body?.content ?? '').slice(0, 100_000))
  const status = body?.status === 'published' ? 'published' : 'draft'
  const showInNav = body?.show_in_nav === true || body?.show_in_nav === '1' ? 1 : 0
  const now = Date.now()
  const res = await c.env.DB
    .prepare(
      'INSERT INTO pages (title, slug, content, status, show_in_nav, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
    )
    .bind(title, slug, content, status, showInNav, now, now)
    .run()
  // 页面进导航与公开面（/page/:slug）→ 新建即发布时页面边缘缓存作废
  if (status === 'published') c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true, page: await getPageById(c.env.DB, Number(res.meta.last_row_id)) })
})

api.put('/admin/pages/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('页面不存在', 404)
  const existing = await getPageById(c.env.DB, id)
  if (!existing) return jsonError('页面不存在', 404)
  const body = await c.req
    .json<{ title?: string; slug?: string; content?: string; status?: string; show_in_nav?: boolean | string }>()
    .catch(() => null)
  const title = String(body?.title ?? existing.title).trim().slice(0, 60)
  if (!title) return jsonError('页面标题不能为空')
  const base = cleanSlug(String(body?.slug ?? '')) || existing.slug
  const slug = await uniquePageSlug(c.env.DB, base.slice(0, 80), id)
  const content = sanitizeHtml(String(body?.content ?? existing.content).slice(0, 100_000))
  // 部分更新语义：status / show_in_nav 未提供时沿用旧值，不做静默重置
  const status = body?.status === 'published' ? 'published' : body?.status === 'draft' ? 'draft' : existing.status
  const showInNav = body?.show_in_nav == null ? existing.show_in_nav : body?.show_in_nav === true || body?.show_in_nav === '1' ? 1 : 0
  await c.env.DB
    .prepare('UPDATE pages SET title = ?, slug = ?, content = ?, status = ?, show_in_nav = ?, updated_at = ? WHERE id = ?')
    .bind(title, slug, content, status, showInNav, Date.now(), id)
    .run()
  // 页面出现在导航与公开面，改标题/slug/内容/显隐都影响全站导航 → 页面边缘缓存作废
  if (existing.status === 'published' || status === 'published') c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true, page: await getPageById(c.env.DB, id) })
})

api.delete('/admin/pages/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('页面不存在', 404)
  // 软删进回收站（src/trash.ts）；about 页删除后 /about 走 legacy settings 回退分支
  await c.env.DB.prepare('UPDATE pages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(Date.now(), id).run()
  // 页面从导航消失 → 页面边缘缓存整代作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

// 上移 / 下移：按当前顺序交换后整体回写 sort = 下标（照 friend_links/reorder 模式，幂等不怕脏数据）
api.post('/admin/pages/reorder', async (c) => {
  const body = await c.req.json<{ id?: number; dir?: string }>().catch(() => null)
  const id = Number(body?.id)
  const items = await listPages(c.env.DB)
  const idx = items.findIndex((p) => p.id === id)
  if (idx < 0) return jsonError('页面不存在', 404)
  const to = body?.dir === 'up' ? idx - 1 : idx + 1
  if (to < 0 || to >= items.length) return c.json({ ok: true })
  ;[items[idx], items[to]] = [items[to], items[idx]]
  await c.env.DB.batch(items.map((p, i) => c.env.DB.prepare('UPDATE pages SET sort = ? WHERE id = ?').bind(i, p.id)))
  // 排序改变全站导航顺序 → 页面边缘缓存整代作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

/* ---------------- 回收站（三表软删，机制与清理见 src/trash.ts） ---------------- */
api.get('/admin/trash', async (c) => {
  const typeParam = c.req.query('type')
  const table = typeParam ? trashTable(typeParam) : null
  if (typeParam && !table) return jsonError('未知的回收站类型')
  return c.json(await listTrash(c.env.DB, { type: table, page: clampInt(c.req.query('page'), 1, 1000, 1) }))
})

api.post('/admin/trash/:type/:id/restore', async (c) => {
  const table = trashTable(c.req.param('type'))
  const id = parseId(c.req.param('id'))
  if (!table || !id) return jsonError('内容不存在', 404)
  if (table === 'posts') {
    const row = await getPostById(c.env.DB, id)
    if (!row || row.deleted_at == null) return jsonError('回收站里没有这条内容', 404)
    // 过期的定时文恢复为草稿（restorePostStatus），防「恢复即撞发」；顺带清掉 publish_at，
    // 回到「非 scheduled 不留定时点」，防止这条草稿之后被切回 scheduled 时按旧时间立即撞发
    const status = restorePostStatus(row.status, row.publish_at, Date.now())
    const expiredScheduled = row.status === 'scheduled' && status === 'draft'
    const res = await c.env.DB
      .prepare(
        expiredScheduled
          ? 'UPDATE posts SET deleted_at = NULL, status = ?, publish_at = NULL WHERE id = ? AND deleted_at IS NOT NULL'
          : 'UPDATE posts SET deleted_at = NULL, status = ? WHERE id = ? AND deleted_at IS NOT NULL'
      )
      .bind(status, id)
      .run()
    if ((res.meta.changes ?? 0) !== 1) return jsonError('回收站里没有这条内容', 404)
  } else if (table === 'weibo') {
    // 恢复微博沿用置顶同一名额口径：置顶端点有「存活置顶 < 3」原子守卫，恢复路径曾绕过它
    // （满员时软删一条再补置顶、然后恢复，前台会同时出现 4 条置顶）。子查询在更新前取数，
    // 本行仍是软删态不计入；超额时落回 pinned=0，恢复本身照常成功
    const res = await c.env.DB.prepare(
      `UPDATE weibo SET deleted_at = NULL, pinned = CASE WHEN pinned = 1 AND
        (SELECT COUNT(*) FROM weibo WHERE pinned = 1 AND deleted_at IS NULL) >= ${WEIBO_MAX_PINNED}
        THEN 0 ELSE pinned END WHERE id = ? AND deleted_at IS NOT NULL`
    )
      .bind(id)
      .run()
    if ((res.meta.changes ?? 0) !== 1) return jsonError('回收站里没有这条内容', 404)
    // 微博总数记账位：条件增减按「本语句执行时刻」求值，必须排在恢复**之后**（此时行已复活，
    // published 存活态判得中）；行非已发布时自动 no-op
    await bumpWeiboCountById(c.env.DB, 1, id)
  } else {
    const res = await c.env.DB
      .prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`)
      .bind(id)
      .run()
    if ((res.meta.changes ?? 0) !== 1) return jsonError('回收站里没有这条内容', 404)
  }
  // 恢复（posts/weibo/pages 三路汇合）→ 恢复的内容重新出现在公开面，页面边缘缓存整代作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

api.delete('/admin/trash/:type/:id', async (c) => {
  const table = trashTable(c.req.param('type'))
  const id = parseId(c.req.param('id'))
  if (!table || !id) return jsonError('内容不存在', 404)
  // 彻底删除只作用于已在回收站的行（deleted_at IS NOT NULL 防误删存活数据），batch 事务内级联清评论。
  // 级联必须在主行 DELETE 之前、且用「xx_id IN (回收站行)」子查询守卫：主行先删的话子查询就看不到它了；
  // 行还活着时子查询匹配不到，级联不动任何数据，主 DELETE 0 行 → 404
  if (table === 'posts') {
    const cascade = 'AND post_id IN (SELECT id FROM posts WHERE deleted_at IS NOT NULL)'
    const res = await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM comments WHERE post_id = ? ${cascade}`).bind(id),
      c.env.DB.prepare(`DELETE FROM post_categories WHERE post_id = ? ${cascade}`).bind(id),
      c.env.DB.prepare('DELETE FROM posts WHERE id = ? AND deleted_at IS NOT NULL').bind(id),
    ])
    // 用 < 1 而非 !== 1：DELETE 触发器（FTS 索引同步，db.ts SCHEMA_TRIGGERS）会让 meta.changes
    // 把触发器内的 FTS 删除命令也计进去，单行删除的 changes 可能是 1 也可能是 2+（D1 实测为 2）；
    // 0 行匹配时触发器不运行、changes 恒为 0，所以「< 1 = 什么都没删」在两种计数口径下都成立
    if ((res[2].meta.changes ?? 0) < 1) return jsonError('回收站里没有这条内容', 404)
  } else if (table === 'weibo') {
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        'DELETE FROM comments WHERE weibo_id = ? AND weibo_id IN (SELECT id FROM weibo WHERE deleted_at IS NOT NULL)'
      ).bind(id),
      c.env.DB.prepare('DELETE FROM weibo WHERE id = ? AND deleted_at IS NOT NULL').bind(id),
    ])
    // 同 posts：< 1 口径（weibo_fts 删除触发器会把 changes 计成 2）
    if ((res[1].meta.changes ?? 0) < 1) return jsonError('回收站里没有这条内容', 404)
  } else {
    const res = await c.env.DB.prepare('DELETE FROM pages WHERE id = ? AND deleted_at IS NOT NULL').bind(id).run()
    // 同 posts/weibo 用 < 1 口径：pages 未来若挂 FTS/其他触发器，changes 会被多计
    if ((res.meta.changes ?? 0) < 1) return jsonError('回收站里没有这条内容', 404)
  }
  return c.json({ ok: true })
})

/** 清空回收站（body 可选 {type} 定向清空一类）；级联子查询在一个 batch 事务内完成 */
api.post('/admin/trash/purge', async (c) => {
  const body = await c.req.json<{ type?: string }>().catch(() => null)
  let table: TrashTable | null = null
  if (body?.type) {
    table = trashTable(body.type)
    if (!table) return jsonError('未知的回收站类型')
  }
  const stmts: D1PreparedStatement[] = []
  if (!table || table === 'posts') {
    stmts.push(
      c.env.DB.prepare('DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE deleted_at IS NOT NULL)'),
      c.env.DB.prepare('DELETE FROM post_categories WHERE post_id IN (SELECT id FROM posts WHERE deleted_at IS NOT NULL)'),
      c.env.DB.prepare('DELETE FROM posts WHERE deleted_at IS NOT NULL')
    )
  }
  if (!table || table === 'weibo') {
    stmts.push(
      c.env.DB.prepare('DELETE FROM comments WHERE weibo_id IN (SELECT id FROM weibo WHERE deleted_at IS NOT NULL)'),
      c.env.DB.prepare('DELETE FROM weibo WHERE deleted_at IS NOT NULL')
    )
  }
  if (!table || table === 'pages') {
    stmts.push(c.env.DB.prepare('DELETE FROM pages WHERE deleted_at IS NOT NULL'))
  }
  await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

api.get('/admin/tags', async (c) => {
  // 文章里实际用到的标签（含草稿，不含回收站）+ 分类页预建的标签（count 为 0）
  const [postsRes, extraRes] = await Promise.all([
    c.env.DB.prepare('SELECT tags FROM posts WHERE deleted_at IS NULL LIMIT 2000').all<{ tags: string }>(),
    c.env.DB.prepare('SELECT name FROM tags').all<{ name: string }>(),
  ])
  const count = new Map<string, number>()
  for (const r of postsRes.results ?? []) {
    for (const t of parseTags({ tags: r.tags } as PostRow)) count.set(t, (count.get(t) || 0) + 1)
  }
  for (const r of extraRes.results ?? []) if (!count.has(r.name)) count.set(r.name, 0)
  return c.json({
    tags: [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 200)
      .map(([name, n]) => ({ name, count: n })),
  })
})

api.post('/admin/tags', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => null)
  const name = String(body?.name ?? '').trim().slice(0, 20)
  if (!name) return jsonError('标签名不能为空')
  const dup = await c.env.DB.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first<{ id: number }>()
  if (dup) return jsonError('这个标签已存在')
  await c.env.DB.prepare('INSERT INTO tags (name, created_at) VALUES (?, ?)').bind(name, Date.now()).run()
  return c.json({ ok: true })
})

api.delete('/admin/tags/:name', async (c) => {
  const name = c.req.param('name').trim().slice(0, 20)
  if (!name) return jsonError('参数错误')
  // 从所有文章的标签里移除该标签（LIKE 预筛后再精确过滤）
  const { results } = await c.env.DB
    .prepare("SELECT id, tags FROM posts WHERE tags LIKE ? ESCAPE '\\'")
    .bind(jsonItemLikePattern(name))
    .all<{ id: number; tags: string }>()
  const stmts = (results ?? [])
    .filter((r) => parseTags({ tags: r.tags } as PostRow).includes(name))
    .map((r) => {
      const kept = parseTags({ tags: r.tags } as PostRow).filter((t) => t !== name)
      return c.env.DB.prepare('UPDATE posts SET tags = ? WHERE id = ?').bind(JSON.stringify(kept), r.id)
    })
  stmts.push(c.env.DB.prepare('DELETE FROM tags WHERE name = ?').bind(name))
  await c.env.DB.batch(stmts)
  // 标签从文章摘除影响 /tag/:x 聚合页（审计 C5）→ 页面边缘缓存作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

/* ---------------- 媒体库（R2 图床） ---------------- */
api.post('/admin/upload', async (c) => {
  if (!rateLimit(`upload:${clientIp(c.req.raw)}`, 60, 60_000)) return jsonError('上传太频繁，请稍后再试', 429)
  const body = await c.req.parseBody().catch(() => null)
  const file = body && typeof body === 'object' ? ((body as Record<string, unknown>)['file'] as unknown) : null
  if (!(file instanceof File)) return jsonError('缺少文件字段 file')
  const mime = file.type || 'application/octet-stream'
  // 白名单查表统一走 imageExtOf（内部 hasOwnProperty 挡原型链穿透）
  const declared =
    imageExtOf(mime) ??
    (Object.prototype.hasOwnProperty.call(VIDEO_MIMES, mime) ? VIDEO_MIMES[mime] : undefined)
  if (!declared) return jsonError('仅支持 JPG / PNG / WebP / GIF 图片与 MP4 / WebM 视频')
  if (file.size > MAX_UPLOAD_BYTES) return jsonError('文件超过 25MB 限制')
  const buf = await file.arrayBuffer()
  // 类型只认文件魔数（与转存链路同口径）：声明成图片但内容是 HTML/SVG/其它的一律拒收；
  // 魔数与声明不符时按魔数落库（mime 取识别出的真实类型）
  const ext = sniffUploadExt(buf)
  if (!ext) return jsonError('文件内容不是支持的格式（仅认文件魔数）')
  const realMime =
    ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : ext === 'ico' ? 'image/x-icon' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
  const url = await saveUpload(c.env, buf, realMime, file.name, ext)
  // 视频编码如实回报（HEVC 在 Chrome / 安卓解不出来）：前端据此提示，不改「收不收」的口径——
  // iPhone 默认就是 HEVC，一律拒收等于让手机拍的东西传不上来
  const codec = ext === 'mp4' || ext === 'webm' ? sniffVideoCodec(buf) : null
  return c.json({ ok: true, url, key: url.slice('/images/'.length), mime: realMime, size: buf.byteLength, codec })
})

api.get('/admin/uploads', async (c) => {
  const page = clampInt(c.req.query('page'), 1, 1000, 1)
  const limit = 24
  const [listRes, countRes] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM uploads ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(limit, (page - 1) * limit)
      .all<{ id: number; key: string; name: string; mime: string; size: number; created_at: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM uploads').first<{ n: number }>(),
  ])
  return c.json({
    items: (listRes.results ?? []).map((u) => ({ ...u, url: `/images/${u.key}` })),
    total: countRes?.n ?? 0,
    page,
  })
})

api.delete('/admin/uploads', async (c) => {
  const key = c.req.query('key') || ''
  // og/ 与 u/ 同为媒体库可管理的图床目录（OG 分享卡图），前缀白名单挡住 backups/ 等其余 key
  if (!key.startsWith('u/') && !key.startsWith('og/')) return jsonError('非法的文件 Key')
  await Promise.all([
    c.env.IMAGES.delete(key),
    c.env.DB.prepare('DELETE FROM uploads WHERE key = ?').bind(key).run(),
  ])
  // 删掉的媒体从图床边缘缓存摘掉（2026-10-15 审计 F2）：边缘副本 immutable 1y，
  // 不清理的话已删内容对持旧 URL 的访客继续可见
  c.executionCtx.waitUntil(purgeImageCache(new URL(c.req.url).origin, [key]))
  return c.json({ ok: true })
})

/* ---------------- 媒体体检：未引用 / 重复文件扫描与安全清理（逻辑在 src/audit.ts） ---------------- */

api.get('/admin/uploads/audit', async (c) => {
  if (!rateLimit(`audit:${clientIp(c.req.raw)}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  return c.json(await runAudit(c.env))
})

api.post('/admin/uploads/hash-backfill', async (c) => {
  // 前端回填是循环连发（每批最多 50 个），不能与 audit 的 10/分钟共桶；独立桶放宽到 60/分钟仍有界
  if (!rateLimit(`backfill:${clientIp(c.req.raw)}`, 60, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const b = await c.req.json<{ limit?: number }>().catch(() => null)
  return c.json(await backfillHashes(c.env, Number(b?.limit) || 25))
})

api.post('/admin/uploads/merge', async (c) => {
  if (!rateLimit(`audit:${clientIp(c.req.raw)}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const b = await c.req.json<{ keep?: unknown; remove?: unknown }>().catch(() => null)
  if (!b || typeof b.keep !== 'string' || !Array.isArray(b.remove)) return jsonError('参数不完整')
  try {
    const r = await mergeDuplicate(c.env, b.keep, b.remove)
    // 合并把正文/微博里的重复图地址改写为保留键 → 页面边缘缓存作废（旧副本里的 URL 已失效）；
    // 被合并删除的文件同时从图床边缘缓存摘掉（审计 F2）
    c.executionCtx.waitUntil(purgePageCache(c.env.DB))
    c.executionCtx.waitUntil(purgeImageCache(new URL(c.req.url).origin, r.removed ?? []))
    return c.json({ ok: true, ...r })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : '合并失败')
  }
})

api.post('/admin/uploads/cleanup', async (c) => {
  if (!rateLimit(`audit:${clientIp(c.req.raw)}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const b = await c.req.json<{ keys?: unknown }>().catch(() => null)
  if (!b || !Array.isArray(b.keys)) return jsonError('参数不完整')
  try {
    const r = await cleanupUnreferenced(c.env, b.keys)
    // 真正删掉的文件从图床边缘缓存摘掉（审计 F2：边缘副本 immutable 1y 不清就继续可达）
    if (r.deletedKeys?.length) c.executionCtx.waitUntil(purgeImageCache(new URL(c.req.url).origin, r.deletedKeys))
    return c.json({ ok: true, ...r })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : '清理失败')
  }
})

/* ---------------- OG 分享卡图 ----------------
 * 编辑器用 canvas 把标题+封面绘成 1200x630 PNG 上传到这里，R2 og/ 目录。
 * 独立于普通上传：key 前缀 og/，删除文章卡图的入口在编辑器里。
 */
api.post('/admin/og-image', async (c) => {
  if (!rateLimit(`upload:${clientIp(c.req.raw)}`, 60, 60_000)) return jsonError('上传太频繁，请稍后再试', 429)
  const body = await c.req.parseBody().catch(() => null)
  const file = body && typeof body === 'object' ? ((body as Record<string, unknown>)['file'] as unknown) : null
  if (!(file instanceof File)) return jsonError('缺少文件字段 file')
  if (file.type !== 'image/png') return jsonError('OG 卡图仅支持 PNG')
  if (file.size > MAX_UPLOAD_BYTES) return jsonError('文件超过 25MB 限制')
  const buf = await file.arrayBuffer()
  // 魔数复核（与上传同口径）：声明 PNG 但内容不是 PNG 的一律拒收
  if (sniffUploadExt(buf) !== 'png') return jsonError('文件内容不是 PNG')
  const url = await saveUpload(c.env, buf, 'image/png', 'og-card.png', 'png', 'og')
  return c.json({ ok: true, url, key: url.slice('/images/'.length) })
})

/* ---------------- 评论管理 ---------------- */
api.get('/admin/comments', async (c) => {
  const status = c.req.query('status')
  const type = c.req.query('type') // post = 文章评论，weibo = 微博评论，guestbook = 留言板
  const page = clampInt(c.req.query('page'), 1, 1000, 1)
  const limit = 20
  const where: string[] = []
  const binds: unknown[] = []
  if (status === 'approved' || status === 'pending') {
    where.push('c.status = ?')
    binds.push(status)
  }
  if (type === 'post') where.push('c.post_id > 0')
  else if (type === 'weibo') where.push('c.weibo_id > 0')
  else if (type === 'guestbook') where.push('c.post_id = 0 AND c.weibo_id = 0')
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const [listRes, countRes, pendingRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT c.*, p.title AS post_title, p.slug AS post_slug, w.content AS weibo_content, pc.nickname AS parent_nickname
       FROM comments c
       LEFT JOIN posts p ON p.id = c.post_id
       LEFT JOIN weibo w ON w.id = c.weibo_id
       LEFT JOIN comments pc ON pc.id = c.parent_id
       ${whereSql} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...binds, limit, (page - 1) * limit)
      .all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM comments c ${whereSql}`)
      .bind(...binds)
      .first<{ n: number }>(),
    // 全局待审数：侧栏「评论」角标在审核操作后随本接口刷新
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'").first<{ n: number }>(),
  ])
  // IP 属地：后台列表换算成中文标签展示（审核判断用），与前台展示开关无关——数据反正在库里
  const items = (listRes.results ?? []).map((r: Record<string, unknown>) =>
    r.ip_region ? { ...r, ip_region: ipRegionLabel(String(r.ip_region), false) } : r
  )
  return c.json({ items, total: countRes?.n ?? 0, page, pending: pendingRes?.n ?? 0 })
})

/** 后台回复评论（文章/微博通用）：挂在同一条顶层评论下，直接展示并带「作者」徽标 */
api.post('/admin/comments/:id/replies', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('评论不存在', 404)
  const body = await c.req.json<{ content?: string }>().catch(() => null)
  const content = String(body?.content || '').trim().slice(0, 1000)
  if (!content) return jsonError('回复内容不能为空')
  const target = await c.env.DB
    .prepare('SELECT * FROM comments WHERE id = ?')
    .bind(id)
    .first<CommentRow>()
  if (!target) return jsonError('评论不存在', 404)
  const user = c.get('user')
  await c.env.DB.prepare(
    'INSERT INTO comments (post_id, weibo_id, parent_id, is_admin, nickname, content, status, ip, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)'
  )
    .bind(
      target.post_id,
      target.weibo_id,
      target.parent_id || target.id,
      (user.display_name || user.username).slice(0, 24),
      content,
      'approved',
      '',
      Date.now()
    )
    .run()
  // 作者回复直接上公开页面（审计 C2：作者回复刻意不触发 onCommentCreated，缓存清理要单挂）
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

api.put('/admin/comments/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('评论不存在', 404)
  const body = await c.req.json<{ status?: string }>().catch(() => null)
  // status 白名单：拼错值/空 body 不得隐式过审（同 theme/siteMode 枚举口径）
  if (body?.status !== 'approved' && body?.status !== 'pending') return jsonError('status 只允许 approved / pending')
  // 先查后改：目标不存在回 404（同 pin/restore 口径），顺带带出 member_id 供计分
  const target = await c.env.DB.prepare('SELECT member_id FROM comments WHERE id = ?').bind(id).first<{ member_id: number | null }>()
  if (!target) return jsonError('评论不存在', 404)
  const status = body.status
  // 会员评论过审才计积分（awardCommentPoints 按 ref_id 去重，反复 通过↔待审 不重复记）
  await c.env.DB.prepare('UPDATE comments SET status = ? WHERE id = ?').bind(status, id).run()
  // 审核（通过/退回待审）改变评论在公开页面的可见性 → 页面边缘缓存整代作废
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  if (status === 'approved' && target.member_id) {
    // 封禁会员不记分：批量清理待审时会「通过」违规会员的评论，拉黑后再计分等于违规所得
    // 入账（解封后完整回到排行榜）；计分前核会员仍是 active
    const active = await c.env.DB
      .prepare("SELECT 1 AS x FROM members WHERE id = ? AND status = 'active'")
      .bind(target.member_id)
      .first()
    if (active) c.executionCtx.waitUntil(awardCommentPoints(c.env.DB, target.member_id, id))
  }
  return c.json({ ok: true })
})

api.delete('/admin/comments/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('评论不存在', 404)
  // 回复（楼中楼）一并删除
  await c.env.DB.prepare('DELETE FROM comments WHERE id = ? OR parent_id = ?').bind(id, id).run()
  // 评论从公开页面消失 → 页面边缘缓存整代作废（评论没有回收站，此操作不可恢复）
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true })
})

/* ---------------- 设置 ---------------- */
// 敏感项只写不读：GET 一律打码返回（明文只在生成 Token / 保存后不再回显）；
// PUT 收到打码占位符视为「保持原值」，这样前端整表提交不会把占位符写进库。
// SECRET_SETTINGS 的唯一来源在 db.ts（整站包导出也要用它跳过密钥），这里只引用
const SECRET_MASK = '••••••••'
// 布尔开关统一收口：'1'/'true' → '1'，其余一律 '0'（新增布尔键加进表即可，别再抄判断分支）
const BOOL_SETTINGS = [
  'allowComments',
  'moderateComments',
  'showCommentRegion',
  'notifyNewComment',
  'rssFullText',
  'backupEnabled',
  'statsEnabled',
  'siteGrayscale',
  'siteClosed',
  'siteNoindex',
  'membersEnabled',
  // 会员 3.0 预备：注册开关 / 排行榜开关 / 评论区认证徽标开关
  'memberRegOpen',
  'rankEnabled',
  'showMemberBadge',
  // 新手引导记账位（db.ts DEFAULT_SETTINGS 同注释）：onboarding='1' 引导激活；
  // onboardingManual='1' 手册已打开。后台设置页「保存全部」不含这两键，别加进去——
  // 整表提交会把引导态重置
  'onboarding',
  'onboardingManual',
]

/** 站长 SEO 两项（B20）的后台回显形态：存库是结构化 JSON，输入框按「可粘贴形态」展示
 *  （与 PUT 接受的格式同形，可原样改回再存）；渲染端仍按结构化值重放，不涉原始 HTML 透传 */
function seoDisplaySettings(s: Record<string, string>): Record<string, string> {
  s.verifyMetas = verifyMetaTagsHtml(s.verifyMetas)
  s.analyticsScript = analyticsScriptHtml(s.analyticsScript)
  return s
}

api.get('/admin/settings', async (c) => {
  const settings = seoDisplaySettings(await getSettings(c.env.DB))
  for (const key of SECRET_SETTINGS) {
    if (settings[key]) settings[key] = SECRET_MASK
  }
  return c.json({ settings })
})

api.put('/admin/settings', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || typeof body !== 'object') return jsonError('请求格式错误')
  const patch: Record<string, string> = {}
  for (const key of SETTINGS_KEYS) {
    if (!(key in body)) continue
    const v = String((body as Record<string, unknown>)[key] ?? '')
    // 打码占位符原样提交 = 用户没改这一项，跳过以免覆盖真实值
    if (SECRET_SETTINGS.includes(key) && v === SECRET_MASK) continue
    // hasOwnProperty 挡住 constructor/toString 等原型链属性穿透成「合法主题」导致全站 500
    if (key === 'theme' && !Object.prototype.hasOwnProperty.call(THEMES, v)) return jsonError('未知主题：' + v)
    if (key === 'siteMode') {
      // 站点模式四值白名单，脏值回退默认（前台 siteMode() 同口径兜底）
      patch[key] = SITE_MODE_VALUES.includes(v as SiteMode) ? v : 'blog-weibo'
      continue
    }
    if (key === 'contentVisibleRange' || key === 'contentVisibleRangePosts' || key === 'contentVisibleRangeWeibo') {
      // 站点可见窗口（朋友圈式 N 天可见）：写路径严格白名单——脏值 400 而不是静默降级，
      // 站长得知道「保存了但没生效」是输入问题；'' = 全部可见。旧单键仅为升级期兼容，
      // 新键保存后下方统一清空旧键（避免旧值继续回落）
      if (v !== '' && !Object.prototype.hasOwnProperty.call(LIST_RANGES, v)) return jsonError('可见范围档位不正确')
      patch[key] = v
      continue
    }
    if (key === 'memberTiers') {
      // 会员档位定义（src/tiers.ts）：JSON 净化成规范化数组存库；非法整体 400（读侧脏 JSON
      // 会兜底默认三档，但写路径必须让站长当场知道存坏了——与 appearance / customCss 同口径）
      let raw: unknown = null
      try {
        raw = v.trim() ? JSON.parse(v) : null
      } catch {
        return jsonError('会员档位定义不是合法 JSON')
      }
      if (raw === null) {
        patch[key] = ''
        continue
      }
      const defs = cleanMemberTiers(raw)
      if (!defs)
        return jsonError('会员档位定义不合法：1-10 档、key 唯一（小写字母开头，all/member 保留）、第一档需为永久档、名称 1-12 字')
      patch[key] = JSON.stringify(defs)
      continue
    }
    if (key === 'memberNotice') {
      // 会员中心公告：纯文本单行（换行折叠成空格），长度 200 封顶——渲染层 esc 后直出
      patch[key] = v.replace(/\s+/g, ' ').trim().slice(0, 200)
      continue
    }
    if (key === 'contentVisibleForMembers') {
      // 会员是否同样受可见窗口限制：只认 '0' / '1'，脏值 400
      if (v !== '0' && v !== '1') return jsonError('会员可见范围档位不正确')
      patch[key] = v
      continue
    }
    if (key === 'appearance') {
      // 主题外观变量（B9 · 内测）：净化成规范化 JSON 存库，非法整体拒绝；角色是否被当前
      // 主题支持、是否等于主题默认值留给渲染端按当前主题过滤（先调外观再换皮肤顺序无关）
      const cleaned = cleanAppearanceSettings(v)
      if (cleaned === null) return jsonError('外观变量格式不正确')
      patch[key] = cleaned
      continue
    }
    if (key === 'postsPerPage') {
      patch[key] = String(clampInt(v, 1, 50, 10))
      continue
    }
    if (key === 'about') {
      patch[key] = sanitizeHtml(v.slice(0, 100_000))
      continue
    }
    if (key === 'faviconUrl' || key === 'avatarUrl' || key === 'ogImageDefault') {
      // 只接受站内 /images/ 地址或 http(s) 外链，防止 javascript: 之类注入
      const u = v.trim().slice(0, 500)
      patch[key] = u.startsWith('/images/') || /^https?:\/\//i.test(u) ? u : ''
      continue
    }
    if (key === 'siteUrl') {
      // 站点地址拼进 RSS / sitemap / canonical / JSON Feed 的绝对 URL（留空 = 回退请求
      // origin）：scheme 白名单 http(s)，脏值整体 400 让站长当场改——静默清空会让
      // 「填错了但没报错」的站点地址悄悄带偏全部 feed 链接
      const u = v.trim().slice(0, 500)
      if (u && !/^https?:\/\//i.test(u)) return jsonError('站点地址无效：需以 http:// 或 https:// 开头的完整地址（留空则自动使用当前访问域名）')
      patch[key] = u
      continue
    }
    if (key === 'pluginsDisabled') {
      const cleaned = cleanDisabledPlugins(v)
      if (cleaned === null) return jsonError('插件 ID 只能包含字母、数字、_ 或 -')
      patch[key] = cleaned
      continue
    }
    if (key === 'serverPluginsDisabled') {
      const cleaned = cleanDisabledPlugins(v)
      if (cleaned === null) return jsonError('插件 ID 只能包含字母、数字、_ 或 -')
      patch[key] = cleaned
      continue
    }
    if (key === 'tgChannelChatId') {
      patch[key] = v.trim().slice(0, 100)
      continue
    }
    if (key === 'commentWebhookUrl') {
      // 只接受 http(s) 完整地址（webhook 目标），其余清空；再过公网校验拒私网/非常规端口——
      // 评论钩子的 body 带访客可控内容，不能在 docker-poc 多租户下沦为内网盲探跳板
      const u = v.trim().slice(0, 500)
      if (!u) patch[key] = ''
      else if (/^https?:\/\//i.test(u) && fetchableUrl(u)) patch[key] = u
      else return jsonError('评论 Webhook 地址无效（需公网 http(s) 地址）')
      continue
    }
    if (key === 'plazaEndpoint') {
      // 广场上报端点：落配置时收敛为公网 https 地址（与发送侧 hooks.ts 的 https 前缀同口径）
      const u = v.trim().slice(0, 500)
      if (!u) patch[key] = ''
      else if (u.startsWith('https://') && fetchableUrl(u)) patch[key] = u
      else return jsonError('广场同步端点无效（需公网 https 地址）')
      continue
    }
    if (key === 'customCss') {
      // 皮肤包自定义 CSS（B8）：样式安检门唯一写入口，非法整体 400（渲染端二次净化幂等兜底）
      const cleaned = cleanCustomCss(v)
      if (cleaned === null)
        return jsonError(
          '自定义 CSS 无效：不支持 @import / expression 等，url() 只接受 https、站内相对或 data:image|font 地址，花括号需配平，长度 ≤ 8000'
        )
      patch[key] = cleaned
      continue
    }
    if (key === 'serverPluginConfig') {
      // 服务端插件配置（按插件 id 命名空间的 JSON）：结构净化 + 各插件 configValidate 语义校验，
      // 非法整体 400——插件配置的统一通道，插件要配置不必再往 DEFAULT_SETTINGS 塞专属键
      const r = cleanServerPluginConfig(v)
      if (!r.ok) return jsonError(r.error)
      patch[key] = r.value
      continue
    }
    if (key === 'footerHtmlCode') {
      // 站长自定义页脚 HTML（挂件/徽章），与主题 CSS 同信任级：仅管理员可写，渲染时不转义
      patch[key] = v.slice(0, 5000)
      continue
    }
    if (key === 'siteClosedMessage') {
      patch[key] = v.slice(0, 1000)
      continue
    }
    if (BOOL_SETTINGS.includes(key)) {
      patch[key] = v === '1' || v === 'true' ? '1' : '0'
      continue
    }
    if (key === 'rankTopN') {
      // 排行榜展示条数：1-50，脏值回退 10
      patch[key] = String(clampInt(v, 1, 50, 10))
      continue
    }
    if (key === 'verifyMetas') {
      // 站点验证 meta（B20）：解析成结构化 JSON 存库（name 白名单 + content 形态，见 src/seo.ts），
      // 非法整体 400——渲染端按结构化值重放，不存在原始 HTML 透传面
      const cleaned = cleanVerifyMetas(v)
      if (cleaned === null) return jsonError('站点验证标签格式不正确：一行一个 <meta name="…" content="…">，支持 Google / Bing / 百度 / 搜狗 / 360 / Yandex 等验证字段')
      patch[key] = cleaned
      continue
    }
    if (key === 'analyticsScript') {
      // 统计脚本（B20）：https 脚本地址或 provider 片段（解析成 src + 白名单属性重放）；
      // 内联脚本体一律拒绝（CSP 不放行内联脚本），非法整体 400
      const cleaned = cleanAnalyticsScript(v)
      if (cleaned === null) return jsonError('统计脚本无效：只支持 https 脚本地址，或带 src 的 <script> 片段（不支持内联配置代码）')
      patch[key] = cleaned
      continue
    }
    if (key === 'robotsExtra') {
      // robots.txt 追加段（B20）：剥控制字符 + 限长后存库，渲染时附在内置段之后
      patch[key] = cleanRobotsExtra(v)
      continue
    }
    if (key === 'aiPolicy') {
      // AI 抓取策略（训练型拒绝 / 检索引用型放行的 robots 声明）：三值白名单，脏值 400
      // 而不是静默降级（与 contentVisibleRange 同口径——站长得知道「保存了没生效」是输入问题）；
      // 渲染端 readAiPolicy 另有一层容错兜底（脏值一律当 allow）
      if (!AI_POLICY_VALUES.includes(v as AiPolicy)) return jsonError('AI 抓取策略档位不正确')
      patch[key] = v
      continue
    }
    if (key === 'updateIgnoredVersion') {
      // 更新中心「保持当前版本」记账位（src/update.ts）：只认 x.y.z 形态，脏值清空
      // （清空即「没选择忽略」，下次检查照常提示更新——宁缺毋滥，不让脏值锁死更新提示）
      const u = v.trim().replace(/^v/, '')
      patch[key] = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(u) ? u : ''
      continue
    }
    if (key === 'edition') {
      // 英文测试版（English 0.1）开关：二值白名单；重新开启即重置回退状态与错误记录
      patch[key] = v === 'en' ? 'en' : 'zh'
      if (patch[key] === 'en') {
        patch.editionEnStatus = 'active'
        patch.editionEnError = ''
        patch.editionEnAt = ''
      }
      continue
    }
    patch[key] = v.slice(0, 500)
  }
  // Turnstile 两键成对（注册人机验证）：只填一个会造出「有锁无窗」（注册被拦且无验证组件可过）
  // 或「有窗无锁」（组件白渲染）——整体拒绝。Secret 以打码占位符提交时不在 patch 里，回读现值兜底
  if (patch.turnstileSiteKey !== undefined || patch.turnstileSecret !== undefined) {
    const cur = await getSettings(c.env.DB)
    const site = patch.turnstileSiteKey !== undefined ? patch.turnstileSiteKey : cur.turnstileSiteKey
    const secret = patch.turnstileSecret !== undefined ? patch.turnstileSecret : cur.turnstileSecret
    if (!!site !== !!secret) return jsonError('Turnstile 需同时填写 Site Key 与 Secret Key（或都留空关闭）')
  }
  // 演示站不允许闭站：有人开了开关，整个重置周期内所有体验者都会看到 503
  if (isDemo(c.env)) patch.siteClosed = '0'
  // 可见窗口新键一旦提交，旧单键 contentVisibleRange 同步清空：旧键只服务「升级后没动过设置」的
  // 回落期（utils.visibleRangeOf），留着会让新键的 ''（全部可见）被旧值覆盖
  if (patch.contentVisibleRangePosts !== undefined || patch.contentVisibleRangeWeibo !== undefined) patch.contentVisibleRange = ''
  await saveSettings(c.env.DB, patch)
  const saved = seoDisplaySettings(await getSettings(c.env.DB))
  // 与 GET 同口径：密钥只在生成时返回一次明文，此后任何回显都打码（防代理/扩展被动收集）
  for (const key of SECRET_SETTINGS) {
    if (saved[key]) saved[key] = SECRET_MASK
  }
  return c.json({ ok: true, settings: saved })
})

/* ---------------- 订阅与备份 ---------------- */

/** 手动触发一次全量备份（与每晚 Cron 同一逻辑），返回文件 Key 与体积 */
api.post('/admin/backup', async (c) => {
  // 演示站守卫：备份含全库行与密钥，demo 体验者凭据公示，敏感面一律短路
  if (isDemo(c.env)) return jsonError('演示站不开放备份', 404)
  // 全表导出整包进内存，连点可在同一 isolate 堆叠多个全量导出（128MB 上限）——全局窗口内只放一次
  if (!rateLimit('backup:global', 1, 10 * 60_000)) return jsonError('备份刚刚执行过，请 10 分钟后再试', 429)
  const r = await runBackup(c.env)
  if (!r.skipped && r.ok) {
    // 备份完成广播（异地备份类插件取件推送）：waitUntil 不拖慢管理端响应
    c.executionCtx.waitUntil(fireBackupCompleted(c.env, { key: r.key!, bytes: r.bytes!, tables: r.tables!, at: Date.now() }))
  }
  if (!r.skipped && !r.ok) return jsonError('备份失败：' + (r.error || '未知错误'), 500)
  return c.json({ ok: r.ok, skipped: !!r.skipped, key: r.key, bytes: r.bytes, error: r.error })
})

/* ---------------- 整站包（B26：一键导出整站 / 一键导入还原到空站，机制 src/sitebundle.ts） ----------------
 * 设计见 docs/archive/PROPOSAL-B26-SITE-BUNDLE.md。三条契约：只还原到空站 / 只装内容不装实例身份 /
 * 版本不匹配一律拒绝（不做覆盖、不做合并）。全部端点都在 /admin/* 鉴权中间件之后。 */

/** 一键导出整站包：流式吐 zip（与 Markdown / WXR 导出同形，不落 R2） */
api.get('/admin/bundle/export', async (c) => {
  // 演示站守卫：整站包含全库内容与图片，体验者凭据公示，敏感面一律短路
  if (isDemo(c.env)) return jsonError('演示站不开放导出', 404)
  // 全表导出 + 全量图片流式打包，连点会在同一 isolate 堆叠多个任务——全局窗口内只放两次
  if (!rateLimit('bundle-export:global', 2, 10 * 60_000)) return jsonError('导出刚刚执行过，请稍后再试', 429)
  const now = Date.now()
  const stream = await buildBundleStream(c.env, now)
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${bundleFileName(now)}"`,
      'Cache-Control': 'no-cache',
    },
  })
})

/** 上传整站包：流式落 R2 bundles/（不缓冲，避免大包打爆 isolate），供导入读取 */
api.post('/admin/bundle/upload', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放导入', 404)
  if (!rateLimit(`bundle-upload:${clientIp(c.req.raw)}`, 3, 10 * 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const body = c.req.raw.body
  if (!body) return jsonError('请求体为空')
  const key = `${BUNDLE_PREFIX}${bundleFileName(Date.now()).replace(/\.zip$/, '')}-${Math.random().toString(36).slice(2, 8)}.zip`
  const obj = await c.env.IMAGES.put(key, body, { httpMetadata: { contentType: 'application/zip' } })
  return c.json({ ok: true, key, size: obj?.size ?? 0 })
})

/** 列出已上传的整站包 + 当前导入状态（后台卡片回显；导入失败后可据此提示「重试 = 重来」） */
api.get('/admin/bundle/list', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放导入', 404)
  const listed = await c.env.IMAGES.list({ prefix: BUNDLE_PREFIX, limit: 100 })
  const bundles = (listed.objects ?? [])
    .map((o) => ({ key: o.key, size: o.size ?? 0, uploaded: o.uploaded instanceof Date ? o.uploaded.getTime() : 0 }))
    .sort((a, b) => b.uploaded - a.uploaded)
  return c.json({ bundles, import: await getBundleImportState(c.env.DB) })
})

/** 导入第一步：校验包与版本 → 校验空站 → 清空目标表 → 给出步骤清单 */
api.post('/admin/bundle/import/start', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放导入', 404)
  if (!rateLimit(`bundle-import:${clientIp(c.req.raw)}`, 3, 10 * 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const body = await c.req.json<{ key?: string }>().catch(() => null)
  const r = await startBundleImport(c.env, String(body?.key ?? ''))
  if (!r.ok) return jsonError(r.error, r.status)
  return c.json({ ok: true, plan: r.value })
})

/** 导入步骤：一张表的一个分片，或一批图片（前端按步骤清单循环调用，每步一次小请求） */
api.post('/admin/bundle/import/step', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放导入', 404)
  // 步骤数随站点规模增长（每片一请求），限额给宽；仍是重操作，按全局窗口兜底
  if (!rateLimit('bundle-step:global', 2000, 10 * 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const body = await c.req.json<{ key?: string; unit?: string; cursor?: number }>().catch(() => null)
  const key = String(body?.key ?? '')
  const r = await runBundleImportStep(c.env, key, String(body?.unit ?? ''), Number(body?.cursor ?? -1))
  if (!r.ok) {
    // 记一笔失败态：空站判定允许 failed 残留被下次重试覆盖（重试 = 重来）
    await markBundleImportFailed(c.env, key, r.error)
    return jsonError(r.error, r.status)
  }
  return c.json({ ok: true, ...r.value })
})

/** 导入收尾：置状态 done + 清页缓存 */
api.post('/admin/bundle/import/finish', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放导入', 404)
  const body = await c.req.json<{ key?: string }>().catch(() => null)
  const r = await finishBundleImport(c.env, String(body?.key ?? ''))
  if (!r.ok) return jsonError(r.error, r.status)
  return c.json({ ok: true, import: r.value.state })
})

/** 删除一个整站包（导入成功后不自动删：用户可能还要在别的实例上再导一次） */
api.post('/admin/bundle/delete', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放导入', 404)
  const body = await c.req.json<{ key?: string }>().catch(() => null)
  const key = String(body?.key ?? '')
  if (!key.startsWith(BUNDLE_PREFIX) || key.includes('..') || key.includes('\\') || key.includes('\0')) {
    return jsonError('包标识非法')
  }
  await c.env.IMAGES.delete(key)
  return c.json({ ok: true })
})

/* ---------------- WordPress 导入（B5 搬家导入工具，WXR 1.2） ----------------
 * 两步式：① POST /admin/import/wxr 上传 WXR 全文——解析映射后一次性写入文章 / 页面 /
 * 评论 / 分类标签（保留原状态与原发布时间），图片不阻塞、以附件清单形式返回；
 * ② POST /admin/import/wxr/step 由前端逐批驱动图片转存（Workers 子请求预算扛不住
 * 一次几百张），服务端转存后全局替换正文 / 封面里的旧地址。解析与映射的纯函数在
 * src/import-wxr.ts（tests/import-wxr.test.ts 直接导入）；防线：演示站 404、限流、
 * 上限常量整体 400、正文 sanitizeHtml 落库、不逐篇触发发布广播（防 TG 轰炸）。 */

api.post('/admin/import/wxr', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放导入', 404)
  if (!rateLimit(`wxr-import:${clientIp(c.req.raw)}`, 3, 10 * 60_000)) return jsonError('操作太频繁，请 10 分钟后再试', 429)
  const xml = await c.req.text()
  if (new TextEncoder().encode(xml).length > MAX_WXR_BYTES) return jsonError(`WXR 文件超过 ${Math.floor(MAX_WXR_BYTES / 1024 / 1024)}MB 上限，请在 WordPress 用「按作者 / 日期」分卷导出`)
  const parsed = parseWxr(xml)
  if (!parsed.ok) return jsonError('不是有效的 WordPress 导出文件（WXR / RSS 结构不符）')
  const m = mapWxrImport(parsed.items)
  if (!m.posts.length && !m.pages.length) return jsonError('WXR 里没有可导入的文章或页面（全部被跳过或为空）')
  if (m.posts.length > MAX_IMPORT_POSTS) return jsonError(`文章 ${m.posts.length} 篇超过单次上限 ${MAX_IMPORT_POSTS}，请在 WordPress 按作者 / 日期分卷导出后分批导入`)
  if (m.pages.length > MAX_IMPORT_PAGES) return jsonError(`页面 ${m.pages.length} 个超过单次上限 ${MAX_IMPORT_PAGES}，请分卷导出`)
  if (m.counts.protected > MAX_IMPORT_PASSWORDS) return jsonError(`带访问密码的文章 ${m.counts.protected} 篇超过单次上限 ${MAX_IMPORT_PASSWORDS}（密码哈希是慢操作），请先处理或分卷导入`)
  if (m.images.length > MAX_IMPORT_IMAGES) return jsonError(`附件图片 ${m.images.length} 张超过单次上限 ${MAX_IMPORT_IMAGES}，请在媒体库精简后重新导出，或分卷导入`)

  const db = c.env.DB
  const user = c.get('user')
  const now = Date.now()

  // slug 全量预取（posts + pages 两表、含回收站占用行——与 uniqueSlugIn 同口径），导入期内存去重
  const slugTaken = new Set<string>()
  const [exPost, exPage] = await Promise.all([
    db.prepare('SELECT slug FROM posts WHERE deleted_at IS NULL').all<{ slug: string }>(),
    db.prepare('SELECT slug FROM pages').all<{ slug: string }>(),
  ])
  for (const r of exPost.results ?? []) slugTaken.add(r.slug)
  for (const r of exPage.results ?? []) slugTaken.add(r.slug)
  const nextSlug = (base: string, wpId: number): string => {
    let s = cleanSlug(base) || `wp-${wpId}`
    if (!slugTaken.has(s)) {
      slugTaken.add(s)
      return s
    }
    for (let i = 2; ; i++) {
      const candidate = `${s}-${i}`
      if (!slugTaken.has(candidate)) {
        slugTaken.add(candidate)
        return candidate
      }
    }
  }

  // 分类：现有名字 → id；缺失的先建（slug 用站内 slugify 口径）
  const catRows = await db.prepare('SELECT id, name FROM categories').all<{ id: number; name: string }>()
  const catIdByName = new Map<string, number>((catRows.results ?? []).map((r) => [r.name, r.id]))
  let catSort = (catRows.results ?? []).length
  for (const name of m.categoryNames) {
    if (catIdByName.has(name)) continue
    const cat = await createCategory(db, name, slugify(name), catSort++)
    catIdByName.set(name, cat.id)
  }

  // 文章 / 页面：10 条一批并发插入（逐条 .run() 拿 last_row_id，不做 meta 赌注）
  const postIdByWp = new Map<number, number>()
  let publishedNoTime = 0
  for (let i = 0; i < m.posts.length; i += 10) {
    await Promise.all(
      m.posts.slice(i, i + 10).map(async (p) => {
        const clean = sanitizeHtml(p.content)
        const passwordHash = p.password ? await hashPostPassword(p.password) : ''
        const publishedAt = p.status === 'published' ? (p.publishedAt ?? now) : null
        if (p.status === 'published' && p.publishedAt == null) publishedNoTime++
        const res = await db
          .prepare(
            `INSERT INTO posts (slug, title, content, summary, cover, tags, status, pinned, author_id, published_at, publish_at, min_tier, password_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'all', ?, ?, ?)`
          )
          .bind(
            nextSlug(p.slug || p.title, p.wpId),
            p.title,
            clean,
            // 摘要：WXR 手写摘要优先；密码文留空（summary 是对外导读面，同 api.ts 建文口径）
            p.excerpt.trim() || (passwordHash ? '' : excerpt(clean, 80)),
            '', // 封面由图片转存阶段回填（_thumbnail_id → 附件映射）
            JSON.stringify(p.tags.filter((t) => t)),
            p.status,
            user.id,
            publishedAt,
            p.publishAt,
            passwordHash,
            publishedAt ?? now,
            now
          )
          .run()
        postIdByWp.set(p.wpId, Number(res.meta.last_row_id))
      })
    )
  }
  const pageIdByWp = new Map<number, number>()
  for (let i = 0; i < m.pages.length; i += 10) {
    await Promise.all(
      m.pages.slice(i, i + 10).map(async (p) => {
        const clean = sanitizeHtml(p.content)
        const publishedAt = p.status === 'published' ? (p.publishedAt ?? now) : null
        const res = await db
          .prepare('INSERT INTO pages (title, slug, content, status, show_in_nav, sort, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)')
          .bind(p.title, nextSlug(p.slug || p.title, p.wpId), clean, p.status, publishedAt ?? now, now)
          .run()
        pageIdByWp.set(p.wpId, Number(res.meta.last_row_id))
      })
    )
  }

  // 文章 → 分类关联
  const catLinks: D1PreparedStatement[] = []
  for (const p of m.posts) {
    const postId = postIdByWp.get(p.wpId)
    if (!postId) continue
    const catId = p.categories.map((n) => catIdByName.get(n)).find(Boolean)
    if (catId) catLinks.push(db.prepare('INSERT INTO post_categories (post_id, category_id) VALUES (?, ?)').bind(postId, catId))
  }
  if (catLinks.length) await db.batch(catLinks)

  // 评论：按父引用分层（拓扑序：父评论必在更早的层），层内 10 条并发
  const commentIdByWp = new Map<number, number>()
  const pendingComments = m.comments.slice()
  let insertedComments = 0
  for (;;) {
    const layer = pendingComments.filter((cm) => !cm.parentWpId || commentIdByWp.has(cm.parentWpId))
    if (!layer.length) break
    for (let i = 0; i < layer.length; i += 10) {
      await Promise.all(
        layer.slice(i, i + 10).map(async (cm) => {
          const postId = postIdByWp.get(cm.postKey) ?? pageIdByWp.get(cm.postKey) ?? 0
          if (!postId) return // 目标篇目被跳过（如超长文），评论随之丢弃
          const res = await db
            .prepare(
              `INSERT INTO comments (post_id, weibo_id, parent_id, is_admin, member_id, nickname, email, website, content, status, created_at)
               VALUES (?, 0, ?, 0, 0, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              postId,
              cm.parentWpId ? (commentIdByWp.get(cm.parentWpId) ?? 0) : 0,
              cm.nickname || '匿名',
              cm.email.slice(0, 120),
              cm.website.slice(0, 300),
              sanitizeHtml(cm.content) || '（空评论）',
              cm.status,
              cm.createdAt ?? now
            )
            .run()
          commentIdByWp.set(cm.wpId, Number(res.meta.last_row_id))
          insertedComments++
        })
      )
    }
    for (const cm of layer) {
      const idx = pendingComments.indexOf(cm)
      if (idx !== -1) pendingComments.splice(idx, 1)
    }
  }

  // 内容变更即时失效（AGENTS.md pagecache 节：写库成功后补清理）
  c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({
    ok: true,
    report: {
      posts: m.posts.length,
      pages: m.pages.length,
      comments: insertedComments,
      categories: catLinks.length,
      skipped: m.skipped,
      publishedNoTime,
    },
    images: m.images,
    batches: Math.ceil(m.images.length / IMPORT_IMAGE_BATCH),
  })
})

/** 图片转存分步：前端持附件清单循环驱动，每批 ≤10 张；转存成功后全局替换正文 / 封面里的旧地址 */
api.post('/admin/import/wxr/step', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放导入', 404)
  if (!rateLimit(`wxr-step:${clientIp(c.req.raw)}`, 30, 10 * 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const body = await c.req.json<{ urls?: unknown }>().catch(() => null)
  const urls = Array.isArray(body?.urls) ? body!.urls.filter((u): u is string => typeof u === 'string') : []
  if (!urls.length || urls.length > IMPORT_IMAGE_BATCH) return jsonError('urls 需为 1-10 个图片地址')
  const moved: { from: string; to: string }[] = []
  const failed: string[] = []
  for (const [i, url] of urls.entries()) {
    if (!/^https?:\/\//i.test(url)) {
      failed.push(url)
      continue
    }
    const local = await transferImage(c.env, url, `WP导入图-${i + 1}`)
    if (!local) {
      failed.push(url)
      continue
    }
    await Promise.all([
      c.env.DB.prepare('UPDATE posts SET content = replace(content, ?, ?), cover = replace(cover, ?, ?) WHERE content LIKE ? OR cover = ?')
        .bind(url, local, url, local, `%${url}%`, url)
        .run(),
      c.env.DB.prepare('UPDATE pages SET content = replace(content, ?, ?) WHERE content LIKE ?').bind(url, local, `%${url}%`).run(),
    ])
    moved.push({ from: url, to: local })
  }
  if (moved.length) c.executionCtx.waitUntil(purgePageCache(c.env.DB))
  return c.json({ ok: true, moved, failed })
})

/* ---------------- 清空本站内容（整站搬家的准备步骤：把任何站变回「可导入的空站」） ----------------
 * 与 /admin/bundle/* 同族，但独立成端点（老站想「重新开始」时也能用）。清的表与导入清的是
 * 同一份常量（src/sitebundle.ts BUNDLE_CLEAR_TABLES）；保留设置 / 管理员账号 / 密钥 / 图床文件。
 * 不可撤销——服务端硬校验确认语（resetConfirmOk），UI 的输入框只是引导。 */

api.post('/admin/site/reset', async (c) => {
  // 演示站：体验者凭据公示，一键清站等于把全站（含种子内容）删空且 2 小时才自愈，一律短路
  if (isDemo(c.env)) return jsonError('演示站不支持清空', 404)
  if (!rateLimit(`site-reset:${clientIp(c.req.raw)}`, 3, 10 * 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const body = await c.req.json<{ confirm?: string }>().catch(() => null)
  if (!resetConfirmOk(body?.confirm)) {
    return jsonError(`确认语不正确：请原样输入「${RESET_CONFIRM_PHRASE}」`, 400)
  }
  const r = await resetSiteContent(c.env)
  return c.json({ ok: true, ...r })
})

/* ---------------- 密码 ---------------- */
api.put('/admin/password', async (c) => {
  // 演示站密码公示在登录页，改掉会导致整个重置周期内其他体验者进不了后台
  if (isDemo(c.env)) return jsonError('演示站不支持修改密码', 403)
  const user = c.get('user')
  const body = await c.req.json<{ oldPassword?: string; newPassword?: string }>().catch(() => null)
  const oldPassword = body?.oldPassword || ''
  const newPassword = body?.newPassword || ''
  if (newPassword.length < 8 || newPassword.length > 64) return jsonError('新密码长度需为 8-64 位')
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<{
    password_hash: string
    salt: string
  }>()
  if (!row) return jsonError('用户不存在', 404)
  const { hash } = await hashPassword(oldPassword, row.salt)
  if (!safeEqual(hash, row.password_hash)) return jsonError('旧密码不正确')
  const { hash: newHash, salt: newSalt } = await hashPassword(newPassword)
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?')
    .bind(newHash, newSalt, Date.now(), user.id)
    .run()
  // 改密后其余会话全部失效（保留当前会话，不把自己踢下线），被盗的旧 token 立即作废。
  // 库里存的是 SHA-256(token)，keepToken 必须走 destroyOtherSessions 哈希后再比（拿 Cookie
  // 明文直比恒不相等 = 删光全部会话，曾把「保留当前会话」写成「把自己也踢下线」）
  await destroyOtherSessions(c.env.DB, user.id, getCookie(c.req.raw, SESSION_COOKIE) ?? '')
  return c.json({ ok: true })
})

/* ---------------- 写作工具 ---------------- */
api.post('/admin/tools/md', async (c) => {
  const body = await c.req.json<{ md?: string }>().catch(() => null)
  const md = String(body?.md ?? '')
  // 与正文接口同口径按 UTF-8 字节计（length 是 UTF-16 码元数，全 emoji 输入会虚增 3-4 倍余量）
  if (new TextEncoder().encode(md).length > MAX_CONTENT_BYTES) return jsonError('内容过长')
  return c.json({ html: mdToHtml(md) })
})

/** 链接卡元数据抓取（编辑器「插入链接」卡片风格）：只抓 http(s) 公网页面，
 *  抓不到/解析不到返回空字段，编辑器据已有字段组卡（title 缺失时用域名兜底）。
 *  用户输入的 URL 按用户输入频控；fetch 本身限长限时（src/linkmeta.ts） */
api.post('/admin/tools/linkmeta', async (c) => {
  // 演示站守卫：demo 体验者凭据公示，能触达的出网点一律短路（防线同「订阅与备份」外呼）
  if (isDemo(c.env)) return jsonError('演示站不开放链接卡抓取', 404)
  const body = await c.req.json<{ url?: string }>().catch(() => null)
  const url = String(body?.url ?? '').trim().slice(0, 2048)
  if (!url) return jsonError('请填写链接地址')
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`linkmeta:${ip}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const meta = await fetchLinkMeta(url)
  return c.json({ meta })
})

/** 书影音组卡用的中转基地址（转存失败时豆瓣封面退中转 /img 兜底）；配置不完整回 null */
function validateRelayBase(relay: string, relayToken: string): string | null {
  return validateRelay(relay, relayToken)?.base ?? null
}

/** 组卡前把外链封面转存进站内图床（卡片永久自持——豆瓣图床有防盗链，浏览器直连必挂）；
 *  转存失败时豆瓣图退中转 /img 或省略（resolveCardCover），非豆瓣源 CDN 无防盗链保留直连 */
async function buildCardWithCover(env: Env, item: MediaItem, relayBase: string | null): Promise<string> {
  const cover = (item.cover || '').trim()
  let transferred: string | null = null
  if (cover && !cover.startsWith('/images/')) {
    transferred = await transferImage(env, cover, '书影音封面', coverReferer(cover) || undefined)
  }
  const resolved = resolveCardCover(cover, transferred, relayBase)
  return buildCardHtml({ ...item, cover: resolved.cover })
}

/** 编辑器结果列表的封面缩略图代理（<img> 自动带同源会话 Cookie，注册在鉴权之后）：
 *  豆瓣图床防盗链（无 Referer 418、外站 403），浏览器直连必挂；白名单限常用封面 CDN，
 *  限频 + 体积上限。仅供编辑器预览——正式卡片走转存（buildCardWithCover），不烘代理地址 */
api.get('/admin/tools/douban/img', async (c) => {
  // 演示站守卫：demo 体验者凭据公示，能触达的出网点一律短路
  if (isDemo(c.env)) return jsonError('演示站不开放封面代理', 404)
  const raw = c.req.query('u') || ''
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return jsonError('链接不合法')
  }
  if (u.protocol !== 'https:' || !coverProxyHostOk(u.hostname)) return jsonError('域名不在白名单', 403)
  if (!rateLimit(`doubanimg:${clientIp(c.req.raw)}`, 60, 60_000)) return jsonError('请求过于频繁，请稍后再试', 429)
  try {
    // 出网统一走 fetchsafe：redirect:'manual' 逐跳复查——五域白名单 + fetchableUrl 在每一跳
    // 都成立（曾用 redirect:'follow'，白名单域一旦出现可滥用的 302 就能引 Worker 抓任意
    // URL）；响应体流式限长 1MB（曾整读 arrayBuffer 后才查体积，chunked 大响应可撑爆内存）。
    // Node(undici) 下 manual 重定向放弃抓取 → 502，属 AGENTS 既有取舍（豆瓣封面直链不跳转）
    const r = await fetchPublicResource(u.href, {
      maxBytes: 1_000_000,
      timeoutMs: 8_000,
      headers: { 'User-Agent': BROWSER_UA, Referer: coverReferer(raw) || `${u.origin}/` },
      hostOk: coverProxyHostOk,
    })
    if (!r) return jsonError('封面拉取失败', 502)
    const ct = String(r.res.headers.get('content-type') || '').split(';')[0]
    if (!/^image\/(jpeg|png|webp|gif)$/.test(ct)) return jsonError('非图片响应', 502)
    c.header('Cache-Control', 'private, max-age=86400')
    c.header('X-Content-Type-Options', 'nosniff')
    return c.body(r.buf, 200, { 'Content-Type': ct })
  } catch {
    return jsonError('封面拉取失败', 502)
  }
})

/** 书影音卡片（第三方编辑器插件 douban-media 的数据面），见 src/douban.ts 与 douban-relay/。
 *  中转地址/令牌由插件随请求携带（存插件自己的 localStorage，不进 settings），
 *  本端点只认代码构造的豆瓣地址（粘贴链接仅提取条目 id 重组），不构成开放代理；
 *  插件停用即端点 404（与编辑器侧开关一致），限频同 linkmeta。
 *  封面在组卡时转存进站内图床（buildCardWithCover），零配置即可用；
 *  中转可选，提升豆瓣详情（尤其电影条目页，sec 风控最紧）的成功率 */
api.post('/admin/tools/douban', async (c) => {
  // 演示站守卫：豆瓣搜索/详情/中转探测全是出网调用（中转地址还随请求携带），
  // demo 体验者凭据公示，与 linkmeta 同口径短路
  if (isDemo(c.env)) return jsonError('演示站不开放书影音抓取', 404)
  const settings = await getSettings(c.env.DB)
  const disabled = cleanDisabledPlugins(String(settings.pluginsDisabled ?? ''))
  if (disabled === null || disabled.split(',').includes('douban-media')) return jsonError('书影音插件已停用', 404)
  const body = await c.req
    .json<{
      action?: string
      type?: string
      q?: string
      id?: string
      url?: string
      relay?: string
      relayToken?: string
      tmdbKey?: string
      item?: unknown
    }>()
    .catch(() => null)
  const action = String(body?.action ?? '')
  const type = String(body?.type ?? '')
  if (!['search', 'detail', 'card', 'test'].includes(action)) return jsonError('未知操作')
  if (action !== 'test' && action !== 'card' && !['book', 'movie', 'music'].includes(type)) return jsonError('未知类型')
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`douban:${ip}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  // 外部携带的中转配置收敛长度；TMDB key 是 32 位十六进制（douban.ts 内再校验）
  const relay = String(body?.relay ?? '').trim().slice(0, 2048)
  const relayToken = String(body?.relayToken ?? '').trim().slice(0, 256)
  const tmdbKey = String(body?.tmdbKey ?? '').trim().slice(0, 64)
  try {
    if (action === 'test') return c.json(await probeRelay(relay, relayToken))
    if (action === 'search') {
      const q = String(body?.q ?? '').trim().slice(0, 80)
      if (!q) return jsonError('请输入书名 / 影名 / 曲名')
      return c.json(await searchMedia({ type: type as 'book' | 'movie' | 'music', q, relay, relayToken, tmdbKey }))
    }
    // detail：条目 id 优先（搜索结果点选），也接受粘贴的豆瓣链接（只提取数字 id）；
    // blocked 时插件用搜索结果走 card 动作补卡。卡片封面在此转存进站内图床
    if (action === 'detail') {
      const id = /^\d{1,14}$/.test(String(body?.id ?? '')) ? String(body?.id) : subjectIdFromUrl(String(body?.url ?? ''))
      if (!id) return jsonError('缺少条目 id（或粘贴的链接不含豆瓣 subject）')
      const r = await fetchDoubanDetail({ type: type as 'book' | 'movie' | 'music', id, relay, relayToken })
      const card = r.item ? await buildCardWithCover(c.env, r.item, validateRelayBase(relay, relayToken)) : null
      return c.json({ item: r.item, blocked: r.blocked, card })
    }
    // card：详情被风控时的补卡路径——插件回传搜索结果条目，服务端校验重建后组卡（封面同样转存）
    const item = sanitizeMediaItem(body?.item)
    if (!item) return jsonError('条目数据不完整')
    return c.json({ card: await buildCardWithCover(c.env, item, validateRelayBase(relay, relayToken)) })
  } catch {
    return jsonError('抓取失败，请稍后再试', 502)
  }
})

/** 粘贴净化配套：外链图（公众号 mmbiz.qpic.cn 等有防盗链/随时失效的风险）转存站内图床并改写 src。
 *  转存上限与 collect 同口径（MAX_REMOTE_IMAGES）；单张失败保留原 src 不影响整篇——
 *  但 http:// 的图在 https 站上是混合内容会被浏览器拦，兜底升级成 https:// 再交给浏览器 */
async function rehostPasteImages(env: Env, html: string): Promise<{ html: string; transferred: number }> {
  const srcs = [...new Set([...html.matchAll(/<img\b[^>]*\ssrc="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]))]
  if (!srcs.length) return { html, transferred: 0 }
  const map = new Map<string, string>()
  let transferred = 0
  for (const src of srcs.slice(0, MAX_REMOTE_IMAGES)) {
    const local = await transferImage(env, src, `粘贴配图-${transferred + 1}`)
    if (local) {
      map.set(src, local)
      transferred++
    }
  }
  const out = html.replace(/(<img\b[^>]*\ssrc=")([^"]+)(")/gi, (m, pre: string, src: string, post: string) => {
    const local = map.get(src)
    if (local) return pre + local + post
    if (/^http:\/\//i.test(src)) return pre + `https://${src.slice(7)}` + post
    return m
  })
  return { html: out, transferred }
}

// 一键清理页面缓存（src/pagecache.ts）：换 settings epoch，旧边缘副本整代作废。
// 后台「概览 → 系统」按钮消费；演示站页面本就不缓存，这里无害照常可用
api.post('/admin/cache/purge', async (c) => {
  await purgePageCache(c.env.DB)
  return c.json({ ok: true })
})

api.post('/admin/tools/sanitize', async (c) => {
  // 演示站守卫：rehostPasteImages 会以本站身份抓请求里任意 http(s) 图片（出网点，
  // 与 linkmeta/douban 同口径短路）
  if (isDemo(c.env)) return jsonError('演示站不开放粘贴转存', 404)
  const body = await c.req.json<{ html?: string }>().catch(() => null)
  const html = String(body?.html ?? '')
  if (!rateLimit(`sanitize:${clientIp(c.req.raw)}`, 30, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  if (new TextEncoder().encode(html).length > MAX_CONTENT_BYTES) return jsonError('内容过长')
  const clean = sanitizeHtml(html)
  const r = await rehostPasteImages(c.env, clean)
  return c.json({ html: r.html, transferred: r.transferred })
})

/* ---------------- 公开接口 ---------------- */

/* 微信表情映射表（src/emoji.ts 单一来源）：编辑器/发布器面板与 site.js 客户端渲染共用，
 * 静态数据 + 一天浏览器缓存；闭站时 503——编辑器面板降级为空、文本码插入渲染不受影响 */
api.get('/public/emoji', (c) => {
  c.header('Cache-Control', 'public, max-age=86400')
  return c.json({ base: EMOJI_BASE, codes: WECHAT_EMOJI })
})

api.get('/public/posts', async (c) => {
  // tag 与缓存键侧同口径 trim（审计 C1：服务端不 trim 会让带空白的请求把空结果投毒到干净键上）
  const tag = c.req.query('tag')?.trim() || undefined
  // 站点可见窗口：公开接口与页面同一份口径，不能成为窗口外内容的旁路出口
  const settings = await getSettings(c.env.DB)
  const r = await listPosts(c.env.DB, {
    status: 'published',
    tag,
    page: clampInt(c.req.query('page'), 1, 1000, 1),
    limit: clampInt(c.req.query('limit'), 1, 50, 10),
    afterTs: siteVisibleCutoff(settings),
  })
  return c.json({
    items: r.items.map((p) => toHomePost(p, parseTags(p))),
    total: r.total,
    page: r.page,
    totalPages: r.totalPages,
  })
})

// 广场微博补漏口（docs/PLAZA.md「微博补漏」）：hub 的 RSS 拉取只覆盖文章，微博漏推
// （发布瞬间的推送失败即永久丢失）没有自愈路——这里按 ingest 条目同形出参公开已发布
// 微博，hub 定时拉取对齐（source='pull'，不覆盖 push）。只读公开数据：listWeibo 已过
// 回收站与 status 过滤，微博无锁文概念，出参无敏感字段。
api.get('/public/weibo', async (c) => {
  // 站点可见窗口：hub 补漏拉取的也是窗口内内容（窗口外微博对订阅方同样不存在）
  const settings = await getSettings(c.env.DB)
  const r = await listWeibo(c.env.DB, {
    status: 'published',
    limit: clampInt(c.req.query('limit'), 1, 50, 20),
    afterTs: weiboVisibleCutoff(settings),
  })
  const origin = new URL(c.req.url).origin
  return c.json({
    weibo: r.items.map((w) => {
      // 视频卡无配图时用封面帧充当缩略图（视频文件本身不进 hub，与插件推送同口径，见 src/hooks.ts）
      const img = weiboImageList(w)[0] || (weiboVideoView(w)?.poster ?? '')
      return {
        ref: String(w.id),
        title: excerpt(w.content, 80),
        summary: excerpt(w.content, 500),
        url: `${origin}/weibo#wb-${w.id}`,
        // 与插件推送同口径：站内 /images/ 补前缀，https 外链原样，其余置空（hub 只收 https）
        image: img ? (img.startsWith('/images/') ? origin + img : /^https:\/\//i.test(img) ? img : '') : '',
        publishedAt: w.published_at || w.created_at,
      }
    }),
  })
})

/* ---------------- 公开留言公共核心（文章评论 / 留言板 / 微博评论三路共用） ----------------
 * 开关检查、限流、蜜罐、作者回复、先审后展入库、TG 通知与插件广播全在这里；
 * 三路的差异（称呼文案、归属列、是否收 email/website、通知上下文）由 opts 描述。
 * 目标校验在限流/蜜罐/内容校验之后执行，与三条路的原有顺序一致 */
type CommentBody = {
  slug?: string
  nickname?: string
  content?: string
  email?: string
  website?: string
  parentId?: number
  link?: string
  /** 游客选填 QQ（评论头像 C2 扩展）：仅头像抓取记账位，任何公开出参不携带 */
  qq?: string
}

async function publicComment(
  c: Context<AppEnv>,
  o: {
    kind: 'post' | 'guestbook' | 'weibo'
    /** 文案称呼：「留言」/「评论」（内容为空、回复不存在等） */
    noun: string
    closedMessage: string
    freqMessage: string
    /** 文章评论接收 email/website，其余两路不收 */
    withContact?: boolean
    /** 归属与通知上下文；目标不存在返回 Response（404）。visCutoff = 页面口径的可见窗口
     *  生效 cutoff（0 = 放行）——目标行时间早于它时按「不存在」404（防「直链 404 但留言
     *  接口 200」的存在性探测旁路，与旧 slug 301 的信息差禁令同款） */
    target: (body: CommentBody | null, visCutoff: number) => Promise<{ postId: number; weiboId: number; context?: string; path: string } | Response>
  }
): Promise<Response> {
  const db = c.env.DB
  const settings = await getSettings(db)
  const user = await getSessionUser(db, c.req.raw)
  if (!user && settings.allowComments !== '1') return jsonError(o.closedMessage, 403)
  // 会员身份（与管理员互斥取一路；banned 已在 getMemberUser 查询层视为未登录）
  const member = user ? null : await getMemberUser(db, c.req.raw)
  const ip = clientIp(c.req.raw)
  // IP 属地快照（src/ipregion.ts）：与 ip 同一请求瞬间定格，采集无条件（与 ip 本体同类的
  // 内部数据），展示与否由 settings.showCommentRegion 在出参端门控——开关不影响采集
  const ipRegion = regionSnapshot(c.req.raw)
  // 管理员发言不受留言频率限制；会员是登录身份，放宽到 10 条/10 分钟（仍防滥用），游客维持 5 条
  if (!user && !member && !rateLimit(`cmt:${ip}`, 5, 10 * 60_000)) return jsonError(o.freqMessage, 429)
  if (member && !rateLimit(`mcmt:${member.id}`, 10, 10 * 60_000)) return jsonError(o.freqMessage, 429)
  // 会员限流补 IP 桶：只按账号限不住「批量注册小号各发 10 条」的 Sybil 打法（注册零验证成本）；
  // NAT 共享 IP 放宽到 20 条/10 分钟，正常家庭/办公网够用
  if (member && !rateLimit(`mcmt-ip:${ip}`, 20, 10 * 60_000)) return jsonError(o.freqMessage, 429)
  const body = await c.req.json<CommentBody>().catch(() => null)
  // 蜜罐字段：正常用户不会填写，机器人会 —— 静默丢弃
  if (body?.link) return c.json({ ok: true })
  const content = String(body?.content || '').trim().slice(0, 1000)
  if (!content) return jsonError(`${o.noun}内容不能为空`)

  // 站点可见窗口（API 侧与页面同口径）：窗口外内容直链已 404，留言接口不得成为「存在性
  // 探测旁路」——豁免规则单一来源 utils.pageWindowCutoff（管理员豁免仅文章、会员豁免按站点开关）。
  // user / member 已在上面加载，这里直接复用，不再各查一次会话
  const visCutoff =
    o.kind === 'guestbook'
      ? 0
      : pageWindowCutoff(settings, o.kind === 'weibo' ? 'weibo' : 'posts', { admin: !!user, member: !!member })

  const t = await o.target(body, visCutoff)
  if (t instanceof Response) return t

  const parentId = Number(body?.parentId) || 0
  const now = Date.now()
  // 回复目标校验（作者与会员两路共用）：parent 必须存在于同一归属下；
  // 楼中楼扁平化沿用既有口径——回复一律挂线程根（parent.parent_id || parent.id）
  let parent: CommentRow | null = null
  if (parentId) {
    // 会员 3.0 起放开会员回复；游客仍不可（匿名楼中楼是刷量面，也不利于「收到的回复」归账）
    if (!user && !member) return jsonError(`登录后才能回复${o.noun}`, 403)
    const scopeCond = o.kind === 'post' ? 'post_id = ?' : o.kind === 'weibo' ? 'weibo_id = ?' : 'post_id = 0 AND weibo_id = 0'
    const scopeBind = o.kind === 'guestbook' ? [] : [o.kind === 'post' ? t.postId : t.weiboId]
    parent = await db.prepare(`SELECT * FROM comments WHERE id = ? AND ${scopeCond}`).bind(parentId, ...scopeBind).first<CommentRow>()
    if (!parent) return jsonError(`要回复的${o.noun}不存在`, 404)
  }
  if (user) {
    // 作者发言（回复或自己留言）：直接展示，带「作者」徽标
    await db
      .prepare(
        "INSERT INTO comments (post_id, weibo_id, parent_id, is_admin, nickname, content, status, ip, ip_region, created_at) VALUES (?, ?, ?, 1, ?, ?, 'approved', ?, ?, ?)"
      )
      .bind(
        t.postId,
        t.weiboId,
        parent ? parent.parent_id || parent.id : 0,
        (user.display_name || user.username).slice(0, 24),
        content,
        ip,
        ipRegion,
        now
      )
      .run()
    // 作者发言直接上公开页面（审计 C2：作者回复不触发 onCommentCreated，缓存清理要单挂）
    c.executionCtx.waitUntil(purgePageCache(c.env.DB))
    return c.json({ ok: true })
  }

  const pending = settings.moderateComments === '1'
  if (member) {
    // 会员发言（评论或回复）：身份来自会话，表单昵称/邮箱/网站字段一律忽略（契约 A5）；先审后展口径与游客一致
    const nickname = (member.display_name || member.username).slice(0, 24)
    const ins = await db
      .prepare(
        'INSERT INTO comments (post_id, weibo_id, parent_id, member_id, is_admin, nickname, content, status, ip, ip_region, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        t.postId,
        t.weiboId,
        parent ? parent.parent_id || parent.id : 0,
        member.id,
        nickname,
        content,
        pending ? 'pending' : 'approved',
        ip,
        ipRegion,
        now
      )
      .run()
    // 新留言推送 TG 与插件广播（与游客同路，见下方游客分支注释）
    const base = siteBase(settings, new URL(c.req.url).origin)
    c.executionCtx.waitUntil(
      notifyAdminComment(c.env, { kind: o.kind, context: t.context, nickname, content, pending, siteBase: base, path: t.path })
    )
    c.executionCtx.waitUntil(
      fireCommentCreated(c.env, { kind: o.kind, context: t.context, nickname, content, url: base + t.path, pending })
    )
    // 评论积分：过审才计（awardCommentPoints 内按 ref_id 去重，反复切换状态不重复记）
    const commentId = Number(ins.meta.last_row_id)
    if (!pending && commentId) c.executionCtx.waitUntil(awardCommentPoints(db, member.id, commentId))
    return c.json({ ok: true, pending })
  }
  const nickname = String(body?.nickname || '').trim().slice(0, 24)
  if (!nickname) return jsonError(`昵称和${o.noun}内容不能为空`)
  // 游客 QQ 头像（评论头像 C2 扩展）：选填，格式不对按「没填」处理——选填字段不拦评论。
  // 先查同号历史头像直接复用（抓取次数 = 唯一 QQ 数，且被评论限流再压一层），未命中才出站抓取；
  // qq 本体只落库内部列，任何公开出参不携带，头像一律站内转存同源输出
  const qqRaw = String(body?.qq || '').trim()
  const guestQQ = qqRaw && isValidQQ(qqRaw) ? qqRaw : ''
  const guestAvatar = guestQQ
    ? (await db
        .prepare("SELECT avatar FROM comments WHERE qq = ? AND avatar != '' ORDER BY created_at DESC LIMIT 1")
        .bind(guestQQ)
        .first<{ avatar: string }>())?.avatar || (await fetchQQAvatar(c.env, guestQQ)) || ''
    : ''
  if (o.withContact) {
    await db
      .prepare(
        'INSERT INTO comments (post_id, weibo_id, parent_id, is_admin, nickname, email, website, qq, avatar, content, status, ip, ip_region, created_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        t.postId,
        t.weiboId,
        nickname,
        String(body?.email || '').slice(0, 100),
        String(body?.website || '').slice(0, 200),
        guestQQ,
        guestAvatar,
        content,
        pending ? 'pending' : 'approved',
        ip,
        ipRegion,
        now
      )
      .run()
  } else {
    await db
      .prepare(
        'INSERT INTO comments (post_id, weibo_id, parent_id, is_admin, nickname, qq, avatar, content, status, ip, ip_region, created_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(t.postId, t.weiboId, nickname, guestQQ, guestAvatar, content, pending ? 'pending' : 'approved', ip, ipRegion, now)
      .run()
  }
  // 新留言推送到 Telegram（异步，不阻塞回复；开关在后台「设置 → 外部发布」）
  const base = siteBase(settings, new URL(c.req.url).origin)
  c.executionCtx.waitUntil(
    notifyAdminComment(c.env, { kind: o.kind, context: t.context, nickname, content, pending, siteBase: base, path: t.path })
  )
  // 广播评论事件给服务端插件（评论 webhook 等，见 src/hooks.ts）
  c.executionCtx.waitUntil(
    fireCommentCreated(c.env, { kind: o.kind, context: t.context, nickname, content, url: base + t.path, pending })
  )
  return c.json({ ok: true, pending })
}

api.post('/public/comments', async (c) =>
  publicComment(c, {
    kind: 'post',
    noun: '留言',
    closedMessage: '作者已关闭留言',
    freqMessage: '留言太频繁，休息一下吧',
    withContact: true,
    target: async (body, visCutoff) => {
      const slug = String(body?.slug || '').slice(0, 100)
      const post = await getPostBySlug(c.env.DB, slug)
      if (!post || post.status !== 'published') return jsonError('文章不存在', 404)
      // 站点可见窗口：窗口外文章的留言同口径 404（直链已是 404，留言接口不能多透露一个比特）
      if (visCutoff && (post.published_at ?? post.created_at ?? 0) < visCutoff) return jsonError('文章不存在', 404)
      return { postId: post.id, weiboId: 0, context: post.title, path: `/post/${encodeURIComponent(post.slug)}#comments` }
    },
  })
)
/* ---------------- 留言板（公开，post_id 与 weibo_id 均为 0 即留言板留言） ---------------- */
api.post('/public/guestbook', async (c) =>
  publicComment(c, {
    kind: 'guestbook',
    noun: '留言',
    closedMessage: '作者已关闭留言',
    freqMessage: '留言太频繁，休息一下吧',
    target: async () => ({ postId: 0, weiboId: 0, path: '/guestbook' }),
  })
)
/* ---------------- 微博互动（点赞 + 评论，公开） ---------------- */
/** 页面口径的可见窗口 cutoff（公开 API 与 renderPost / renderWeibo 对齐）：
 *  窗口关闭恒 0、不查会话；开启时豁免规则走 utils.pageWindowCutoff（管理员豁免仅文章、
 *  「不限制会员」的会员豁免），两个会话都懒查——绝大多数站没开窗口，零开销 */
async function pageVisibleCutoff(db: D1Database, req: Request, settings: Awaited<ReturnType<typeof getSettings>>, kind: 'posts' | 'weibo'): Promise<number> {
  const base = kind === 'weibo' ? weiboVisibleCutoff(settings) : siteVisibleCutoff(settings)
  if (!base) return 0
  const admin = kind === 'posts' ? !!(await getSessionUser(db, req)) : false
  const member =
    settings.membersEnabled === '1' && !visibleRangeAppliesToMembers(settings) ? !!(await getMemberUser(db, req)) : false
  return pageWindowCutoff(settings, kind, { admin, member })
}

/** 会员点赞记账（会员 3.0 预备，会员中心「我的点赞」）：登录会员的赞落 member_likes、取消赞删行。
 *  异步不阻塞点赞响应；新增点赞的「目标存活」校验在调用点做（与 likeDelta 只对 published 行生效同口径） */
async function trackMemberLike(c: Context<AppEnv>, targetType: 'post' | 'weibo', targetId: number, delta: number): Promise<void> {
  const member = await getMemberUser(c.env.DB, c.req.raw)
  if (!member) return
  if (delta === -1) {
    await removeMemberLike(c.env.DB, member.id, targetType, targetId)
    return
  }
  await recordMemberLike(c.env.DB, member.id, targetType, targetId, Date.now())
}

api.post('/public/like/weibo/:id', async (c) => {
  // 限流防脚本刷赞刷踩（正常用户连点几条微博远够用）
  if (!rateLimit(`like:${clientIp(c.req.raw)}`, 30, 10 * 60_000)) return jsonError('操作太频繁了，休息一下吧', 429)
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('参数错误')
  const body = await c.req.json<{ delta?: number }>().catch(() => null)
  const delta = body?.delta === -1 ? -1 : 1
  // 站点可见窗口：窗口外微博的点赞同口径收口（未命中回 0，与「不存在」同响应）
  const settings = await getSettings(c.env.DB)
  const cutoff = await pageVisibleCutoff(c.env.DB, c.req.raw, settings, 'weibo')
  const likes = await likeDelta(c.env.DB, 'weibo', 'id', String(id), delta, cutoff)
  // 会员点赞记账（member_likes 按微博 id 记，取消赞删行）；窗口外内容点赞未命中不落账
  const wb = await getWeiboById(c.env.DB, id)
  if (delta === 1) {
    if (wb && wb.status === 'published' && (cutoff <= 0 || (wb.published_at ?? wb.created_at ?? 0) >= cutoff))
      c.executionCtx.waitUntil(trackMemberLike(c, 'weibo', id, 1))
  } else {
    c.executionCtx.waitUntil(trackMemberLike(c, 'weibo', id, -1))
  }
  return c.json({ ok: true, likes })
})

api.get('/public/weibo/:id/comments', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('参数错误')
  const wb = await getWeiboById(c.env.DB, id)
  if (!wb || wb.status !== 'published') return jsonError('这条微博不存在', 404)
  const settings = await getSettings(c.env.DB)
  // 站点可见窗口：窗口外微博的评论列表同口径 404（页面 404 的微博，评论不单独可见）
  const cutoff = await pageVisibleCutoff(c.env.DB, c.req.raw, settings, 'weibo')
  if (cutoff && (wb.published_at ?? wb.created_at ?? 0) < cutoff) return jsonError('这条微博不存在', 404)
  // IP 属地（src/ipregion.ts）：展示开关门控在服务端——关闭时连 ip_region 列都不进 SELECT，
  // 开启时出参已是格式化好的标签（en 按 isEn 口径），客户端只渲染字符串不做映射
  const showRegion = settings.showCommentRegion === '1'
  const en = isEn(settings)
  // INDEXED BY 同 weiboCommentCountMap 口径（生产实测规划器会误选 idx_comments_status
  // 全表扫全部已审评论；「weibo_id 等值 + status 过滤」一族强制走 (weibo_id) 前导索引）
  const { results } = await c.env.DB
    .prepare(
      `SELECT cm.id, cm.parent_id, cm.is_admin, cm.nickname, cm.content, cm.created_at, cm.avatar${
        showRegion ? ', cm.ip_region' : ''
      }, m.display_name AS member_name, m.tier AS member_tier, m.tier_expires_at AS member_tier_expires_at, m.avatar AS member_avatar FROM comments cm INDEXED BY idx_comments_weibo LEFT JOIN members m ON m.id = cm.member_id WHERE cm.weibo_id = ? AND cm.status = 'approved' ORDER BY cm.created_at ASC LIMIT 200`
    )
    .bind(id)
    .all()
  // 认证徽标（src/tiers.ts）在服务端解析成展示串：生效档位非基础档才给 tier_name/tier_color
  // （基础档回落「会员」普通徽标，客户端按 member_name 渲染）——客户端零判定逻辑，改口径只动这里。
  // tier_expires_at 只在服务端参与过期判定，出参前剥掉（有效期是会员本人视角的数据，不随公开评论外发）
  const badgeOn = settings.showMemberBadge !== '0'
  const defs = parseMemberTiers(settings.memberTiers)
  const now = Date.now()
  const comments = (results ?? []).map((r: Record<string, unknown>) => {
    if (badgeOn && r.member_tier) {
      const eff = effectiveTier(defs, String(r.member_tier), (r.member_tier_expires_at as number | null) ?? null, now)
      r.member_tier_name = eff.isBase ? '' : eff.name
      r.member_tier_color = eff.isBase ? '' : eff.color
    }
    delete r.member_tier_expires_at
    return showRegion ? { ...r, ip_region: ipRegionLabel(String(r.ip_region || ''), en) } : r
  })
  // memberName 驱动微博评论的「回复」按钮（会员可回复，游客没有按钮）；匿名访客千人一面才配吃缓存，
  // 会员 Cookie 在场时 pagecache 本就回源（pageCacheKeyFor 挡），不会串身份
  const member = settings.membersEnabled === '1' ? await getMemberUser(c.env.DB, c.req.raw) : null
  return c.json({
    comments,
    allowComments: settings.allowComments === '1',
    adminAvatar: settings.avatarUrl || '',
    memberName: member ? (member.display_name || member.username).slice(0, 24) : '',
  })
})

api.post('/public/weibo/:id/comments', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('参数错误')
  return publicComment(c, {
    kind: 'weibo',
    noun: '评论',
    closedMessage: '作者已关闭评论',
    freqMessage: '评论太频繁，休息一下吧',
    target: async (_body, visCutoff) => {
      const wb = await getWeiboById(c.env.DB, id)
      if (!wb || wb.status !== 'published') return jsonError('这条微博不存在', 404)
      // 站点可见窗口：窗口外微博的评论同口径 404（直链 /weibo 定位不到，评论接口不能多透露一个比特）
      if (visCutoff && (wb.published_at ?? wb.created_at ?? 0) < visCutoff) return jsonError('这条微博不存在', 404)
      return { postId: 0, weiboId: id, context: excerpt(wb.content, 40), path: `/weibo?wb=${id}#wb-${id}` }
    },
  })
})
api.post('/public/like/:slug', async (c) => {
  if (!rateLimit(`like:${clientIp(c.req.raw)}`, 30, 10 * 60_000)) return jsonError('操作太频繁了，休息一下吧', 429)
  const slug = c.req.param('slug').slice(0, 100)
  const body = await c.req.json<{ delta?: number }>().catch(() => null)
  const delta = body?.delta === -1 ? -1 : 1
  // 站点可见窗口：窗口外文章的点赞同口径收口（未命中回 0，与「不存在」同响应）
  const settings = await getSettings(c.env.DB)
  const cutoff = await pageVisibleCutoff(c.env.DB, c.req.raw, settings, 'posts')
  const likes = await likeDelta(c.env.DB, 'posts', 'slug', slug, delta, cutoff)
  // 会员点赞记账（member_likes 按文章 id 记；取消赞删行）；窗口外内容点赞未命中不落账
  const post = await getPostBySlug(c.env.DB, slug)
  if (delta === 1) {
    if (post && post.status === 'published' && (cutoff <= 0 || (post.published_at ?? post.created_at ?? 0) >= cutoff))
      c.executionCtx.waitUntil(trackMemberLike(c, 'post', post.id, 1))
  } else {
    if (post) c.executionCtx.waitUntil(trackMemberLike(c, 'post', post.id, -1))
  }
  return c.json({ ok: true, likes })
})

/* ---------------- 访客统计打点（公开，site.js 上报，见 src/stats.ts） ---------------- */
api.post('/public/track', async (c) => {
  // 30 次/10 分钟/IP：正常访客到不了（浏览自增另有 1h/IP/post 去重）；这是无鉴权的 D1 写入面
  // （每请求一行 INSERT），限流宽度直接决定被代理池烧穿 D1 日写配额的量级
  if (!rateLimit(`track:${clientIp(c.req.raw)}`, 30, 10 * 60_000)) return jsonError('请求过于频繁，请稍后再试', 429)
  const settings = await getSettings(c.env.DB)
  if (settings.statsEnabled === '0') return c.json({ ok: true })
  const body = await c.req.json<{ p?: string; r?: string; v?: string; t?: string }>().catch(() => null)
  const path = cleanPath(body?.p)
  // 正常页面路径必然以 / 开头，不合法的一律丢弃（裸 curl 刷接口拿不到有效数据）
  if (!path) return c.json({ ok: true })
  const ua = c.req.header('User-Agent') || ''
  // 打点失败不影响页面（表未就绪等极端情况也走这里）
  c.executionCtx.waitUntil(
    recordVisit(c.env.DB, {
      path,
      title: cleanTitle(body?.t),
      ref: cleanRef(body?.r),
      vid: cleanVid(body?.v),
      dev: classifyDevice(ua),
      br: classifyBrowser(ua),
      country: (c.req.header('CF-IPCountry') || '').slice(0, 8),
    }).catch(() => {})
  )
  return c.json({ ok: true })
})

/* ---------------- 友链申请（公开，进入待审核） ---------------- */
api.post('/public/links/apply', async (c) => {
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`flapply:${ip}`, 3, 10 * 60_000)) return jsonError('提交太频繁了，请稍后再试', 429)
  const body = await c.req
    .json<{ name?: string; url?: string; description?: string; link?: string }>()
    .catch(() => null)
  // 蜜罐字段：正常用户不会填写，机器人会 —— 静默丢弃
  if (body?.link) return c.json({ ok: true })
  const name = String(body?.name || '').trim().slice(0, 40)
  const url = normalizeLinkUrl(String(body?.url || ''))
  const description = String(body?.description || '').trim().slice(0, 120)
  if (!name || !url) return jsonError('站名和网址不能为空')
  const dup = await c.env.DB.prepare('SELECT id FROM friend_links WHERE url = ?').bind(url).first<{ id: number }>()
  if (dup) return jsonError('这个网址已经在友链列表里啦')
  await c.env.DB.prepare(
    "INSERT INTO friend_links (name, url, description, icon, status, sort, source, ip, created_at, updated_at) VALUES (?, ?, ?, '', 'pending', 0, 'user', ?, ?, ?)"
  )
    .bind(name, url, description, ip, Date.now(), Date.now())
    .run()
  return c.json({ ok: true })
})

api.get('/meta/themes', (c) => {
  // 纯静态数据（只依赖部署内的常量，不读库不读会话）：短缓存省一次往返
  c.header('Cache-Control', 'public, max-age=3600')
  return c.json({
    themes: Object.values(THEMES).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      colors: t.colors ?? null,
      // 外观变量元信息（B9 · 内测）：当前主题支持的角色 / 默认值 / 正文字号基线 / 字体预设
      appearance: appearanceMeta(t.id),
    })),
  })
})
