/**
 * 会员档位体系（会员 3.0 预备，DEVPLAN-3.0 主题一扩展）
 * =====================================================
 * 档位（tier）从写死的 normal/coffee/top 三值升级为**站长自定义**：
 * 定义存在 settings.memberTiers（JSON 数组，顺序即等级——排前面的低、排后面的高），
 * 每档带展示名 / 认证徽标色 / 是否永久 / 后台分配的默认有效期天数。
 * members.tier 存档位 key，members.tier_expires_at 存到期时间（NULL = 不失效）；
 * **过期不靠 cron**：读侧 effectiveTier 即时判定，过期会员当场按基础档（第一档）生效。
 *
 * 付费墙口径：posts.min_tier = 'all' | 'member'（任意登录会员）| 档位 key；
 * canReadTiers 用「生效档位的等级 ≥ 文章档位的等级」判定。老库键（coffee/top）不在
 * 自定义定义里时按历史映射兜底（coffee=2 / top=3），其余未知键当「登录会员可见」。
 *
 * 纯函数 + Node 可直接导入（tests/tiers.test.ts），同 fanrank.ts / points.ts 模式。
 */

/** 档位 key 形态：小写字母开头，字母数字 _ -（落库进 members.tier / posts.min_tier 的合法形态） */
export const TIER_KEY_RE = /^[a-z][a-z0-9_-]{0,23}$/

export interface MemberTierDef {
  /** 稳定标识：建好后不改（posts.min_tier 与 members.tier 都引用它），展示名可随时改 */
  key: string
  /** 展示名（1-12 字，站长自定义；英文版原样透传，同站长自填内容口径） */
  name: string
  /** 认证徽标色 #rgb / #rrggbb，'' = 用主题默认色 */
  color: string
  /** true = 永久有效（基础档恒为永久）；false = 后台分配时带有效期 */
  permanent: boolean
  /** 非永久档的默认有效期天数（后台「分配档位」的快捷值，0 = 无默认） */
  days: number
  /** 等级（parse 时按数组序号生成：1 起，大者高）；clean 输出带 rank，原始输入不带 */
  rank?: number
}

/** 默认三档（与历史 tier 值 normal/coffee/top 对齐，老数据无缝）：
 *  普通会员永久；咖啡会员 / 付费会员默认按 365 天分配（站长可改可删可加档） */
export const DEFAULT_MEMBER_TIERS: MemberTierDef[] = [
  { key: 'normal', name: '普通会员', color: '', permanent: true, days: 0 },
  { key: 'coffee', name: '咖啡会员', color: '#c9803e', permanent: false, days: 365 },
  { key: 'top', name: '付费会员', color: '#e0455a', permanent: false, days: 365 },
]

const TIER_NAME_MAX = 12
const TIER_MAX_COUNT = 10
const TIER_DAYS_MAX = 3650

/** 颜色白名单：#rgb / #rrggbb（进 style 属性，必须收敛形态防注入） */
function cleanTierColor(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(s) ? s : ''
}

/**
 * 校验并规整一份档位定义（后台 PUT settings.memberTiers 的唯一入口）。
 * 规则：2-10 档；key 唯一且过 TIER_KEY_RE；第一档必须是永久（它承载「过期/无档」的兜底身份）；
 * 名称 1-12 字；days 取整 0-3650。**返回 null = 格式非法**（调用方 400，不静默降级——
 * 站长得知道「保存了但没生效」是输入问题，与 contentVisibleRange 同口径）。
 */
export function cleanMemberTiers(raw: unknown): MemberTierDef[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length < 1 || raw.length > TIER_MAX_COUNT) return null
  const seen = new Set<string>()
  const out: MemberTierDef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const b = item as Record<string, unknown>
    const key = typeof b.key === 'string' ? b.key.trim() : ''
    // 'all' / 'member' 是付费墙的伪档（公开 / 任意登录会员），保留字不准占用
    if (!TIER_KEY_RE.test(key) || key === 'all' || key === 'member' || seen.has(key)) return null
    seen.add(key)
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, TIER_NAME_MAX) : ''
    if (!name) return null
    const days = Math.trunc(Number(b.days))
    const permanent = !!b.permanent
    if (!Number.isFinite(days) || days < 0 || days > TIER_DAYS_MAX) return null
    out.push({ key, name, color: cleanTierColor(b.color), permanent, days: permanent ? 0 : days })
  }
  if (!out[0].permanent) return null // 第一档是全体会员的兜底身份，必须永久
  return out.map((d, i) => ({ ...d, rank: i + 1 }))
}

/** settings.memberTiers 存量值 → 档位定义；空 / 脏 JSON / 校验不过一律回默认三档
 *  （读侧宁可用默认也不挂——脏配置不能打瘫全站会员面） */
export function parseMemberTiers(v: string | null | undefined): MemberTierDef[] {
  if (!v || !v.trim()) return withRank(DEFAULT_MEMBER_TIERS)
  try {
    const cleaned = cleanMemberTiers(JSON.parse(v))
    return cleaned ? cleaned : withRank(DEFAULT_MEMBER_TIERS)
  } catch {
    return withRank(DEFAULT_MEMBER_TIERS)
  }
}

function withRank(defs: MemberTierDef[]): MemberTierDef[] {
  return defs.map((d, i) => (d.rank !== undefined ? d : { ...d, rank: i + 1 }))
}

/** 基础档（第一档）：过期会员 / 定义缺失的档位都落到它身上 */
export function baseTier(defs: MemberTierDef[]): MemberTierDef {
  return defs[0]
}

export function tierByKey(defs: MemberTierDef[], key: string | null | undefined): MemberTierDef | null {
  const k = (key || '').trim()
  if (!k) return null
  return defs.find((d) => d.key === k) ?? null
}

/** 生效档位视图（读侧统一出口）：过期 / 定义缺失 → 基础档，expired 标注「已过期」供展示 */
export interface EffectiveTier {
  key: string
  name: string
  color: string
  rank: number
  /** true = 档位仍在但已过有效期（展示「已过期」，能力已按基础档生效） */
  expired: boolean
  /** true = 基础档（普通会员）：不渲染认证徽标 */
  isBase: boolean
}

export function effectiveTier(
  defs: MemberTierDef[],
  tier: string | null | undefined,
  tierExpiresAt: number | null | undefined,
  now = Date.now()
): EffectiveTier {
  const base = baseTier(defs)
  const def = tierByKey(defs, tier)
  if (!def || def.key === base.key) {
    return { key: base.key, name: base.name, color: base.color, rank: 1, expired: false, isBase: true }
  }
  if (!def.permanent && tierExpiresAt != null && tierExpiresAt <= now) {
    return { key: base.key, name: base.name, color: base.color, rank: 1, expired: true, isBase: true }
  }
  return { key: def.key, name: def.name, color: def.color, rank: def.rank ?? 1, expired: false, isBase: false }
}

/**
 * 文章档位 → 所需等级：'all'/空 = 0（公开）；'member' = 1（任意登录会员）；
 * 自定义 key = 其 rank；老库键不在定义里按历史映射兜底；其余未知键当「登录会员可见」
 * （宁可挡在登录这一层，不把站长设过档的正文静默放成全网可见）。
 */
export function minTierRank(defs: MemberTierDef[], minTier: string | null | undefined): number {
  const v = (minTier || '').trim()
  if (!v || v === 'all') return 0
  if (v === 'member') return 1
  const def = tierByKey(defs, v)
  if (def) return def.rank ?? 1
  if (v === 'coffee') return 2
  if (v === 'top') return 3
  return 1
}

/**
 * 付费墙可见判定（canRead 的自定义档位版）：need <= 0 公开；游客一律不可读；
 * 会员按**生效档位**（过期即基础档）与所需等级比较。
 */
export function canReadTiers(
  defs: MemberTierDef[],
  minTier: string | null | undefined,
  member: { tier: string; tier_expires_at?: number | null } | null | undefined,
  now = Date.now()
): boolean {
  const need = minTierRank(defs, minTier)
  if (need <= 0) return true
  if (!member || !member.tier) return false
  const eff = effectiveTier(defs, member.tier, member.tier_expires_at, now)
  return eff.rank >= need
}
