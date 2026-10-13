import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { friendLinkCards, weiboCards, weiboHomeEntry, weiboVideoHtml, type WeiboItemView } from '../src/render.ts'
import { DEFAULT_SETTINGS, parseWeiboVideo, weiboImageList, weiboVideoView } from '../src/db.ts'
import { MAX_UPLOAD_BYTES } from '../src/store.ts'
import { esc } from '../src/utils.ts'

// ── 前台微博卡管理（编辑/置顶/删除）：按钮只在管理员登录时渲染（weiboCards 的 adminName 参数）──
const item: WeiboItemView = {
  id: 42,
  content: '随手记一条',
  images: [],
  created_at: 1759651200000,
  likes: 3,
  commentCount: 1,
}
const base = { settings: DEFAULT_SETTINGS, items: [item], avatarHtml: '<i class="ava"></i>' }

test('访客（不传 adminName）不渲染任何管理按钮', () => {
  const html = weiboCards(base)
  assert.ok(!html.includes('wb-admin'))
  assert.ok(!html.includes('data-wb-act'))
  assert.ok(!html.includes('>编辑<'))
  assert.ok(!html.includes('>删除<'))
})

test('管理员（传 adminName）渲染管理操作：data-wb-admin 带微博 id，编辑/置顶/删除三键', () => {
  const html = weiboCards({ ...base, adminName: '站长' })
  assert.match(html, /data-wb-admin="42"/)
  assert.match(html, /data-wb-act="edit"[\s\S]*?>编辑</)
  assert.match(html, /data-wb-act="pin"[\s\S]*?>置顶</)
  assert.match(html, /data-wb-act="del"[\s\S]*?>删除</)
  // 管理操作仍保留点赞与评论（同一底栏）
  assert.match(html, /like-btn/)
  assert.match(html, /wb-cmt-toggle/)
})

test('已置顶卡片：is-pinned 类 + 「置顶」标签 + 按钮文案为「取消置顶」', () => {
  const html = weiboCards({ ...base, items: [{ ...item, pinned: true }], adminName: '站长' })
  assert.match(html, /wb-card is-pinned/)
  assert.match(html, /<span class="wb-pin">置顶<\/span>/)
  assert.match(html, /data-wb-act="pin"[\s\S]*?>取消置顶</)
})

test('管理按钮的删除键带 is-danger 标记（主题 CSS 据此上危险色）', () => {
  const html = weiboCards({ ...base, adminName: '站长' })
  assert.match(html, /wb-admin-btn is-danger/)
})

test('卡片正文与 id 均经转义：正文 HTML 不逃逸、不破坏 data-wb-admin 属性', () => {
  const html = weiboCards({
    ...base,
    items: [{ ...item, id: 7, content: '<script>alert(1)</script> #" onclick="#' }],
    adminName: '站长',
  })
  assert.ok(!html.includes('<script>'))
  assert.match(html, /data-wb-admin="7"/)
})

// ── 回归（2026-10 安全复查）：读侧 scheme 白名单（备份恢复/手工改库进来的脏 URL 不流进 img/a）──
test('weiboImageList 读侧过滤：只留站内 /images/ 与 http(s) 外链', () => {
  assert.deepEqual(
    weiboImageList({ images: JSON.stringify(['/images/u/a.jpg', 'javascript:alert(1)', 'https://x.com/b.png', 'data:text/html,x', 42]) }),
    ['/images/u/a.jpg', 'https://x.com/b.png']
  )
  assert.deepEqual(weiboImageList({ images: '不是 JSON' }), [])
})

test('friendLinkCards url/icon 过 scheme 白名单，非法时退化为无链接卡片', () => {
  const good = friendLinkCards([{ name: '好站', url: 'https://a.com', description: '', icon: '' }])
  assert.ok(good.includes('href="https://a.com"'))
  const bad = friendLinkCards([{ name: '坏链', url: 'javascript:alert(1)', description: '', icon: 'javascript:alert(2)' }])
  assert.ok(!bad.includes('javascript:'), 'javascript: 不得出现在输出里')
  assert.ok(bad.includes('fl-card'), '内容照常展示')
  assert.ok(bad.includes('fl-ico-letter'), '图标非法时退回字母图标')
})

/* ── 微博视频（B19）：写侧解析 / 读侧过滤 / 渲染 / site.js 镜像守卫 ──
 * 契约：一条微博最多 1 个视频，存 weibo.video 单列 JSON（src/db.ts parseWeiboVideo / weiboVideoView）；
 * 渲染在 render.ts weiboVideoHtml（单行输出），site.js wbVideoHtmlJs 是它的手工 ES5 镜像。 */

test('parseWeiboVideo：站内 /images/ 与 http(s) 放行，非法一律 null，宽高纠偏', () => {
  assert.deepEqual(parseWeiboVideo({ url: '/images/u/202610/a.mp4', poster: '/images/u/202610/a.jpg', w: 1280, h: 720 }), {
    url: '/images/u/202610/a.mp4',
    poster: '/images/u/202610/a.jpg',
    w: 1280,
    h: 720,
  })
  assert.deepEqual(parseWeiboVideo({ url: 'https://cdn.example.com/v.webm' }), {
    url: 'https://cdn.example.com/v.webm',
    poster: '',
    w: 0,
    h: 0,
  })
  // 多余键丢弃；宽高越界 / 非数字一律归 0
  assert.deepEqual(parseWeiboVideo({ url: '/images/u/a.mp4', extra: 'x', w: 'abc', h: -3 }), {
    url: '/images/u/a.mp4',
    poster: '',
    w: 0,
    h: 0,
  })
  assert.deepEqual(parseWeiboVideo({ url: '/images/u/a.mp4', w: 99999, h: 1.9 }), { url: '/images/u/a.mp4', poster: '', w: 10000, h: 1 })
  // poster 非法当没填，不影响视频本身
  assert.deepEqual(parseWeiboVideo({ url: '/images/u/a.mp4', poster: 'javascript:alert(1)' }), {
    url: '/images/u/a.mp4',
    poster: '',
    w: 0,
    h: 0,
  })
  for (const bad of [{ url: 'javascript:alert(1)' }, { url: 'data:video/mp4;base64,AA' }, { url: '  ' }, {}, null, 'x', 42, []])
    assert.equal(parseWeiboVideo(bad), null)
})

test('weiboVideoView 读侧：空串 / 脏 JSON / 非法 scheme 一律 null（不流进 <video src>）', () => {
  assert.equal(weiboVideoView({ video: '' }), null)
  assert.equal(weiboVideoView({ video: '不是 JSON' }), null)
  assert.equal(weiboVideoView({ video: JSON.stringify({ url: 'javascript:alert(1)' }) }), null)
  assert.deepEqual(weiboVideoView({ video: JSON.stringify({ url: '/images/u/a.mp4', poster: '/images/u/a.jpg', w: 720, h: 1280 }) }), {
    url: '/images/u/a.mp4',
    poster: '/images/u/a.jpg',
    w: 720,
    h: 1280,
  })
})

test('weiboVideoHtml：控件 / 占位比例 / 封面帧到位，属性过转义，单行输出', () => {
  const html = weiboVideoHtml({ url: '/images/u/a.mp4', poster: '/images/u/a.jpg', w: 1280, h: 720 })
  assert.match(html, /<video controls playsinline preload="metadata" poster="\/images\/u\/a\.jpg" style="aspect-ratio:1280\/720">/)
  assert.match(html, /<source src="\/images\/u\/a\.mp4" type="video\/mp4">/)
  assert.ok(!html.includes('wb-video-badge'), '有封面帧就不出 ▶ 角标')
  assert.ok(!html.includes('\n'), '必须单行——site.js 镜像靠逐字节比对')
  const portrait = weiboVideoHtml({ url: '/images/u/v.webm', poster: '', w: 720, h: 1280 })
  assert.match(portrait, /wb-video is-portrait is-plain/)
  assert.match(portrait, /type="video\/webm"/)
  assert.match(portrait, /wb-video-badge/)
  assert.ok(!weiboVideoHtml({ url: '/images/u/a.mp4', poster: '', w: 0, h: 0 }).includes('aspect-ratio'), '未知宽高不写占位比例')
  assert.ok(weiboVideoHtml({ url: '/images/u/a".mp4', poster: '', w: 0, h: 0 }).includes('src="/images/u/a&quot;.mp4"'), '属性上下文必须转义')
})

test('微博卡片：媒体区顺序为 正文 → 视频 → 配图', () => {
  const html = weiboCards({
    ...base,
    items: [{ ...item, images: ['/images/u/b.jpg'], video: { url: '/images/u/a.mp4', poster: '/images/u/a.jpg', w: 1280, h: 720 } }],
  })
  const iText = html.indexOf('wb-text')
  const iVideo = html.indexOf('wb-video')
  const iImgs = html.indexOf('wb-imgs')
  assert.ok(iText >= 0 && iVideo > iText && iImgs > iVideo, '顺序应为 正文 → 视频 → 配图')
})

test('首页微博入口卡：视频卡无正文时兜底文案为「发了一段视频」，封面帧充当初图', () => {
  const html = weiboHomeEntry({
    items: [{ ...item, content: '', images: [], video: { url: '/images/u/a.mp4', poster: '/images/u/a.jpg', w: 1280, h: 720 } }],
    total: 1,
  })
  assert.match(html, /发了一段视频/)
  assert.match(html, /wb-home-thumb"><img src="\/images\/u\/a\.jpg"/)
})

// 镜像守卫（与 tests/outlink.test.ts 同款切片手法）：site.js 无构建链，把镜像段包成工厂在 Node 里跑，
// 跟服务端同输入逐字节比对——历史上捕获组错位就是这东西没盯住才漏到线上的
test('site.js wbVideoHtmlJs 镜像：与服务端 weiboVideoHtml 逐字节一致', () => {
  const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('// 视频块与后端 render.ts weiboVideoHtml 同口径'), src.indexOf('// 失败反馈'))
  assert.ok(seg.includes('function wbVideoHtmlJs'), 'site.js 切片失败：镜像段不在预期位置')
  const factory = new Function('esc', 'T', seg + '\n;return { wbVideoHtmlJs: wbVideoHtmlJs }')
  const client = factory(esc, (zh: string) => zh) as { wbVideoHtmlJs: (v: unknown) => string }
  const samples = [
    { url: '/images/u/a.mp4', poster: '/images/u/a.jpg', w: 1280, h: 720 },
    { url: '/images/u/v.webm', poster: '', w: 720, h: 1280 },
    { url: 'https://cdn.example.com/x.mp4', poster: 'https://cdn.example.com/x.jpg', w: 0, h: 0 },
    { url: '/images/u/a.mp4', poster: '', w: 0, h: 0 },
  ]
  for (const s of samples) assert.equal(client.wbVideoHtmlJs(s), weiboVideoHtml(s, false), '双端输出必须一致：' + s.url)
})

test('25MB 口径两处同源：site.js / 后台 app.js 的 VIDEO_MAX_BYTES 等于 store.ts MAX_UPLOAD_BYTES', () => {
  for (const file of ['../public/site.js', '../public/admin/app.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    const m = src.match(/VIDEO_MAX_BYTES = (\d+) \* 1024 \* 1024/)
    assert.ok(m, file + ' 未声明 VIDEO_MAX_BYTES')
    assert.equal(Number(m[1]) * 1024 * 1024, MAX_UPLOAD_BYTES, file + ' 的体积上限与服务端漂移了')
  }
})
