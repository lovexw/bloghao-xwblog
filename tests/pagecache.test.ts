import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { getSettings, saveSettings } from '../src/db.ts'
import { PAGE_CACHE_EPOCH_KEY } from '../src/db.ts'
import { pageCacheKeyFor, purgePageCache } from '../src/pagecache.ts'

// ── 页面边缘缓存（src/pagecache.ts）：键判定纯函数 + saveSettings 自动换代 ──
// 防线核心：登录 Cookie（管理员/会员/文章解锁）与带 query 的请求绝不进缓存键——
// 键判错就是「把 A 的页面发给 B」级别的越权事故；epoch 进键是失效机制的根。

const SESSION = 'bloghao_session'
const MEMBER = 'xw_member_session'
const PP = 'bloghao_pp'

function keyOf(over: Partial<Parameters<typeof pageCacheKeyFor>[0]> = {}) {
  return pageCacheKeyFor({
    method: 'GET',
    url: 'https://x.test/',
    cookie: '',
    demo: false,
    grayscale: false,
    epoch: '100',
    ...over,
  })
}

test('pageCacheKeyFor：可缓存页面返回带 epoch 的键', () => {
  for (const p of ['/', '/post/hello', '/tag/abc', '/category/x', '/page/y', '/about', '/archives', '/guestbook', '/weibo', '/links', '/member', '/rank']) {
    const k = keyOf({ url: `https://x.test${p}` })
    assert.ok(k, `公开页 ${p} 必须可缓存`)
    assert.ok(k!.includes('/100/'), '键必须带 epoch 段')
  }
  assert.equal(keyOf({ url: 'https://x.test/post/hello?_r=123' }), null, '带 query 不缓存（评论刷新旁路依赖这条）')
  assert.equal(keyOf({ url: 'https://x.test/search?q=x' }), null, '搜索页千人千面不缓存')
  assert.equal(keyOf({ url: 'https://x.test/go?u=x' }), null)
  assert.equal(keyOf({ url: 'https://x.test/images/u/a.png' }), null, '图床路由有自己的 immutable 缓存')
  assert.equal(keyOf({ url: 'https://x.test/rss.xml' }), null)
  assert.equal(keyOf({ url: 'https://x.test/api/public/posts' }), null)
  assert.equal(keyOf({ url: 'https://x.test/admin/' }), null)
  assert.equal(keyOf({ url: 'https://x.test/random' }), null, '/random 每次随机不缓存')
  assert.equal(keyOf({ url: 'https://x.test/post/../etc' }), null, '路径穿越形态不匹配白名单')
})

test('pageCacheKeyFor：任一登录/解锁 Cookie 在场绝不缓存（越权面）', () => {
  assert.equal(keyOf({ cookie: `${SESSION}=abc` }), null, '管理员会话在，页面里有管理按钮')
  assert.equal(keyOf({ cookie: `foo=1; ${SESSION}=abc` }), null, '多 Cookie 混合同样拦')
  assert.equal(keyOf({ cookie: `${MEMBER}=xyz` }), null, '会员会话在，页面里有会员表单')
  assert.equal(keyOf({ cookie: `${PP}=tok` }), null, '文章解锁令牌在，正文可能已解锁')
})

test('pageCacheKeyFor：演示站 / 灰度 / 非 GET 一律不缓存', () => {
  assert.equal(keyOf({ demo: true }), null)
  assert.equal(keyOf({ grayscale: true }), null, '灰度是整站去色特殊状态')
  assert.equal(keyOf({ method: 'HEAD' }), null)
  assert.equal(keyOf({ method: 'POST' }), null)
})

test('pageCacheKeyFor：epoch 变化 = 键变化（失效机制的根）', () => {
  const a = keyOf({ epoch: '100' })
  const b = keyOf({ epoch: '200' })
  assert.notEqual(a, b)
  assert.ok(a && b)
})

// ── node:sqlite 实库：saveSettings 自动换代 + purgePageCache ──

function d1FromSqlite(db: DatabaseSync): D1Database {
  const cache = new Map<string, StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = db.prepare(sql)))
    return st
  }
  const handlers = (sql: string, binds: unknown[]) => ({
    run: async () => {
      stmtOf(sql).run(...(binds as never[]))
      return { success: true }
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

function sqliteWithSettings(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
  return db
}

test('saveSettings：每次保存自动推进 pageCacheEpoch（改设置 = 页面缓存整代作废）', async () => {
  const db = sqliteWithSettings()
  const d1 = d1FromSqlite(db)

  await saveSettings(d1, { siteTitle: 'A' })
  const e1 = (await getSettings(d1))[PAGE_CACHE_EPOCH_KEY]
  assert.ok(e1 && e1 !== '', '首次保存要落一个非空 epoch')

  await saveSettings(d1, { footerText: 'B' })
  const e2 = (await getSettings(d1))[PAGE_CACHE_EPOCH_KEY]
  assert.ok(Number(e2) > Number(e1), '第二次保存必须推进 epoch（单调时间戳）')

  await saveSettings(d1, { [PAGE_CACHE_EPOCH_KEY]: '12345', siteTitle: 'C' })
  const e3 = (await getSettings(d1))[PAGE_CACHE_EPOCH_KEY]
  assert.equal(e3, '12345', '显式带 epoch 的保存（purgePageCache）不覆盖调用方的值')
})

test('purgePageCache：显式换 epoch，其他设置原样保留', async () => {
  const db = sqliteWithSettings()
  const d1 = d1FromSqlite(db)
  await saveSettings(d1, { siteTitle: '我的站' })
  const before = await getSettings(d1)

  await purgePageCache(d1)
  const after = await getSettings(d1)
  assert.equal(after.siteTitle, '我的站', '清理只换代不动内容')
  assert.ok(Number(after[PAGE_CACHE_EPOCH_KEY]) > Number(before[PAGE_CACHE_EPOCH_KEY]), 'epoch 必须推进')
})
