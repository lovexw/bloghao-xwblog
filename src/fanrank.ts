/**
 * 铁粉成长体系（会员 3.0，DEVPLAN-3.0 主题一）
 * ============================================
 * 等级 = f(积分, 活跃天数) 的**纯函数实时判定**，不落库——改等级表立即全站生效，无需迁移。
 * 活跃天数 / 签到连续天数的**写入**在 points.ts 与 api.ts（checkin 端点、登录记账点）；
 * 本文件只管「读侧语义」：等级判定、名号、下一级差距。Node 测试直接导入（tests/fanrank.test.ts）。
 *
 * 口径（2026-10-18 与站长对齐）：
 * - L1 读者是「或」门槛（积分或活跃任一达标，欢迎新人）；L2 起是「且」门槛（常客要既舍得又常来）
 * - 积分用**当前余额**（含签到/评论所得，也含管理员调整）——消费类玩法（M2 抽奖扣分）会让等级
 *   随余额波动，这是有意设计：成长是「当前状态」不是「终身成就」，降级是纪律的一部分
 * - 封禁会员（status='banned'）查询层已视为不可见（getMemberUser 挡），等级展示随之消失
 */

import { cstDate } from './utils'

export interface FanLevel {
  /** 0=路人 1=读者 2=常客 3=铁粉 4=至交 */
  level: 0 | 1 | 2 | 3 | 4
  name: string
  /** 下一级的差距（level 4 时为 null——已是顶格） */
  next: { name: string; points: number; days: number } | null
}

interface FanTierRule {
  level: 1 | 2 | 3 | 4
  name: string
  points: number
  days: number
  /** true = 积分或活跃任一达标即晋（欢迎新人）；缺省 = 两者同时达标 */
  any?: boolean
}

/** 等级表（改门槛只改这里，纯函数判定无迁移成本） */
export const FAN_TIERS: readonly FanTierRule[] = [
  { level: 1, name: '读者', points: 10, days: 3, any: true },
  { level: 2, name: '常客', points: 50, days: 7 },
  { level: 3, name: '铁粉', points: 200, days: 21 },
  { level: 4, name: '至交', points: 500, days: 60 },
]

export const FAN_LEVEL_NAMES = ['路人', '读者', '常客', '铁粉', '至交'] as const

/** 等级判定：**从最高档往下**找第一个满足的（L1 的「或」门槛不能拦住已够 L2/L3 的人）；L0 路人是兜底 */
export function fanLevel(points: number, activeDays: number): FanLevel {
  const pts = Math.max(0, Math.trunc(points || 0))
  const days = Math.max(0, Math.trunc(activeDays || 0))
  for (const t of [...FAN_TIERS].reverse()) {
    const met = t.any ? pts >= t.points || days >= t.days : pts >= t.points && days >= t.days
    if (!met) continue
    const nextRule = FAN_TIERS.find((x) => x.level === t.level + 1)
    return {
      level: t.level,
      name: t.name,
      next: nextRule ? { name: nextRule.name, points: nextRule.points, days: nextRule.days } : null,
    }
  }
  return { level: 0, name: FAN_LEVEL_NAMES[0], next: { name: FAN_TIERS[0].name, points: FAN_TIERS[0].points, days: FAN_TIERS[0].days } }
}

/** 徽标短名（rank / 会员卡展示用） */
export function fanLevelName(points: number, activeDays: number): string {
  return fanLevel(points, activeDays).name
}

/** 北京墙上日期（YYYY-MM-DD）——签到日判定（api.ts checkin）、活跃日累计（points.ts bumpActiveDay）、
 *  「今日已签」展示（api.ts memberView / pages.ts 会员卡）四处共用的时间口径。
 *  收敛在本文件：消费方都已依赖 fanrank，放 utils 反而多一条与本模块无关的耦合。 */
export function fanDay(ts = Date.now()): string {
  const d = cstDate(ts)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * 连续签到天数推算：昨签过 → +1 延续；断签 → 归 1 重来。
 * today/yesterday 是 `YYYY-MM-DD` 北京墙上日期（fanDay 生成）。
 */
export function nextStreak(lastCheckinDay: string, today: string, yesterday: string, current: number): number {
  if (lastCheckinDay === today) return Math.max(1, Math.trunc(current || 0)) // 今日已签，维持
  return lastCheckinDay === yesterday ? Math.max(0, Math.trunc(current || 0)) + 1 : 1
}
