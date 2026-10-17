import { test } from 'node:test'
import assert from 'node:assert/strict'
import { feishuSign, notifyEventList, notifyText, wecomClip } from '../src/hooks'
import { fetchableUrl } from '../src/linkmeta'

/* ── 文案组装（三渠道共用一份口径） ── */

test('notifyText：新留言（含待审核态与来源）/ 备份完成', () => {
  const c = notifyText('comment_created', { nickname: '张三', content: '写得真好！', context: '一年后的复盘', url: 'https://x.example.com/post/a#c-1', pending: false })
  assert.ok(c.includes('【博客号·新留言】张三（已展示）在「一年后的复盘」'))
  assert.ok(c.includes('写得真好！') && c.includes('https://x.example.com/post/a#c-1'))
  const pending = notifyText('comment_created', { nickname: '李四', content: 'hi', pending: true })
  assert.ok(pending.includes('待审核'))
  const guestbook = notifyText('comment_created', { nickname: '王五', content: 'x' })
  assert.ok(guestbook.includes('「留言板」')) // context 缺省 = 留言板
  const long = notifyText('comment_created', { nickname: '赵六', content: '字'.repeat(200) })
  assert.ok(long.length < 200) // 正文截 100
  const backup = notifyText('backup_completed', { key: 'backups/xwblog-2026-10-17.json', bytes: 512 * 1024, tables: 12 })
  assert.ok(backup.includes('backups/xwblog-2026-10-17.json') && backup.includes('12 张表') && backup.includes('512 KB'))
})

/* ── 企微字节截断（text.content ≤ 2048 字节口径，留余量按 2000） ── */

test('wecomClip：超 2000 字节按字符尾删，中文不劈半', () => {
  assert.equal(wecomClip('短文本'), '短文本')
  const big = '字'.repeat(1500) // 4500 字节
  const clipped = wecomClip(big)
  assert.ok(new TextEncoder().encode(clipped).length <= 2000)
  assert.ok(clipped.length === 666) // 666*3 = 1998 ≤ 2000
})

/* ── 飞书签名（与 node:crypto HMAC 对照） ── */

test('feishuSign：base64(HMAC-SHA256(secret, `${ts}\n${secret}`)) 与 node:crypto 一致', async () => {
  const { createHmac } = await import('node:crypto')
  const ts = '1760700000'
  const secret = 'my-feishu-secret'
  const expect = createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64')
  assert.equal(await feishuSign(secret, ts), expect)
})

/* ── 事件过滤 ── */

test('notifyEventList：空 = 全部、子集白名单、非法拒发', () => {
  assert.equal(notifyEventList(''), 'all')
  assert.equal(notifyEventList('  '), 'all')
  assert.deepEqual(notifyEventList('comment_created'), ['comment_created'])
  assert.deepEqual(notifyEventList('backup_completed, comment_created'), ['backup_completed', 'comment_created'])
  assert.equal(notifyEventList('post_published'), 'invalid') // 不在通知面（那是广播件的事件）
  assert.equal(notifyEventList('comment_created,xxx'), 'invalid') // 坏清单拒发
})

/* ── configValidate 域白名单（借 fetchableUrl 的公网校验 + 插件域限制） ── */

test('域白名单口径：飞书 / 企微限官方域，Bark 允许自建', () => {
  // 这三条直接复刻插件 configValidate 的正则口径（插件对象非导出，用同款判断守住漂移）
  const feishuOk = /^https:\/\/(open\.feishu\.cn|open\.larksuite\.cn|open\.larksuite\.com)\//i
  const wecomOk = /^https:\/\/qyapi\.weixin\.qq\.com\//i
  assert.ok(feishuOk.test('https://open.feishu.cn/open-apis/bot/v2/hook/xxx'))
  assert.ok(feishuOk.test('https://open.larksuite.com/open-apis/bot/v2/hook/xxx'))
  assert.ok(!feishuOk.test('https://evil.example.com/open-apis/bot/v2/hook/xxx'))
  assert.ok(wecomOk.test('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'))
  assert.ok(!wecomOk.test('https://qyapi.weixin.qq.com.evil.com/cgi-bin/webhook/send?key=x'))
  // Bark 自建：fetchableUrl 放行公网 https，拒绝内网
  assert.ok(fetchableUrl('https://bark.my-server.com') !== null)
  assert.equal(fetchableUrl('http://127.0.0.1:8080'), null)
  assert.equal(fetchableUrl('https://192.168.1.1/'), null)
})
