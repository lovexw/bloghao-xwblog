/**
 * TOTP 两步验证（RFC 6238，B13 管理员安全包）
 * ===========================================
 * 零依赖纯函数（依赖预算：crypto.subtle 的 HMAC-SHA1 是 Web 标准能力，qrcode.ts 零依赖先例同款）。
 * Node 测试直接导入（tests/totp.test.ts，含 RFC 4226/6238 官方向量）。
 *
 * 口径：
 * - secret 落库为 base32（RFC 4648 无填充，验证器 App 的标准格式），存 settings `totpSecret`
 *   （SECRET_SETTINGS 打码族）；`totpEnabled` 独立开关——secret 在场而开关未开 = 绑定流程进行中
 * - 时间步长 30s、6 位码、验证窗口 ±1 步（时钟偏移容忍，RFC 6238 §5.2 建议做法）
 * - 校验必须走 verifyTotp（恒时比较 + 窗口扫描）；别在端点里手写 % 1e6 比对
 * - 拒绝码重放是 TOTP 的标准限制（同一码 30s 内可重复用），靠登录端点既有的限流兜底；
 *   不引入「已用步数」记账（Workers 内存态不跨 isolate，做不真，宁缺毋假）
 */

import { safeEqual } from './auth'

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 编码（无填充——验证器 App 的标准形态） */
export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let val = 0
  for (const b of bytes) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(val << (5 - bits)) & 31]
  return out
}

/** RFC 4648 base32 解码：忽略大小写 / 空格 / 连字符（用户手抄密钥的容错），非法字符跳过 */
export function base32Decode(s: string): Uint8Array {
  const clean = String(s || '').toUpperCase().replace(/[\s-]/g, '')
  let bits = 0
  let val = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx === -1) continue
    val = (val << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** 生成新 secret：20 字节随机（RFC 6238 §5.1 推荐强度）→ base32 */
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return base32Encode(bytes)
}

async function hotp(secretB32: string, counter: number): Promise<string> {
  const key = base32Decode(secretB32)
  if (!key.length) return ''
  const msg = new Uint8Array(8)
  // 64 位 big-endian 计数器（Number 拆高低 32 位，counter 超过 2^32 也在 68 年后，仍按位写对）
  let c = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = c % 256
    c = Math.floor(c / 256)
  }
  const k = await crypto.subtle.importKey('raw', key as never, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg as never))
  // RFC 4226 §5.3 动态截断
  const off = sig[sig.length - 1] & 0x0f
  const bin =
    ((sig[off] & 0x7f) << 24) | ((sig[off + 1] & 0xff) << 16) | ((sig[off + 2] & 0xff) << 8) | (sig[off + 3] & 0xff)
  return String(bin % 1_000_000).padStart(6, '0')
}

/** 计算某时刻的 TOTP 码（timeStep 毫秒时间戳；30s 步长 / 6 位） */
export async function totpCode(secretB32: string, timeStep: number): Promise<string> {
  return hotp(secretB32, Math.floor(timeStep / 30_000))
}

/** 验证当前 ±1 窗口内的 6 位码（三次窗口全跑保持耗时稳定；safeEqual 恒时比较；secret 无效恒 false） */
export async function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): Promise<boolean> {
  const clean = String(code || '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  if (!base32Decode(secretB32).length) return false
  const step = Math.floor(nowMs / 30_000)
  const candidates = [step, step - 1, step + 1]
  let ok = false
  for (const s of candidates) {
    const expect = await hotp(secretB32, s)
    if (expect && safeEqual(expect, clean)) ok = true
  }
  return ok
}

/** 验证器 App 的配对 URI（otpauth 标准；issuer=BlogHao，账号=管理员用户名） */
export function totpProvisioningUri(secretB32: string, account: string): string {
  const label = encodeURIComponent(`BlogHao:${account || 'admin'}`)
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=BlogHao&algorithm=SHA1&digits=6&period=30`
}
