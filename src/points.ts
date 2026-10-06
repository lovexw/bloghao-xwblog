/**
 * 积分规则引擎（会员体系，契约见 docs/DEVPLAN-2026-10-07.md 附录 A）
 *
 * 数值常量集中本文件一处：用户拍板调整只改 POINTS_RULES，不动任何调用点
 * （2026-10-07 已拍板：评论 +2、每日登录 +1）。独立成模块便于 Node 测试导入（同 trash.ts / closed.ts 模式）。
 * 记分一律走 awardPoints：自带单日上限（北京时间自然日）与同账本去重，调用点不得手写 INSERT/UPDATE。
 */
import { cstDate } from './utils'

export type PointsReason = 'comment' | 'dailyLogin' | 'adminAdjust'

export const POINTS_RULES: Record<PointsReason, { delta: number; /** 单日最多计次（按额度算，不按调用次数） */ dailyCap: number; label: string }> = {
  // 评论 +2：过审才计（先审后展的挂到后台通过动作），同一评论只计一次（ref_id = 评论 id 去重）
  comment: { delta: 2, dailyCap: 10, label: '发表留言/评论' },
  // 每日登录 +1：当天重复登录不再计（cap=1 天然幂等）
  dailyLogin: { delta: 1, dailyCap: 1, label: '每日登录' },
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
  if (reason !== 'adminAdjust' && rule.dailyCap > 0) {
    const row = await db
      .prepare(
        'SELECT COALESCE(SUM(delta), 0) AS s FROM member_points_log WHERE member_id = ? AND reason = ? AND created_at >= ?'
      )
      .bind(memberId, reason, cstDayStart())
      .first<{ s: number }>()
    if ((row?.s ?? 0) + delta > rule.dailyCap * Math.abs(rule.delta)) {
      return { ok: false, delta: 0, balance: await memberBalance(db, memberId) }
    }
  }
  const now = Date.now()
  await db.batch([
    db
      .prepare('INSERT INTO member_points_log (member_id, delta, reason, ref_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(memberId, delta, reason, opts.refId ?? 0, opts.note ?? '', now),
    db.prepare('UPDATE members SET points = points + ?, updated_at = ? WHERE id = ?').bind(delta, now, memberId),
  ])
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
