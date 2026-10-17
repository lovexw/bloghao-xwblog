import { test } from 'node:test'
import assert from 'node:assert/strict'
import { base32Decode, base32Encode, generateTotpSecret, totpCode, totpProvisioningUri, verifyTotp } from '../src/totp'

/* RFC 6238 §B（SHA-1）官方测试向量：
 * secret = ASCII "12345678901234567890"（20 字节），30s 步长，6 位 = 8 位码 % 1e6。
 * T=59s → counter 1 → 287082；T=1111111109s → counter 37037036 → 081804。 */
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'))

test('RFC 向量：T=59s（counter 1）→ 755224；T=1111111109（counter 37037036）→ 081804', async () => {
  assert.equal(await totpCode(RFC_SECRET, 59_000), '287082')
  // RFC 6238 §B 的 T2：T=1111111109s，8 位码 07081804 → 六位 = 081804
  assert.equal(await totpCode(RFC_SECRET, 1111111109_000), '081804')
})

test('窗口容差：±1 步可过、±2 步不过；格式不对恒 false', async () => {
  const now = 59_000
  const code = await totpCode(RFC_SECRET, now)
  assert.equal(await verifyTotp(RFC_SECRET, code, now), true)
  assert.equal(await verifyTotp(RFC_SECRET, code, now + 30_000), true) // 下一窗（容差）
  assert.equal(await verifyTotp(RFC_SECRET, code, now - 30_000), true) // 上一窗
  assert.equal(await verifyTotp(RFC_SECRET, code, now + 60_000), false) // 超窗
  assert.equal(await verifyTotp(RFC_SECRET, '75522', now), false)
  assert.equal(await verifyTotp(RFC_SECRET, 'abcdef', now), false)
  assert.equal(await verifyTotp(RFC_SECRET, '', now), false)
  assert.equal(await verifyTotp('JBSWY3DPEHPK3PXQ', '000000', now) === true, false) // 未命中不误判
  assert.equal(await verifyTotp('', '755224', now), false) // 空 secret 恒 false
})

test('base32 往返与手抄容错：大小写 / 空格 / 连字符均可解码', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 77, 128, 7])
  const enc = base32Encode(bytes)
  assert.deepEqual([...base32Decode(enc)], [...bytes])
  // 用户手抄形态：小写 + 空格 + 连字符
  assert.deepEqual([...base32Decode(enc.toLowerCase().replace(/(.{4})/g, '$1- '))], [...bytes])
  assert.equal(base32Decode('!!!!').length, 0)
})

test('generateTotpSecret：32 字符 base32（20 字节熵）、解码后 20 字节、两次不重复', () => {
  const a = generateTotpSecret()
  const b = generateTotpSecret()
  assert.match(a, /^[A-Z2-7]{32}$/)
  assert.equal(base32Decode(a).length, 20)
  assert.notEqual(a, b)
})

test('provisioning URI：含 secret / issuer / 账号，账号特殊字符已编码', () => {
  const uri = totpProvisioningUri('JBSWY3DPEHPK3PXQ', 'xiao wu@example.com')
  assert.ok(uri.startsWith('otpauth://totp/BlogHao%3Axiao%20wu%40example.com'))
  assert.ok(uri.includes('secret=JBSWY3DPEHPK3PXQ'))
  assert.ok(uri.includes('issuer=BlogHao'))
})

/* ============================ 端到端：真库登录链路（同 tests/mcp.test.ts 薄壳模式） ============================ */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// api.ts 经 render.ts 引入主题（.css）——先挂顶替 hook 再动态加载（同 tests/themes.test.ts）
register('./tests/css-loader.mjs', pathToFileURL(`${process.cwd()}/`))
const { api } = await import('../src/api')
const { ensureSchema, saveSettings, getSettings } = await import('../src/db')
type Env = import('../src/types').Env

const ROOT2 = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL2 = readFileSync(join(ROOT2, 'schema.sql'), 'utf8')

function d1FromSqlite(db: DatabaseSync): D1Database {
  const cache = new Map<string, import('node:sqlite').StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = db.prepare(sql)))
    return st
  }
  const handlers = (sql: string, binds: unknown[]) => ({
    run: async () => {
      const info = stmtOf(sql).run(...(binds as never[]))
      return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } }
    },
    all: async <T>() => ({ results: stmtOf(sql).all(...(binds as never[])) as T[] }),
    first: async <T>() => ((stmtOf(sql).get(...(binds as never[])) as T | undefined) ?? null),
  })
  return {
    prepare: (sql: string) => {
      const unbound = handlers(sql, [])
      return { ...unbound, bind: (...binds: unknown[]) => handlers(sql, binds) }
    },
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      for (const s of stmts) await s.run()
      return []
    },
  } as unknown as D1Database
}

test('端到端：启用 TOTP → 登录必须带码 → 错码 401 对码 200 → 会话列表与撤销', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL2)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  const env = { DB: d1, IMAGES: {}, ASSETS: {} } as unknown as Env
  const ec = { waitUntil: () => {}, passThroughOnException: () => {} } as never

  const setup = await api.request('https://blog.example.com/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'secadmin', password: 'sec-pass-12345', displayName: '安全员' }),
  }, env, ec)
  assert.equal(setup.status, 200)
  const cookie1 = (setup.headers.get('set-cookie') || '').split(';')[0]

  // 未开启时 /auth/state 不含 needsTotp
  const st0 = (await (await api.request('https://blog.example.com/auth/state', {}, env, ec)).json()) as { needsTotp: boolean }
  assert.equal(st0.needsTotp, false)

  // 绑定：setup 返回 secret / uri / qrSvg，pending 落库
  const bind = await api.request('https://blog.example.com/admin/totp/setup', { method: 'POST', headers: { Cookie: cookie1 } }, env, ec)
  assert.equal(bind.status, 200)
  const bindData = (await bind.json()) as { secret: string; uri: string; qrSvg: string }
  assert.match(bindData.secret, /^[A-Z2-7]{32}$/)
  assert.ok(bindData.uri.startsWith('otpauth://totp/'))
  assert.ok(bindData.qrSvg.includes('<svg'))

  // 未验证码就 enable → 400；空 code → 400
  const badEnable = await api.request('https://blog.example.com/admin/totp/enable', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie1 }, body: JSON.stringify({ code: '000000' }) }, env, ec)
  assert.equal(badEnable.status, 400)

  // 正确码启用（enable 频次 5/分钟——此前 1 次，未超）
  const code = await totpCode(bindData.secret, Date.now())
  const enable = await api.request('https://blog.example.com/admin/totp/enable', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie1 }, body: JSON.stringify({ code }) }, env, ec)
  assert.equal(enable.status, 200)
  const s = await getSettings(d1)
  assert.equal(s.totpEnabled, '1')
  assert.equal(s.totpSecretPending, '')

  // state 现在 needsTotp=true
  const st1 = (await (await api.request('https://blog.example.com/auth/state', {}, env, ec)).json()) as { needsTotp: boolean }
  assert.equal(st1.needsTotp, true)

  // 登录：不带码 → 401「两步验证码不对」；带错码 → 401
  const noCode = await api.request('https://blog.example.com/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'secadmin', password: 'sec-pass-12345' }),
  }, env, ec)
  assert.equal(noCode.status, 401)
  const wrong = await api.request('https://blog.example.com/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'secadmin', password: 'sec-pass-12345', totp: '000000' }),
  }, env, ec)
  assert.equal(wrong.status, 401)

  // 带对码 → 200 + 新会话（±1 窗口容差内都能过）
  const okLogin = await api.request('https://blog.example.com/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'secadmin', password: 'sec-pass-12345', totp: await totpCode(bindData.secret, Date.now()) }),
  }, env, ec)
  assert.equal(okLogin.status, 200)
  const cookie2 = (okLogin.headers.get('set-cookie') || '').split(';')[0]

  // 会话列表：两个会话（setup 会话 + 登录会话），isCurrent 指向请求方
  const list1 = await api.request('https://blog.example.com/admin/sessions', { headers: { Cookie: cookie1 } }, env, ec)
  const list1Data = (await list1.json()) as { sessions: { tokenHash: string; isCurrent: boolean }[] }
  assert.equal(list1Data.sessions.length, 2)
  assert.equal(list1Data.sessions.filter((x) => x.isCurrent).length, 1)

  // 撤销：从 cookie2 的视角拉列表，非 current 的那个 = cookie1 的会话 → 踢掉后 cookie1 再访问 401
  const list2 = await api.request('https://blog.example.com/admin/sessions', { headers: { Cookie: cookie2 } }, env, ec)
  const list2Data = (await list2.json()) as { sessions: { tokenHash: string; isCurrent: boolean }[] }
  const other = list2Data.sessions.find((x) => !x.isCurrent)!
  const kick = await api.request('https://blog.example.com/admin/sessions', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: cookie2 }, body: JSON.stringify({ tokenHash: other.tokenHash }) }, env, ec)
  if (kick.status !== 200) console.log('KICK-DEBUG', kick.status, await kick.clone().text(), 'target=', other.tokenHash.slice(0, 12), 'len', other.tokenHash.length)
  assert.equal(kick.status, 200)
  const afterKick = await api.request('https://blog.example.com/admin/sessions', { headers: { Cookie: cookie1 } }, env, ec)
  assert.equal(afterKick.status, 401)

  // 关闭：密码确认 → needsTotp 回 false
  const disable = await api.request('https://blog.example.com/admin/totp/disable', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie2 }, body: JSON.stringify({ password: 'sec-pass-12345' }) }, env, ec)
  assert.equal(disable.status, 200)
  const st2 = (await (await api.request('https://blog.example.com/auth/state', {}, env, ec)).json()) as { needsTotp: boolean }
  assert.equal(st2.needsTotp, false)
  // 密码错 → 400（disable 频次 5/分钟：已用 1，未超）
  const badDisable = await api.request('https://blog.example.com/admin/totp/disable', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie2 }, body: JSON.stringify({ password: 'wrong-pass' }) }, env, ec)
  assert.equal(badDisable.status, 400)
})
