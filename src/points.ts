/**
 * 积分规则引擎（会员体系，契约见 docs/archive/DEVPLAN-2026-10-07.md 附录 A）
 *
 * 数值常量集中本文件一处：用户拍板调整只改 POINTS_RULES，不动任何调用点
 * （2026-10-07 已拍板：评论 +2、每日登录 +1）。独立成模块便于 Node 测试导入（同 trash.ts / closed.ts 模式）。
 * 记分一律走 awardPoints：自带单日上限（北京时间自然日）与同账本去重，调用点不得手写 INSERT/UPDATE。
 */
import { cstDate } from './utils'
import { fanDay } from './fanrank'
import { canReadTiers, parseMemberTiers, TIER_KEY_RE } from './tiers'

export type PointsReason = 'comment' | 'dailyLogin' | 'checkin' | 'streakBonus' | 'adminAdjust'

export const POINTS_RULES: Record<PointsReason, { delta: number; /** 单日最多计次（按额度算，不按调用次数） */ dailyCap: number; label: string }> = {
  // 评论 +2：过审才计（先审后展的挂到后台通过动作），同一评论只计一次（ref_id = 评论 id 去重）
  comment: { delta: 2, dailyCap: 10, label: '发表留言/评论' },
  // 每日登录 +1：当天重复登录不再计（cap=1 天然幂等）
  dailyLogin: { delta: 1, dailyCap: 1, label: '每日登录' },
  // 每日签到 +2（铁粉体系 3.0-M1）：显式动作，ref_id = 北京日序号幂等；连续加成单独记账
  checkin: { delta: 2, dailyCap: 1, label: '每日签到' },
  // 连续签到加成 +1：连续 ≥7 天的当天额外计（断签清零重来，api.ts checkin 端点判定）
  streakBonus: { delta: 1, dailyCap: 1, label: '连续签到加成' },
  // 管理员调整：delta 由调用方给定（可负），不受日上限约束（P1.5 后台接口落地时接入）
  adminAdjust: { delta: 0, dailyCap: 0, label: '管理员调整' },
}

/** 北京时间当日 0 点的毫秒时间戳（日上限与「每日登录」的去重窗口；同 utils.ts cstDate 口径） */
export function cstDayStart(ts = Date.now()): number {
  const d = cstDate(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600_000
}

export interface AwardResult {
  ok: boolean
  /** 本次实际记账的分值（被日上限/幂等拦下时为 0） */
  delta: number
  balance: number
}

async function memberBalance(db: D1Database, memberId: number): Promise<number> {
  const r = await db.prepare('SELECT points FROM members WHERE id = ?').bind(memberId).first<{ points: number }>()
  return r?.points ?? 0
}

/**
 * 给会员记一笔积分：写账本 + 增加余额（同一 batch，防账本与余额漂移）。
 * - 非adminAdjust 走常量表 delta，且当日累计（北京时间）不超过 dailyCap × delta
 * - adminAdjust 用 opts.delta 给定值（可负），不受日上限约束
 * - reason 用字符串入参 + hasOwnProperty 校验（防原型链属性穿透，同仓库枚举口径）
 */
export async function awardPoints(
  db: D1Database,
  memberId: number,
  reason: string,
  opts: { refId?: number; note?: string; delta?: number } = {}
): Promise<AwardResult> {
  if (!Object.prototype.hasOwnProperty.call(POINTS_RULES, reason)) {
    return { ok: false, delta: 0, balance: await memberBalance(db, memberId) }
  }
  const rule = POINTS_RULES[reason as PointsReason]
  const delta = reason === 'adminAdjust' ? Math.trunc(opts.delta ?? 0) : rule.delta
  if (delta === 0) return { ok: false, delta: 0, balance: await memberBalance(db, memberId) }
  // refId 承担幂等键：评论 = 评论 id（awardCommentPoints 去重）；每日登录 = 北京日序号（并发双击由
  // member_points_log 的 (member_id, reason, ref_id) 部分唯一索引兜底，见 db.ts SCHEMA_INDEXES / schema.sql）。
  // adminAdjust 代码层强制 refId=0（不进唯一索引）：手动调整允许任意次同值操作，防未来调用方
  // 误传 refId>0 被索引当成幂等键静默丢账（AGENTS 积分防线「别给 adminAdjust 传非 0 refId」的硬约束版）
  // checkin / streakBonus 与 dailyLogin 同用北京日序号做幂等键（同日重复点击被唯一索引拦下）
  const daySerial = Math.floor(cstDayStart() / 86400000)
  const refId =
    reason === 'dailyLogin' || reason === 'checkin' || reason === 'streakBonus'
      ? daySerial
      : reason === 'adminAdjust'
        ? 0
        : opts.refId ?? 0
  const capped = reason !== 'adminAdjust' && rule.dailyCap > 0
  const cap = rule.dailyCap * Math.abs(rule.delta)
  const dayStart = cstDayStart()
  if (capped) {
    const row = await db
      .prepare(
        'SELECT COALESCE(SUM(delta), 0) AS s FROM member_points_log WHERE member_id = ? AND reason = ? AND created_at >= ?'
      )
      .bind(memberId, reason, dayStart)
      .first<{ s: number }>()
    if ((row?.s ?? 0) + delta > cap) {
      return { ok: false, delta: 0, balance: await memberBalance(db, memberId) }
    }
  }
  const now = Date.now()
  try {
    if (capped) {
      // 日上限的最终守卫下沉进批内:上面的 SUM 预查与写入之间存在并发窗口(不同评论 id
      // 不受部分唯一索引约束,一窗并发可全部通过同一快照把当日额度刷穿)。批内三语句原子:
      // ②条件 UPDATE(SUM 含本批 INSERT,D1 batch 事务内可见)与③条件 DELETE 谓词互斥
      // (SUM<=cap 入账保留 / SUM>cap 本行摘除),以②的 changes 判定是否入账;refId>0 时
      // (member_id, reason, ref_id) 唯一定位本行,adminAdjust(ref_id=0)不走此分支
      const sumSql =
        '(SELECT COALESCE(SUM(delta), 0) FROM member_points_log WHERE member_id = ? AND reason = ? AND created_at >= ?)'
      const res = await db.batch([
        db
          .prepare('INSERT INTO member_points_log (member_id, delta, reason, ref_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(memberId, delta, reason, refId, opts.note ?? '', now),
        db
          .prepare(`UPDATE members SET points = points + ?, updated_at = ? WHERE id = ? AND ${sumSql} <= ?`)
          .bind(delta, now, memberId, memberId, reason, dayStart, cap),
        db
          .prepare(`DELETE FROM member_points_log WHERE member_id = ? AND reason = ? AND ref_id = ? AND ${sumSql} > ?`)
          .bind(memberId, reason, refId, memberId, reason, dayStart, cap),
      ])
      const granted = (res[1].meta.changes ?? 0) === 1
      return { ok: granted, delta: granted ? delta : 0, balance: await memberBalance(db, memberId) }
    }
    await db.batch([
      db
        .prepare('INSERT INTO member_points_log (member_id, delta, reason, ref_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(memberId, delta, reason, refId, opts.note ?? '', now),
      db.prepare('UPDATE members SET points = points + ?, updated_at = ? WHERE id = ?').bind(delta, now, memberId),
    ])
  } catch (e) {
    // 并发重复记账撞部分唯一索引（同一评论两路同时过审 / 双击登录）：视为已记过，静默不落
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      return { ok: false, delta: 0, balance: await memberBalance(db, memberId) }
    }
    throw e
  }
  return { ok: true, delta, balance: await memberBalance(db, memberId) }
}

/**
 * 评论积分：过审才计、同一评论只计一次。
 * 即时通过（未开先审后展）在发言当下调用；先审后展的挂到后台「通过」动作再调用——
 * 两路共用这里的 ref_id 去重，反复 通过↔待审 不会重复记分。
 */
export async function awardCommentPoints(db: D1Database, memberId: number, commentId: number): Promise<void> {
  const dup = await db
    .prepare("SELECT 1 AS x FROM member_points_log WHERE reason = 'comment' AND member_id = ? AND ref_id = ? LIMIT 1")
    .bind(memberId, commentId)
    .first()
  if (dup) return
  await awardPoints(db, memberId, 'comment', { refId: commentId })
}

/* ---------------- 可见档位（契约 A0/A2：posts.min_tier） ----------------
 * 档位定义已升级为站长自定义（src/tiers.ts，settings.memberTiers）：这里保留历史常量与
 * canRead 包装做兼容—— rank 解析 / 过期降级 / 自定义档位判定一律以 tiers.ts 为准 */

export type MinTier = 'all' | 'member' | 'coffee' | 'top'

/** 文章档位 → 所需等级（历史口径）：游客 0，登录会员 1，咖啡 2，顶级 3 */
export const MIN_TIER_RANK: Record<string, number> = { all: 0, member: 1, coffee: 2, top: 3 }
/** 会员档位 → 等级（normal 与文章档 'member' 同级：登录即可看） */
export const MEMBER_TIER_RANK: Record<string, number> = { normal: 1, coffee: 2, top: 3 }

/** 脏值归一：min_tier 落库前/读取时统一过这里。'all' / 'member' 直认；其余放行 TIER_KEY_RE
 *  形态的自定义档位 key（rank 在读侧 minTierRank 解析，未知键当「登录会员可见」），
 *  其他脏值按公开兜底（宁可漏展示、不锁死站长自有内容） */
export function normalizeMinTier(v: string | null | undefined): MinTier | string {
  const s = (v ?? '').trim()
  if (!s || s === 'all') return 'all'
  if (s === 'member') return 'member'
  return TIER_KEY_RE.test(s) ? s : 'all'
}

/** 可见判定：会员等级 ≥ 文章档位即可读。游客按 0。
 *  兼容包装：走默认三档定义（自定义档位场景在调用方用 canReadTiers 传真实定义） */
export function canRead(minTier: string | null | undefined, tier: string | null | undefined): boolean {
  return canReadTiers(parseMemberTiers(undefined), minTier, tier ? { tier } : null)
}

/** 活跃天数累计（铁粉体系 3.0-M1）：北京日条件更新幂等——同日重复登录/签到不重复计天。
 *  挂在 dailyLogin 记账点与 checkin 端点；封禁会员的调用点已被上游挡（getMemberUser 查询层） */
export async function bumpActiveDay(db: D1Database, memberId: number): Promise<void> {
  const today = fanDay()
  await db
    .prepare(
      "UPDATE members SET active_days = active_days + 1, last_active_day = ? WHERE id = ? AND (last_active_day IS NULL OR last_active_day = '' OR last_active_day < ?)"
    )
    .bind(today, memberId, today)
    .run()
}
