import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bufferPostText, fireCommentCreated, firePostPublished, fireWeiboPublished, listServerPlugins, renderFooterHtml } from '../src/hooks.ts'
import { DEFAULT_SETTINGS } from '../src/db.ts'
import type { Env, SettingsMap } from '../src/types.ts'

// ── 服务端插件钩子（roadmap A5）：总线过滤 + 官方示例插件行为 + 失败吞掉 ──

const settings = (over: Partial<SettingsMap>): SettingsMap => ({ ...DEFAULT_SETTINGS, ...over })

/** getSettings 只用 prepare().all()，桩掉整个 D1（注意包一层 Env：fire 函数取 env.DB） */
function fakeEnv(rows: { key: string; value: string }[] = []): Env {
  return {
    DB: { prepare: () => ({ all: async () => ({ results: rows }) }) } as unknown as D1Database,
  } as unknown as Env
}

/** 抓 fetch 调用（示例插件全部走 fetch 外发） */
function captureFetch() {
  const calls: { url: string; init?: RequestInit }[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = orig
    },
  }
}

test('页脚注入：footerHtmlCode 进页脚，停用名单可关掉', () => {
  const s = settings({ footerHtmlCode: '<div class="badge">🌙 365 天</div>' })
  assert.equal(renderFooterHtml(s), '<div class="badge">🌙 365 天</div>')
  const off = settings({ footerHtmlCode: '<div>x</div>', serverPluginsDisabled: 'footer-html' })
  assert.equal(renderFooterHtml(off), '')
  // 其他插件被停用不影响 footer-html
  const otherOff = settings({ footerHtmlCode: '<i>hi</i>', serverPluginsDisabled: 'tg-channel,comment-webhook' })
  assert.equal(renderFooterHtml(otherOff), '<i>hi</i>')
  assert.equal(renderFooterHtml(settings({})), '')
})

test('发布同步 TG 频道：token+频道ID 齐才发，消息带标题与链接，可被停用', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([
      { key: 'telegramBotToken', value: 'tok123' },
      { key: 'tgChannelChatId', value: '@mychannel' },
      { key: 'siteUrl', value: 'https://blog.example.com/' },
    ])
    await firePostPublished(env, { slug: 'hello', title: '新文章', summary: '摘要', via: 'scheduler' })
    assert.equal(cap.calls.length, 1)
    assert.match(cap.calls[0].url, /api\.telegram\.org\/bottok123\/sendMessage/)
    const body = JSON.parse(String(cap.calls[0].init?.body))
    assert.equal(body.chat_id, '@mychannel')
    assert.match(body.text, /新文章/)
    assert.match(body.text, /https:\/\/blog\.example\.com\/post\/hello/)
    // 频道 ID 未填：静默不发
    await firePostPublished(fakeEnv([{ key: 'telegramBotToken', value: 'tok123' }]), {
      slug: 'x', title: 't', summary: '', via: 'admin',
    })
    // 插件被停用：不发
    await firePostPublished(
      fakeEnv([
        { key: 'telegramBotToken', value: 'tok123' },
        { key: 'tgChannelChatId', value: '@mychannel' },
        { key: 'serverPluginsDisabled', value: 'tg-channel' },
      ]),
      { slug: 'x', title: 't', summary: '', via: 'admin' }
    )
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})

test('微博同步 Buffer：key+渠道齐才发，mode=shareNow，站内图拼 siteUrl，可被停用', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([
      { key: 'bufferAccessToken', value: 'bf-tok' },
      { key: 'bufferChannelId', value: 'chan1' },
      { key: 'siteUrl', value: 'https://blog.example.com/' },
    ])
    await fireWeiboPublished(env, { id: 7, content: '随手记 #随拍#', images: ['/images/a.jpg', 'https://cdn.example.com/b.png'], via: 'admin' })
    assert.equal(cap.calls.length, 1)
    assert.equal(cap.calls[0].url, 'https://api.buffer.com')
    assert.equal(cap.calls[0].init?.headers && (cap.calls[0].init.headers as Record<string, string>)['authorization'], 'Bearer bf-tok')
    const body = JSON.parse(String(cap.calls[0].init?.body))
    const input = body.variables.input
    assert.equal(input.channelId, 'chan1')
    assert.equal(input.mode, 'shareNow')
    assert.equal(input.schedulingType, 'automatic')
    assert.equal(input.text, '随手记 #随拍')
    assert.deepEqual(input.assets, [
      { image: { url: 'https://blog.example.com/images/a.jpg' } },
      { image: { url: 'https://cdn.example.com/b.png' } },
    ])
    // key 或渠道未填：静默不发
    await fireWeiboPublished(fakeEnv([{ key: 'bufferAccessToken', value: 'bf-tok' }]), { id: 1, content: 'x', images: [], via: 'admin' })
    // 插件被停用：不发
    await fireWeiboPublished(
      fakeEnv([
        { key: 'bufferAccessToken', value: 'bf-tok' },
        { key: 'bufferChannelId', value: 'chan1' },
        { key: 'serverPluginsDisabled', value: 'buffer-sync' },
      ]),
      { id: 1, content: 'x', images: [], via: 'admin' }
    )
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})

test('微博同步 Buffer：MutationError 不抛出（fire 正常 resolve），无图不带 assets', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { createPost: { message: 'LinkedIn posts cannot exceed 3000 characters.' } } }), {
      status: 200,
    })) as typeof fetch
  try {
    const env = fakeEnv([
      { key: 'bufferAccessToken', value: 'bf-tok' },
      { key: 'bufferChannelId', value: 'chan1' },
    ])
    await fireWeiboPublished(env, { id: 2, content: '纯文字', images: [], via: 'draft' })
  } finally {
    globalThis.fetch = orig
  }
})

test('bufferPostText：话题 #xx# 转 #xx，超 270 码点截断（emoji 不破代理对）', () => {
  assert.equal(bufferPostText('今天天气不错 #随拍#'), '今天天气不错 #随拍')
  // 与站内 extractWeiboTopics 同上限：≤24 字的话题转换，>24 字的 #xx# 原样保留
  assert.equal(bufferPostText(`#${'长'.repeat(24)}#正文`), `#${'长'.repeat(24)}正文`)
  assert.equal(bufferPostText(`#${'长'.repeat(25)}#`), `#${'长'.repeat(25)}#`)
  const long = '好'.repeat(300)
  const cut = bufferPostText(long)
  assert.equal([...cut].length, 270)
  // 270 码点边界不截断；emoji 逐码点数（😀 记 1 个码点）
  assert.equal(bufferPostText('好'.repeat(270)), '好'.repeat(270))
  assert.equal([...bufferPostText('😀'.repeat(280))].length, 270)
})

test('评论 webhook：合法地址才 POST JSON（含事件名与留言内容）', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([{ key: 'commentWebhookUrl', value: 'https://hook.example.com/feed' }])
    await fireCommentCreated(env, {
      kind: 'post', nickname: '小吴', content: '写得真好', context: '某文章', url: 'https://blog.example.com/post/a#comments', pending: false,
    })
    assert.equal(cap.calls.length, 1)
    assert.equal(cap.calls[0].url, 'https://hook.example.com/feed')
    const body = JSON.parse(String(cap.calls[0].init?.body))
    assert.equal(body.event, 'comment.created')
    assert.equal(body.nickname, '小吴')
    assert.equal(body.content, '写得真好')
    // 地址不合法 / 插件停用：不发
    await fireCommentCreated(fakeEnv([{ key: 'commentWebhookUrl', value: 'javascript:alert(1)' }]), {
      kind: 'guestbook', nickname: 'a', content: 'b', url: '', pending: true,
    })
    await fireCommentCreated(
      fakeEnv([
        { key: 'commentWebhookUrl', value: 'https://hook.example.com/feed' },
        { key: 'serverPluginsDisabled', value: 'comment-webhook' },
      ]),
      { kind: 'guestbook', nickname: 'a', content: 'b', url: '', pending: true }
    )
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})

test('插件失败被吞掉：fetch 抛错时 fire 正常 resolve，不影响主流程', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  try {
    const env = fakeEnv([
      { key: 'commentWebhookUrl', value: 'https://hook.example.com/feed' },
      { key: 'telegramBotToken', value: 'tok' },
      { key: 'tgChannelChatId', value: '@ch' },
    ])
    await fireCommentCreated(env, { kind: 'weibo', nickname: 'a', content: 'b', url: '', pending: false })
    await firePostPublished(env, { slug: 'a', title: 'b', summary: '', via: 'admin' })
  } finally {
    globalThis.fetch = orig
  }
})

test('注册表元数据：id/标题/版本齐全，不带处理函数，id 全部合法（可进停用名单）', () => {
  const list = listServerPlugins()
  assert.ok(list.length >= 3)
  for (const p of list) {
    assert.ok(p.id && p.title && p.version && p.author)
    assert.match(p.id, /^[A-Za-z0-9_-]+$/)
    assert.equal('onPostPublished' in p, false)
    assert.equal('onCommentCreated' in p, false)
    assert.equal('footerHtml' in p, false)
  }
})
