#!/usr/bin/env node
/**
 * 3.0 内测本地数据播种：npm run seed:3.0 之前先 `node scripts/seed-local-3.0.mjs`
 *
 * 定位：给「本地开发版」灌一个像真正博客的内容库，供站长内测 3.0（铁粉 / 多作者 / 快讯主题）。
 * 只碰本地 .wrangler/state（wrangler d1 execute --local + r2 object put --local），不涉生产。
 *
 * 流程：生成本地种子图片（零依赖手写 PNG，同 public/admin 图标先例）→ 计算 PBKDF2 口令哈希
 * （与 src/auth.ts 同参数：SHA-256 / 10 万轮 / 256 位）→ 生成 seed.sql → wrangler d1 execute 导入
 * → wrangler r2 object put 上传图片 → 打印测试账号。
 *
 * 约束（改内容前先读）：
 * - wrangler d1 execute --file 按分号朴素切 SQL：**所有内容字符串里严禁出现 ASCII 分号**（用中文「；」），
 *   脚本末尾有断言守着，别拆
 * - 覆盖式播种：先清空业务表再插入（本地开发库专用，别对生产库跑）
 * - FTS 索引不在这里建：种子库冷启动时 ensureSchema 按 ftsSeeded 记账位自动 rebuild（备份恢复同路径）
 * - 签到「今天」全部留白：last_checkin_day 最多到昨天，会员今天都能点一次签到亲测连续加成
 * - 时间统一北京时间口径（+8h 取 UTC 分量），与 src/utils.ts cstDate 同式
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.seed30-tmp')
const WRANGLER_JS = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const DB_NAME = 'DB' // 与 npm run db:init:local 同名（wrangler 按 binding 解析到 xwblog-db）
const BUCKET = 'xwblog-images'
const MONTH = 'u/202510' // 图床键前缀：/images 路由只认 u/ 或 og/ 开头的键（真实 saveUpload 键形如 u/YYYYMM/<ts>-<rand>.<ext>）

/* ---------------- 基础工具 ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(20261019)
const pick = (arr) => arr[Math.floor(rng() * arr.length)]

/** 北京墙上日期（YYYY-MM-DD），与 src/utils.ts cstDate 同式 */
function bjDate(ts) {
  const d = new Date(ts + 8 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
const DAY = 86_400_000
const now = Date.now()
const daysAgo = (n, hour = 9 + Math.floor(rng() * 12), minute = Math.floor(rng() * 60)) => {
  const base = now - n * DAY
  const d = new Date(base + 8 * 3600_000)
  d.setUTCHours(hour - 8, minute, Math.floor(rng() * 60), 0)
  return d.getTime()
}

function escSql(s) {
  return String(s).replace(/'/g, "''")
}
/** 内容字符串防线：wrangler 按分号切 SQL，ASCII 分号混进字符串会劈碎语句——断言挡在生成期 */
function assertNoSemicolon(s, where) {
  if (/;/.test(String(s))) throw new Error(`内容含 ASCII 分号（会劈碎 wrangler 的 SQL 切分）：${where}`)
  return s
}

async function pbkdf2Hex(password, salt) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100_000 },
    key,
    256
  )
  return Array.from(new Uint8Array(bits), (x) => x.toString(16).padStart(2, '0')).join('')
}
const hexSalt = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('')

/* ---------------- 零依赖 PNG 生成（渐变 + 几何构图，像素级手写） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function makePng(width, height, pixelFn) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 8 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const lerp = (a, b, t) => a + (b - a) * t
function blend(base, top, alpha) {
  return [lerp(base[0], top[0], alpha), lerp(base[1], top[1], alpha), lerp(base[2], top[2], alpha)]
}

/** 封面画手：双色纵向渐变 + 两团柔光圆 + 斜向细条 + 细噪点，抽象但不糊弄 */
function coverPainter(palette, seed) {
  const r = mulberry32(seed)
  const [c1, c2] = palette.map(hex2rgb)
  const blobs = Array.from({ length: 3 }, () => ({
    x: r() * 960,
    y: r() * 520,
    rad: 140 + r() * 240,
    col: hex2rgb(pick(palette)),
    a: 0.16 + r() * 0.2,
  }))
  const stripes = Array.from({ length: 7 }, () => ({ off: r() * 1200, w: 2 + Math.floor(r() * 5), a: 0.05 + r() * 0.08 }))
  return (x, y) => {
    let px = blend(c1, c2, y / 520)
    for (const b of blobs) {
      const d = Math.hypot(x - b.x, y - b.y) / b.rad
      if (d < 1) px = blend(px, b.col, b.a * (1 - d * d))
    }
    for (const s of stripes) {
      if (Math.abs(x - y * 1.4 - s.off) % 173 < s.w) px = blend(px, [255, 255, 255], s.a)
    }
    const n = ((x * 7 + y * 13) % 11) / 11
    return blend(px, [255, 255, 255], n * 0.025)
  }
}
/** 内文插图画手：横向色带 + 大圆弧 */
function figurePainter(palette, seed) {
  const r = mulberry32(seed)
  const [c1, c2] = palette.map(hex2rgb)
  const bandY = Array.from({ length: 5 }, () => ({ y: r() * 500, h: 18 + r() * 70, a: 0.1 + r() * 0.15 }))
  const cx = 200 + r() * 400
  const cy = 150 + r() * 200
  const rad = 90 + r() * 130
  return (x, y) => {
    let px = blend(c1, c2, x / 800)
    for (const b of bandY) if (y > b.y && y < b.y + b.h) px = blend(px, [255, 255, 255], b.a)
    const d = Math.hypot(x - cx, y - cy) / rad
    if (d < 1) px = blend(px, [255, 255, 255], 0.22 * (1 - d))
    return px
  }
}
/** 头像画手：暖底 + 同心环 */
function avatarPainter() {
  const base = hex2rgb('#e8734a')
  const bg = hex2rgb('#f6ede4')
  return (x, y) => {
    const d = Math.hypot(x - 160, y - 160)
    if (d > 158) return bg
    const ring = Math.sin(d / 13) * 0.5 + 0.5
    return blend(base, [255, 226, 196], ring * 0.55)
  }
}

const COVER_PALETTES = [
  ['#2b5876', '#4e4376'],
  ['#134e5e', '#71b280'],
  ['#c0392b', '#e67e22'],
  ['#0f2027', '#2c5364'],
  ['#42275a', '#734b6d'],
  ['#1d976c', '#93f9b9'],
  ['#eb3349', '#f45c43'],
  ['#16222a', '#3a6073'],
  ['#f7971e', '#ffd200'],
  ['#4568dc', '#b06ab3'],
  ['#11998e', '#38ef7d'],
  ['#8e2de2', '#4a00e0'],
]
const FIGURE_PALETTES = [
  ['#355c7d', '#c06c84'],
  ['#2c3e50', '#4ca1af'],
  ['#6a3093', '#a044ff'],
  ['#1a2980', '#26d0ce'],
  ['#e96443', '#904e95'],
  ['#4776e6', '#8e54e9'],
]

const IMAGE_KEYS = []
function planImage(key, painter, w, h, seed) {
  IMAGE_KEYS.push({ key: `${MONTH}/${key}`, painter, w, h, seed })
}
planImage('seed-avatar.png', avatarPainter(), 320, 320, 1)
for (let i = 1; i <= 12; i++) planImage(`seed-cover-${String(i).padStart(2, '0')}.png`, coverPainter(COVER_PALETTES[i - 1], i * 77), 960, 520, i * 77)
for (let i = 1; i <= 6; i++) planImage(`seed-img-${String(i).padStart(2, '0')}.png`, figurePainter(FIGURE_PALETTES[i - 1], i * 131), 800, 500, i * 131)

/* ---------------- 测试账号（口令固定便于内测，正式使用前改掉） ---------------- */

const PW_ADMIN = 'admin123456'
const PW_AUTHOR = 'author123456'
const PW_MEMBER = 'member123456'
const PW_POST = '1234' // 密码文章「家庭服务器备忘」的访问密码

/* ---------------- 内容素材 ---------------- */

const SITE = { name: '小吴的折腾手记', desc: '一台电脑、几行代码、无数杯咖啡——记录折腾与生活的个人博客。' }

const CATEGORIES = [
  { name: '技术', slug: 'tech', desc: '写代码、调服务、追新工具——与计算机有关的一切。', sort: 1 },
  { name: '折腾', slug: 'tinkering', desc: '软路由、家庭服务器、键盘咖啡，动手综合征患者自留地。', sort: 2 },
  { name: '读书', slug: 'reading', desc: '读过的书与留下的笔记，一年一个小目标。', sort: 3 },
  { name: '生活', slug: 'life', desc: '不为折腾的日子：爬山、拍照、发呆与碎碎念。', sort: 4 },
]

const TAGS = ['Cloudflare', 'Docker', 'VPS', '效率', '键盘', '咖啡', '随笔', '年度总结', 'Windows', '网络', 'RSS', '写作', '内测', '备份', '摄影', '读书笔记', '家庭服务器', '3.0']

const FILLER = [
  '写完回头读了一遍，逻辑还算顺，就先发出来，后续有新的想法再来补。',
  '如果你也在折腾类似的东西，欢迎在评论区聊聊，踩过的坑互相通报一下。',
  '这段时间最大的感受是：工具越简单，越容易坚持用下去。',
  '动手之前我以为会很复杂，真正做完发现，难的从来不是技术，是把需求想清楚。',
  '顺手把过程记在这里，一来给自己留个底，二来万一能帮到搜索进来的朋友就更好了。',
  '配置思路贴在下面，照着捋一遍就能跑起来，比我当时的笔记干净多了。',
  '预算有限的情况下，先把最影响体验的部分解决掉，剩下的慢慢升级。',
  '这东西没有标准答案，用着舒服就是对的。',
  '第二天醒来又改了两处细节，这种小修小补的快乐，大概就是自己搭站的意义。',
  '记录的意义在于，一个月后回头看，能清楚知道自己当时卡在哪里。',
  '选择困难的时候，就选那个「坏了也不会太心疼」的方案。',
  '写代码如此，写文章也如此，删掉的部分往往比留下的更重要。',
  '本来只想改一个小地方，结果顺着往下捋了一遍，收获比预期大。',
  '最后例行提醒一句：改完记得备份，别问我怎么知道的。',
]

/** 文章清单：t 标题 / s slug / c 分类 / tags / sum 摘要 / d 发文天数（前）/ body 正文段
 *  可选：pin 置顶、ai AI 标注、author 1=站长 2=云舟、cover 封面序号、imgs 内文图序号数组、
 *  tier 会员可见档位、pwd 上访问密码、status draft/scheduled、trash 回收站、future 定时偏移 */
const POSTS = [
  {
    t: '我把博客搬到了 Cloudflare Workers 上：三个月的账单与体验',
    s: 'move-blog-to-cloudflare-workers',
    c: 'tech', tags: ['Cloudflare', '随笔'], cover: 1, d: 148,
    sum: '从 VPS 到 Workers，迁移比想象中顺利，账单比想象中难看——每月不到一杯奶茶钱，附完整的迁移清单与坑位记录。',
    body: [
      '去年这个时候，博客还躺在一台 5 美元的小鸡上，每个月最紧张的就是流量会不会超、硬盘会不会满。三月一个周末，我花了半天把它搬到了 Cloudflare Workers 上，D1 存数据、R2 放图片，全部塞进免费额度里。',
      '<h2>迁移清单</h2><ul><li>导出文章与评论，逐条核对 HTML 转义</li><li>图片批量转存进 R2，键名按月份分目录</li><li>DNS 切换选在工作日凌晨，回滚预案写在便利贴上</li></ul>',
      '最难的不是搬家，是下决心关掉旧服务器。迁完之后我留着它跑了两周，确认搜索引擎收录没掉、RSS 订阅数没掉，才按下删除键。',
      '三个月用下来，账单稳定在个位数：D1 的读次数比想象中省，R2 的出网费是零。唯一的意外是某个爬虫凌晨把我的额度刷掉一角，加了个限流就老实了。',
    ],
  },
  {
    t: '3.0 内测手记：铁粉签到体系是怎么长出来的',
    s: 'bloghao-30-beta-fanrank',
    c: 'tech', tags: ['内测', '写作', '3.0'], cover: 2, d: 6, author: 2, imgs: [1],
    sum: '积分是货币，成长是身份。3.0 把「常来」变成看得见的等级：读者、常客、铁粉、至交，附签到连击与活跃天数的设计取舍。',
    body: [
      '<p>设计等级表的时候，我和自己吵了三天。第一版全部是「且」门槛：积分要够、活跃也要够，结果新注册的读者看着五级大关，连签到都懒得点。后来把第一级改成「或」门槛——积分或活跃任一达标就是「读者」，先给新人一颗糖。</p>',
      '<p>第二处反复是「等级会不会降」。积分能被消费（以后抽奖要扣分），如果等级跟着余额掉，会不会伤感情？最后拍板的口径是：成长是「当前状态」不是「终身成就」，降级本身就是纪律的一部分。</p>',
      '<blockquote>积分是货币，成长是身份——前者衡量你花了多少，后者衡量你来了多久。</blockquote>',
      '<p>签到连击的加成放在第 7 天，而不是每天都递增，是因为递增式奖励会让人为了「不断签」而焦虑，第 7 天一次性奖励更像一个小小的里程碑。断签清零重来，第二天照常 +2，没什么大不了。</p>',
    ],
  },
  {
    t: 'Docker 自托管博客：从 compose.yml 到备份脚本',
    s: 'docker-self-host-blog',
    c: 'tech', tags: ['Docker', 'VPS', '备份'], cover: 3, d: 132,
    sum: '给朋友的博客做自托管方案，一次写清 compose、反向代理、自动备份三件事，让他以后不用半夜找我救火。',
    body: [
      '朋友看了我的博客，说也想整一个，但他不想碰命令行。于是有了这套方案：一个 compose.yml 起服务，一个 Caddy 反代证书，一个 cron 脚本每天把数据库和图片打包扔到对象存储。',
      '<h2>备份是底线</h2><p>备份脚本的原则是「恢复比备份重要」：每周我会真的拿备份文件在新容器里跑一次恢复演练，跑不通的备份等于没有备份。</p>',
      '整套东西跑在一个最小规格的 VPS 上，内存占用不到 300MB。朋友现在唯一要做的操作是：每月看一眼备份通知有没有来。',
    ],
  },
  {
    t: '2025 年终：写了 43 篇文章之后',
    s: '2025-year-in-review',
    c: '生活', tags: ['年度总结', '写作'], cover: 4, pin: 1, d: 320,
    sum: '一年 43 篇，平均每周不到一篇，但每一篇都写完了。盘点数字之外更重要的变化：写作怎么反过来改变生活。',
    body: [
      '年初给自己定的目标是 52 篇，一周一篇。到 12 月 31 号盘点，43 篇，完成率 83%。要是按学生时代的标准这算不及格，但按「成年人的爱好」标准，这大概是我坚持得最久的一年。',
      '<h2>几个没预想到的变化</h2><ul><li>为了有东西可写，我开始主动给一周找一件事：装个软路由、读一本书、走条新路</li><li>表达变克制了，花哨的形容词越来越少，具体的事越来越多</li><li>评论区出现了几个固定ID，从读者变成了网友，再到现实里的朋友</li></ul>',
      '数据层面，全年 11 万字，阅读最多的一篇是迁移记录（搜索来的流量），评论最多的一篇是键盘评测（聊天来的流量）。数据再次证明：技术文引流，生活文留人。',
      '明年不设篇数目标了，改成「每月至少一篇长文」。数量是手段，不是目的——这个道理，写了 43 篇才真的信。',
    ],
  },
  {
    t: 'HHKB 静电容键盘三年使用报告',
    s: 'hhkb-3-year-review',
    c: '折腾', tags: ['键盘', '效率'], cover: 5, d: 286, imgs: [2],
    sum: '当年咬牙买下的「理财键盘」，三年后的真实使用感受：值不值、洗键记、以及它到底适合谁。',
    body: [
      '三年前下单 HHKB 的那个晚上，我在购物车前坐了半小时。三年后的现在，它是我桌上唯一没被收进抽屉的外设——这大概就是答案。',
      '<h2>洗键记</h2><p>静电容键盘可以整键拆下来水洗。第一次洗键我拍了全过程：键帽泡在温水里，像洗一锅棋子。装回去之后那种「新键盘」的手感，值回半小时的操作。</p>',
      '要说缺点：方向键要靠组合键，写代码时偶尔别扭；无刻印对面板容易打油。但键感这东西，一旦习惯了就回不去了——现在我碰公司配的薄膜键盘，像在敲平板。',
      '适合谁：每天打字超过两小时、且不打算频繁换键盘的人。只是偶尔写写字的朋友，入门级机械键盘的快乐已经足够。',
    ],
  },
  {
    t: 'RSS 没死：我的信息流重组实验',
    s: 'rss-rebuilding-my-feed',
    c: 'tech', tags: ['RSS', '效率'], d: 261,
    sum: '关掉所有算法推荐 App 一个月，把信息来源收进 RSS 阅读器：订阅了什么、砍掉了什么、注意力回来了多少。',
    body: [
      '实验的起因很简单：某天我打开手机，划了四十分钟短视频，抬头时完全不记得看了什么。当天我关掉了所有推荐制 App，把信息来源全部收进 RSS 阅读器。',
      '<h2>订阅原则</h2><p>只订两种源：一种是「我读完每篇都不亏」的作者博客，一种是「一周更新一条也值得」的项目发布日志。前者现在有 37 个，后者 11 个。每天早高峰 20 分钟读完，一天不再打开第二次。</p>',
      '一个月下来，注意力回来的体感很明显：能连续读 40 分钟长文了。副产品是，我自己也开始把博客的全文 RSS 打开——既然我讨厌只给摘要的站，自己就不能做那种站。',
    ],
  },
  {
    t: '一次 D1 读放大优化实录：从 50 万行到 500 行',
    s: 'd1-read-amplification-optimization',
    c: 'tech', tags: ['Cloudflare', '效率'], d: 235,
    sum: '一个排序小图标差点烧掉十分之一日额度：排查表达式索引失配的全过程，附 EXPLAIN 读法与三条表达式索引的最终形态。',
    body: [
      '事情是从一张账单截图开始的：某天 D1 的「读取行数」异常地高，按天聚合一路追到首页的一个排序入口——用户每点一次「按评论排序」，数据库就要把全部已审评论扫一遍来计数。',
      '<h2>问题出在哪</h2><p>ORDER BY 里的 COALESCE 表达式和普通列索引对不上，规划器只能全表扫描加临时排序。更隐蔽的是评论计数聚合被误选了 status 前导的索引，等于每次都把全站评论读一遍。</p>',
      '<pre><code>EXPLAIN QUERY PLAN\nSELECT post_id, count(*)\nFROM comments\nWHERE post_id IN (...) AND status = \'approved\'\nGROUP BY post_id</code></pre>',
      '修复思路是「强制走对的索引」：给四处高频查询都加上 INDEXED BY，再按排序口径建了表达式部分索引。上线后同一路径从 50 万行降到 500 行。教训记一句：SQLite 的规划器不能信，要用 EXPLAIN 逼问。',
    ],
  },
  {
    t: '手冲咖啡入门：器具不必买贵',
    s: 'pourover-coffee-starter',
    c: '折腾', tags: ['咖啡'], cover: 6, d: 208, imgs: [3],
    sum: '入坑两年、炸过三次滤杯之后的心得：入门三件套怎么选不踩坑，以及哪些钱可以省、哪些不能省。',
    body: [
      '常有人问我手冲入门要花多少钱。我的答案是：三百块能玩得很好，三千块也未必更好——差别在于你对「折腾」的需求有多大。',
      '<h2>不能省的三样</h2><ul><li>磨豆机：粉的均匀度直接决定甜感，这是预算大头</li><li>滤杯：便宜的经典款就好，别买花哨的形状</li><li>秤：精确到 0.1 克，注水比才稳定</li></ul>',
      '可以省的：手冲壶（家用细口壶即可）、温度计（预算内先靠经验）、以及一切「氮气冷萃伴侣」类周边。',
      '最后说句实在的：豆子比器具重要。同一套器具，换了支好豆子，提升立竿见影；换了个贵壶，提升主要在拍照。',
    ],
  },
  {
    t: '读《置身事内》：理解身边经济现象的起点',
    s: 'reading-book-inside-governement',
    c: '读书', tags: ['读书笔记'], cover: 7, d: 187,
    sum: '一本把「土地财政」讲清楚的书。摘了六条笔记，谈谈它如何改变我看新闻的方式。',
    body: [
      '这本书火过一阵了，但我读完的感受是：它值得火。不是因为结论惊人，而是因为它把复杂问题拆成了「谁出钱、谁办事、谁受益」三个问题。',
      '<h2>摘几条笔记</h2><blockquote>地方政府不是裁判员，它本身就在场上踢球。理解这一点，很多新闻就不用再「解读」了。</blockquote>',
      '读完最大的变化是看新闻的方式：看到某个产业政策，会先想钱从哪里来、激励给到了谁。这个思维框架比任何结论都值钱。',
      '给想读的朋友一个建议：别跳过前两章，土地财政的逻辑链条是一层层搭起来的，跳着读会断。',
    ],
  },
  {
    t: 'Windows 终端美化：从默认配色到顺手的开发环境',
    s: 'windows-terminal-setup',
    c: 'tech', tags: ['Windows', '效率'], d: 171, imgs: [4],
    sum: '记录一次完整的终端环境重装：Windows Terminal 配置、字体、提示符与常用别名，全部有备份可复现。',
    body: [
      '重装系统是把双刃剑：清掉了积灰，也清掉了记忆里那套「当年怎么配好的」。这次学乖了，全部配置进 git，重装变成一条命令的事。',
      '<h2>清单</h2><ul><li>终端：Windows Terminal + Nerd Font（字体是花体图标的前提）</li><li>提示符：轻量方案，启动速度优先于好看</li><li>别名：把常用长命令全部缩短，手不会离开主键区</li></ul>',
      '唯一要坚持的原则是：每加一个工具前问自己「一周后我还会用它吗」。终端美化是无底洞，好看的进度条不会让代码更快跑完。',
    ],
  },
  {
    t: '博客评论系统的三次重构',
    s: 'comment-system-three-refactors',
    c: 'tech', tags: ['写作', 'Cloudflare'], d: 154, author: 2,
    sum: '从「能留言」到「愿意留言」，评论区改了三轮：存储结构、审核流、以及最后那个最不起眼但最有效的改动。',
    body: [
      '第一版评论系统能用，但没人用。第二版加了头像和楼中楼，开始有人用。第三版几乎没改功能，只改了一个小地方，评论量翻了一倍——把「发表评论」按钮旁边加了一行小字：回复通常在当天内。',
      '<h2>三轮分别改了什么</h2><ul><li>第一轮：存储与转义，评论是 UGC，任何字段都不能信任</li><li>第二轮：结构，楼中楼与楼号，让对话有了形状</li><li>第三轮：心理预期，把「会不会有人理我」这个最大的顾虑写在了按钮旁边</li></ul>',
      '技术上三轮都不复杂。复杂的是理解：评论系统做的不是「留言板」，是「对话的开场白」。',
    ],
  },
  {
    t: '会员体系上线一个月的数据复盘',
    s: 'membership-one-month-review',
    c: 'tech', tags: ['内测', '写作'], d: 140, tier: 'member',
    sum: '开放会员注册 30 天：注册数、留存、以及一个完全没预料到的发现。这篇只给登录会员看。',
    body: [
      '这篇写给注册会员。数据不多，但都是真实的一手反馈，比任何行业报告都值得琢磨。',
      '<h2>三个数字</h2><ul><li>注册 34 人，次日留存 21 人</li><li>评论中位数从每周 5 条涨到 19 条</li><li>最活跃的会员来自一篇生活随笔，而不是任何一篇技术文</li></ul>',
      '没预料到的发现：大家最在意的不是「专属内容」，而是「显示自己是会员」的那个小徽标。身份感比内容本身更有吸引力，这改变了 3.0 的设计优先级。',
    ],
  },
  {
    t: '为什么我又开始写周报了',
    s: 'why-i-write-weekly-review',
    c: '生活', tags: ['随笔', '效率'], d: 126, author: 2,
    sum: '不是写给老板的那种。每周五晚上 15 分钟，三行字，记录这周做成的一件事、搞砸的一件事、想明白的一件事。',
    body: [
      '周报这个词听起来就很班味，所以先澄清：这个周报没有收件人，写完存进博客草稿箱，只有我自己看。',
      '格式简单到不好意思叫模板：这周做成了一件事、搞砸了一件事、想明白了一件事。每件一两行，超时就说明没想清楚。',
      '坚持了小半年，最大的收获是「一周」变成了一个合适的复盘单位——太短看不出趋势，太长记不住细节。很多当时觉得天大的事，写下来就三行；很多顺手做的小事，攒起来才发现是一大块。',
    ],
  },
  {
    t: '家庭网络改造：软路由加全屋漫游',
    s: 'home-network-upgrade',
    c: '折腾', tags: ['家庭服务器', '网络'], cover: 8, d: 118, imgs: [5],
    sum: '从光猫bridged到双 AP 漫游，一次把家里网络捋直：拓扑图、设备清单、以及「折腾一晚上、稳定一整年」的验收标准。',
    body: [
      '改造前的痛点：主卧信号差、设备一多 DHCP 抽风、访客网络形同虚设。改造原则只有一条——所有环节都要能被一张拓扑图画清楚。',
      '<h2>最终拓扑</h2><ul><li>光猫桥接，拨号交给软路由</li><li>双 AP 有线回程，同一 SSID 全屋漫游</li><li>IoT 设备单独网段，和主力设备隔离</li></ul>',
      '验收标准定在动手之前：全屋任意位置测速不低于宽带的七成、漫游切换不断流、断电重启后十分钟内全屋自愈。三条都过了，才算折腾完。',
      '写这篇的时候已经稳定运行一年了，中间只坏过一次： пыль——不对，是积灰导致的一个 AP 过热重启。家庭网络和家务一样，功夫在平时。',
    ],
  },
  {
    t: '静态博客与动态博客：我两条路都走过',
    s: 'static-vs-dynamic-blog',
    c: 'tech', tags: ['Cloudflare', '写作'], d: 109,
    sum: '三年静态、两年动态的亲历对比：写作体验、维护成本、数据归属，以及「哪种适合你」的判断题。',
    body: [
      '先说结论：这个问题的正确问法不是「哪种更好」，而是「你更怕什么」。怕丢数据选静态，怕麻烦选托管，怕无聊选动态——怕无聊这条是我编的，但也成立。',
      '<h2>体感对比</h2><ul><li>静态：写完一个命令发布，天下太平；但评论要靠第三方，每次改版都要重新生成</li><li>动态：后台点一下就上线，评论、统计、定时发布都是自带的；代价是要管服务器或者信任托管方</li></ul>',
      '我现在用动态的，原因是「写作以外的功能想要就得自己写」这件事，对我是乐趣不是负担。但如果你只想写字，静态加托管是最省心的组合，没有之一。',
    ],
  },
  {
    t: '读书笔记方法：卡片盒的本地化实践',
    s: 'zettelkasten-local-practice',
    c: '读书', tags: ['读书笔记', '效率'], d: 98,
    sum: '把卡片盒笔记法搬进本地文件系统：一套不依赖任何云服务的笔记流程，附目录结构与反例提醒。',
    body: [
      '卡片盒的教程大多从软件讲起，我的实践反着来：先用纯文本跑三个月，再决定要不要工具。结果是不需要。',
      '<h2>目录结构</h2><ul><li>inbox：读书时随手摘的原文与页码</li><li>cards：用自己的话重写的卡片，一卡一事</li><li>maps：按主题串卡片的索引页</li></ul>',
      '三个月后最大的感受：笔记的价值在「重写」这个动作里。摘抄是搬运，重写才是消化——前者一年后是别人的句子，后者是自己的。',
      '反例提醒：别在坚持之前先花一周选软件。工具永远是第二位的，写满一百张卡片之前，任何软件都是装饰品。',
    ],
  },
  {
    t: 'Cloudflare R2 图床搭建：零出网费的秘密',
    s: 'cloudflare-r2-image-hosting',
    c: 'tech', tags: ['Cloudflare', '备份'], d: 90, cover: 9,
    sum: '图床迁移到 R2 之后，出网费真的归零了：讲清楚 S3 兼容接口、缓存策略与防盗链三件事。',
    body: [
      '以前图床每月的出网费像水电费，不多但总在。搬到 R2 之后这行数字变成了 0.00——原因就一条：R2 的出网流量不要钱。',
      '<h2>三件事</h2><ul><li>缓存：图片是不可变资源，缓存头直接给到一年</li><li>防盗链： Referer 白名单加签名 URL，防的是爬虫不是读者</li><li>命名：键名带年月与随机后缀，同内容不同名，永不覆盖</li></ul>',
      '迁完之后顺手把历史图片做了体检：一半以上是「传了但没引用」的孤儿。删掉之后存储量直接腰斩——原来最贵的存储在犹豫里。',
    ],
  },
  {
    t: '一颗机械键盘的洗键记',
    s: 'mechanical-keyboard-cleaning',
    c: '折腾', tags: ['键盘'], d: 82, imgs: [6],
    sum: '两年没洗的键盘到底有多脏：全程记录拆键、清洗、润轴的下午，附不要模仿的错误示范。',
    body: [
      '拆下第一个键帽的瞬间我就后悔了——不是难装，是后悔为什么现在才洗。两年攒下来的东西，用一句话形容：不能想。',
      '<h2>流程记录</h2><ul><li>拔键帽、拍照记位（重要，别信记忆）</li><li>键帽温水加中性洗涤剂，泡二十分钟</li><li>面板软毛刷加气吹，轴体只用干刷</li></ul>',
      '错误示范也有：我一开始想用酒精棉擦轴体，被朋友拦住了——酒精会伤轴心润滑。润轴是另一个世界的工程，这次只做了清洁，手感已经恢复大半。',
      '洗完装回去，打字的时候总有种「换了新键盘」的错觉。清洁这件事，快乐不在过程，在装回去的那一瞬间。',
    ],
  },
  {
    t: '写了一个网页版剪贴板：LocalFirst 的一次尝试',
    s: 'localfirst-clipboard-app',
    c: 'tech', tags: ['效率', 'Windows'], d: 74, author: 2,
    sum: '周末小项目：一个纯本地运行的剪贴板历史工具，不联网、不上传、关掉就消失，代码不到三百行。',
    body: [
      '需求来自我自己：在公司电脑和家里电脑之间传个链接，微信传输助手是默认解，但它属于「能用但不想用」的那个类别。',
      '方案想了很多，最后砍到最简：一个本地网页，剪贴板历史存内存，加一个二维码当前内容给手机扫。不联网、不存盘、关掉就消失——数据从来没离开过设备，这是 LocalFirst 最诚实的形态。',
      '总共三百来行，一个周末写完。最难的部分是想清楚「不做什么」：不做同步、不做历史持久化、不做多设备——一旦做了，就要引入账号，引入账号就要考虑隐私，考虑隐私就要写这篇博客解释。砍掉最省事。',
    ],
  },
  {
    t: '周末爬山记：一条被低估的郊野路线',
    s: 'weekend-hiking-trail-notes',
    c: '生活', tags: ['摄影', '随笔'], cover: 10, d: 66, imgs: [1, 2],
    sum: '导航上只有三颗星的野路，走出了一整天的惊喜：路线记录、补给建议、与一张拍了四十遍才满意的照片。',
    body: [
      '这条路线是朋友推荐的，导航评价只有三颗星，去了才明白：分数低是因为没人写攻略，不是因为不好走。',
      '全程七公里，缓坡为主，两处视野极佳的休息点。第一处在半山的岩石平台，能看见整个河谷；第二处在下垭口之前，下午三点整条山脊被斜光打亮，我拍了四十多张，选出一张能看的。',
      '补给建议：水带两升起，山腰没有补给点；防蚊液四月之后必备。鞋子普通越野跑鞋就够，不需要重装装备。',
      '回来路上想，城市的周边其实藏着很多这样的「三颗星宝藏」——不是它们不好，是写攻略的人太少了。所以有了这篇。',
    ],
  },
  {
    t: '密码管理这七年：从浏览器到 KeePass',
    s: 'password-management-7-years',
    c: 'tech', tags: ['效率', '备份'], d: 58,
    sum: '七个年头、四代方案、一次数据丢失事故之后，最终停在「本地库加云盘同步」的组合，理由都在这篇。',
    body: [
      '第一代方案是浏览器记住密码，第二代是某个知名密码管理器的免费版，第三代是自建 Bitwarden，第四代也就是现在：KeePass 本地库，库文件扔云盘同步。',
      '促使每次更换的都是同一种事：那次免费版改收费、那次自建服务半夜挂掉、那次我发现某个扩展请求了奇怪的权限。每次事故都让我离「本地、离线、可审计」近一步。',
      '<h2>现在的原则</h2><ul><li>库文件本地加密，云盘只当搬运工</li><li>主密码足够长，忘了就真的没了（所以有纸质应急卡）</li><li>二步验证能开尽开，密码库只是最后一道墙</li></ul>',
      '七年下来最大的心得：密码管理的本质不是「记住密码」，是「让每个 site 的泄露都互不牵连」。做到这一点，方案本身反而随便。',
    ],
  },
  {
    t: '微博十年，我为什么把短内容搬回自己网站',
    s: 'move-short-posts-back-home',
    c: 'tech', tags: ['随笔', '写作'], d: 50,
    sum: '十年微博、两万条短内容，能导出的不到三成。把碎片记录搬回自己网站的完整决策过程与迁移记录。',
    body: [
      '导出微博那年我数了一下：十年，两万一千条，导出的不到三成，还有一批「仅半年可见」的早就找不回来了。那天我做了个决定：以后所有的短内容，先发自己网站。',
      '<h2>搬回来之后</h2><ul><li>随手记直接发微博板块，不用凑成「一篇」才能写</li><li>话题标签自己定，搜索永远搜得到</li><li>十年后的导出，是我自己的一行 SQL</li></ul>',
      '平台当然还是用，但身份变了：从「住在那里」变成「去那里发名片」。名片上写着：全文在我家。',
    ],
  },
  {
    t: '服务器迁移实录：凌晨三点的 DNS 切换',
    s: 'server-migration-night',
    c: '折腾', tags: ['VPS', '网络'], d: 42,
    sum: '一次教科书式的迁移应该是什么样：演练、降 TTL、双跑观察、切流量、回滚预案，每一环都写在纸上再动手。',
    body: [
      '迁移那天我在白纸上写了六步，每一步旁边写「如果失败怎么办」。凌晨三点正式动手，全程四十分钟，用户侧无感知——写纸上的那半小时，才是迁移的真正工程。',
      '<h2>六步清单</h2><ol><li>新机部署完成，用 hosts 绑定实测全功能</li><li>DNS TTL 降到 300 秒，等两轮旧 TTL 过期</li><li>数据库做主从，双跑观察写入差异</li><li>切换解析，旧机保持服务一小时</li><li>观察日志确认无旧流量，下线旧机</li><li>TTL 调回正常，白纸归档</li></ol>',
      '有人在群里问我为什么迁移要选凌晨——其实任何时段都行，只要每一步都有回滚预案，选几点只是给自己壮胆的仪式。',
    ],
  },
  {
    t: '给博客加一个「历史上的今天」',
    s: 'on-this-day-feature',
    c: 'tech', tags: ['写作', 'Cloudflare'], d: 34, ai: 1,
    sum: '一个不到五十行的功能：按月日匹配往年文章，首页随机出一张「那年今天」卡片。本文由 AI 辅助整理，思路与代码均来自真实迭代。',
    body: [
      '这个功能的灵感来自相册 App 的「那年今天」：某天打开博客，看到三年前今天写的那篇，时间感一下子就出来了。',
      '实现比想象中简单：查询条件是「月日相同、年份不同、已发布」，随机取一条挂在首页。SQL 一行，缓存随页面走，几乎没有成本。',
      '真正的难点在文案：「历史上的今天」这个标题太像百科了，最后改成了「那年今天」，配一句「这篇写在 N 年前」——语气对了，功能就活了。',
    ],
  },
  {
    t: 'The Slow Web Manifesto 读后：慢软件运动在个人站的落点',
    s: 'slow-web-manifesto-notes',
    c: '读书', tags: ['读书笔记', '写作'], d: 27,
    sum: '重读十年前的慢网络宣言，对照今天做博客的每个决定：哪些坚持恰好押中了它，哪些还在路上。',
    body: [
      '这篇宣言十年前就有了，重读时我拿着自己博客的功能清单逐条对照，像一场开卷考试。',
      '押中题的有：无算法时间线、无红点、无「猜你喜欢」。还在路上的有：我仍然会看后台的访问统计，并且会被它影响写作选题——这一条大概永远在路上。',
      '<blockquote>Slow web 不是慢的网，是不催你的网。——读完最想留在笔记里的一句</blockquote>',
      '把这篇读后感写在 3.0 开发期间，是有意的：等级、签到、积分，每一个「成长体系」都可能在催人。怎么给动力不给焦虑，是接下来每个功能上线前要过一遍的问题。',
    ],
  },
  {
    t: '摄影入门三个月：我买对和买错的器材',
    s: 'photography-gear-3-months',
    c: '生活', tags: ['摄影'], cover: 11, d: 19,
    sum: '三个月、两千张废片换来的器材清单：一个定焦用到底的感悟，以及两件后悔没早买的便宜配件。',
    body: [
      '三个月拍了两千多张，能看的不到一百张，但废片教我的比教程多：构图是做减法，光线是唯一的朋友，器材是最不重要的变量——但在预算内，选对器材能少走弯路。',
      '<h2>买对的</h2><ul><li>一颗 35mm 定焦：逼着你用脚步变焦，三个月练出来的构图直觉比变焦头两年都多</li><li>一根快门线：夜景长曝的门票，五十块钱</li><li>一条便宜可靠的相机背带：舒服的背带让出门率翻倍</li></ul>',
      '<h2>买错的</h2><ul><li>UV 镜：好镜片前面加一片廉价玻璃，纯属花钱买隐患</li><li>三脚架（第一支）：买轻了，风一吹全是抖——预算不够时宁可等</li></ul>',
      '最后说个玄学：相机月份牌越拍越准。器材帖写完了，下一篇写这个月去拍的山。',
    ],
  },
  {
    t: '备份是底线：3-2-1 原则在个人站的落地',
    s: 'backup-321-for-personal-site',
    c: 'tech', tags: ['备份', 'VPS'], d: 12,
    sum: '数据无价但备份方案经常形同虚设：把 3-2-1 原则翻译成个人站的可执行清单，外加一次恢复演练记录。',
    body: [
      '3-2-1 原则人人都知道：三份副本、两种介质、一份异地。难的是落地——落地清单其实就四行。',
      '<h2>落地清单</h2><ul><li>数据库每晚自动导出，滚动保留 30 份</li><li>图片与数据库副本各存两个不同位置</li><li>恢复文档写在备份旁边（给未来的自己，或给接手的人）</li><li>每季度真跑一次恢复演练，跑不通的备份等于没有</li></ul>',
      '上周末照例演练，发现一处脚本路径改了没同步——这就是演练的意义：问题在演练里暴露，不在事故里。',
      '最后的提醒送给自己：备份的敌人不是技术，是「一直没出事」这五个字。',
    ],
  },
  {
    t: '铁粉专属：3.0 内测资格与反馈群',
    s: 'fanonly-30-beta-invite',
    c: '折腾', tags: ['内测', '3.0'], d: 8, tier: 'coffee',
    sum: '常客及以上等级的会员可参与 3.0 内测：入口、节奏、以及反馈的方式。感谢每一个常回来的人。',
    body: [
      '这篇给常客以上的朋友。3.0 的三个新东西——铁粉等级、多作者、快讯主题——都到了能玩的状态，先请最熟悉这个站的一批人上手。',
      '<h2>内测节奏</h2><ul><li>第一周：铁粉签到与等级体验，重点试连续签到第 7 天的加成</li><li>第二周：多作者协作，想试试「一家人一起写」的可以在评论区报名</li><li>第三周：快讯主题上线，手机端体验优先</li></ul>',
      '反馈方式就在评论区：卡在哪、哪里别扭、哪里和预期不一样，都算高质量反馈。内测期间出现的任何问题，优先处理。',
    ],
  },
  {
    t: '私密：家庭服务器地址与端口备忘',
    s: 'home-server-notes',
    c: '折腾', tags: ['家庭服务器'], d: 5, pwd: PW_POST,
    sum: '给自己看的备忘：内网穿透的端口表、服务的访问地址、以及重置步骤。访问密码问我本人要。',
    body: [
      '这篇是纯备忘，内容是家里几台机器的地址表和重置步骤，写在这里是因为备忘录 App 换了三代，丢过两次。博客的访问密码至少不会丢。',
      '<h2>重置步骤备忘</h2><ol><li>断电，等 30 秒（不是 10 秒，试过）</li><li>按住 reset 到指示灯变橙再松手</li><li>从备份恢复配置，验证三台设备的连通</li></ol>',
      '写完这篇的感受：所谓自托管，就是把「别人的故障」换成「自己的故障」——但至少自己的故障，修起来不用提工单。',
    ],
  },
  {
    t: '小工具盘点：留在菜单栏里的应用',
    s: 'menu-bar-apps-2026',
    c: '折腾', tags: ['效率'], d: 3, author: 2,
    sum: '一年一度的菜单栏盘点：留下来的七个、新进来的两个、被劝退的一堆。标准只有一个：每天真的会用到。',
    body: [
      '盘点标准很苛刻：过去一个月里，每周至少用三次的才能留下。照这个标准，一半图标被请出了菜单栏。',
      '<h2>留下的七个</h2><ul><li>剪贴板历史：效率工具里的永远的神</li><li>护眼提醒：久坐党的健康保险</li><li>网络监测：排查「是不是没网」的第一反应工具</li></ul>',
      '新进来的是两个：一个是窗口管理，一个是番茄钟。被劝退的那一堆里，最可惜的是某个笔记快捷入口——想法很好，但我的手永远先按到了浏览器书签。',
      '盘点完的感受：菜单栏和桌面一样，是需要定期「断舍离」的地方。工具不是越多越好，是越顺手越好。',
    ],
  },
  {
    t: '写在 3.0 内测开始前：下一步做什么',
    s: 'before-30-beta-starts',
    c: 'tech', tags: ['内测', '3.0'], cover: 12, d: 1, author: 2,
    sum: '三个主题、一份蓝图、一次内测：3.0 的开发顺序、取舍逻辑，以及为什么这次要把「成长的叙事」放进会员体系。',
    body: [
      '这篇是 3.0 的开工备忘。三个主题的优先级排了很久：铁粉体系排第一，因为它回答的是「读者为什么回来」；多作者第二，回答的是「一家人怎么一起写」；快讯主题第三，回答的是「资讯型博客长什么样」。',
      '<h2>这次开发的两条原则</h2><ul><li>等级判定不落库：等级表改了立即生效，没有迁移脚本</li><li>权限白名单写死：多作者的权限面越少越好，不做「可配置的权限系统」</li></ul>',
      '内测期间本地会有一份完整的演示数据：几十篇文章、几百条评论、一批不同等级的会员账号——功能好不好用，用真实数据量说话。',
      '如果你在读这篇并且还不是会员：注册一个，点一下签到，7 天后回来告诉我感受。',
    ],
  },
  /* ---- 非发布态 ---- */
  {
    t: '（草稿）618 剁手清单复盘',
    s: 'draft-618-shopping-review',
    c: '生活', tags: ['随笔'], d: 20, status: 'draft',
    sum: '还没写完：今年 618 买的东西里哪些在吃灰、哪些真香，缺一张表格。',
    body: ['开头写了两段，中间的对比表还没整理。放着别发。'],
  },
  {
    t: '（草稿）LLM 写作流实验第二周',
    s: 'draft-llm-writing-flow-week2',
    c: 'tech', tags: ['效率', 'AI'], d: 9, status: 'draft',
    sum: '实验进行中：让 AI 当编辑而不是作者，两周下来的体感与尚未解决的问题。',
    body: ['第二周的关键分歧点还没想清楚：AI 改稿的边界在哪里。再攒攒案例。'],
  },
  {
    t: '下周见：一次刻意的暂停',
    s: 'scheduled-a-deliberate-pause',
    c: '生活', tags: ['随笔'], d: 0, status: 'scheduled', futureDays: 2.5,
    sum: '定时发布测试文：这篇会在两天后的早上自动上线。暂停一周，去山里走走。',
    body: ['如果你看到这篇，说明定时发布成功了。我去山里待一周，不带电脑。', '留言板照常开放，回来一定回。'],
  },
  {
    t: '旧版关于页（已归档）',
    s: 'old-about-archived',
    c: '生活', tags: ['随笔'], d: 400, trash: 2,
    sum: '被回收站收着的旧关于页，测试恢复流程用。',
    body: ['这是旧版关于页的内容，已被移入回收站，用于测试恢复功能。'],
  },
  {
    t: '废弃项目的最后一次更新说明',
    s: 'deprecated-project-final-note',
    c: 'tech', tags: ['随笔'], d: 380, trash: 15,
    sum: '一个不再维护的项目说明页，进回收站演示软删除。',
    body: ['项目停止维护了，感谢曾经的关注。这篇记录进回收站做演示。'],
  },
]

/** 微博快讯：内容 / 天数（前，可小数）/ 图 / 话题自动提取 / 点赞 / 置顶 / 草稿 */
const WEIBOS = [
  { c: '今天把 3.0 的签到连击调通了，第 7 天的加成弹窗用了新主题色，红得很 Newspaper。 #内测 #3.0', d: 0.2, likes: 12 },
  { c: '楼下咖啡店的豆子换了，手冲变酸了，问了一下是支新的埃塞。适应中，明早再试一次。 #咖啡', d: 0.6, likes: 5 },
  { c: '快讯主题的手机端适配做完了，390px 下一屏四条快讯，滚动很跟手。 #折腾', d: 0.9, likes: 9, imgs: [3, 4] },
  { c: '晚风真好，就是蚊子也真好。 #日常', d: 1.3, likes: 3 },
  { c: '把备份脚本改成了每晚两份滚动，一份上云一份落本地盘。从此睡得更香了。 #备份', d: 2.1, likes: 7 },
  { c: '今天一分钟搞定一次评论审核，新增的快捷键好用，效率翻倍。 #折腾', d: 2.8, likes: 4 },
  { c: '读书会这周读到《置身事内》第四章，讨论比书还精彩。 #读书', d: 3.5, likes: 11, imgs: [5] },
  { c: '周五晚间例行复盘：这周发了一篇长文、跑了一次恢复演练、洗了一个键盘。满意。', d: 4.4, likes: 6 },
  { c: '爬山路线整理成文了，导航上还是三颗星，但值得。链接在博客。 #日常 #摄影', d: 5.2, likes: 15, imgs: [1, 2, 6] },
  { c: '软路由固件更新完，全屋漫游重新测了一遍，无缝切换，满意。 #家庭服务器 #网络', d: 6.0, likes: 8 },
  { c: '有人问博客的字体是什么——答案：系统默认加一点行高调教。少即是多。 #折腾', d: 7.1, likes: 2 },
  { c: '雨天，咖啡馆，写了一下午草稿，完成度六成。 #写作', d: 8.3, likes: 10 },
  { c: '会员数据复盘写完了，有一个发现完全出乎意料，等文章发出来再聊。 #内测', d: 9.2, likes: 14 },
  { c: '键盘洗完像新的，打字的快乐又回来了。阿西吧，为什么两个月前不洗。 #键盘', d: 10.5, likes: 18 },
  { c: '今天起了个大早，六点的小区有鸟叫，有环卫洒水，还有我。 #日常', d: 11.7, likes: 4 },
  { c: '剪贴板小工具开源了，三百行，周末项目，自用为主。 #折腾 #效率', d: 12.9, likes: 21 },
  { c: '把 RSS 订阅数从 88 砍到 48，信息焦虑立刻缓解。做减法真的会上瘾。 #RSS', d: 14.0, likes: 9 },
  { c: '看了一晚上慢网络宣言的旧文，十年前的想法在今天反而更应景。 #读书', d: 15.4, likes: 7 },
  { c: '服务器迁移演练第二轮：回滚预案三分钟跑通。可以约正式切换的凌晨了。 #VPS', d: 16.8, likes: 5 },
  { c: '咖啡手冲日记：这支耶加做冰手冲意外地好，酸感更立体。 #咖啡', d: 18.2, likes: 6, imgs: [4] },
  { c: '摄影课第三周作业：同一棵树，早中晚各拍一张。光线真是最好的滤镜。 #摄影', d: 19.5, likes: 12, imgs: [2, 6] },
  { c: '把「历史上的今天」小功能上线了，首页今天出现的三年前那篇，看得自己都愣了下。 #折腾 #写作', d: 20.9, likes: 16 },
  { c: '今天的写作流水：改旧文错别字十七处，比写新文还累。 #写作', d: 22.0, likes: 3 },
  { c: '周末爬山队集合成功，五个人，两条狗，一路笑声。 #日常', d: 23.6, likes: 20, imgs: [1, 5] },
  { c: '新买的快门线到了，五十块钱的夜景门票，值。 #摄影', d: 25.1, likes: 4 },
  { c: '数据库索引又优化了一轮，后台统计页快得像换了台机器。 #Cloudflare', d: 26.7, likes: 8 },
  { c: '听到楼下小孩背课文，背到「但愿人长久」，背成了「但愿人长久地久天长」，可爱。 #日常', d: 28.3, likes: 25 },
  { c: '一周一首歌计划第 41 周：本周循环的是某首老摇滚，暴露年龄系列。 #日常', d: 30.0, likes: 5 },
  { c: '这篇是草稿状态的快讯测试，不会出现在前台。', d: 31.0, draft: 1 },
  { c: '置顶测试：这条快讯会钉在快讯页顶部，直到取消置顶。欢迎来到我的快讯区。', d: 33.0, likes: 30, pin: 1 },
]

/** 会员：u 用户名 / n 昵称 / p 积分 / a 活跃天数 / streak 连击 / lastCk 几天前签到 / tier / banned / days 注册天数 */
const MEMBERS = [
  { u: 'lan01', n: '阿岚', p: 612, a: 66, streak: 12, lastCk: 1, tier: 'top', days: 180 },
  { u: 'yuanshan', n: '远山', p: 540, a: 55, streak: 20, lastCk: 1, tier: 'top', days: 160 },
  { u: 'beixiang', n: '北巷', p: 388, a: 40, streak: 7, lastCk: 1, tier: 'coffee', days: 140 },
  { u: 'nanfeng', n: '南风知我意', p: 233, a: 25, streak: 3, lastCk: 2, tier: 'coffee', days: 120 },
  { u: 'shibei', n: '拾贝', p: 121, a: 15, streak: 2, lastCk: 1, tier: 'normal', days: 100 },
  { u: 'shiliu', n: '石榴', p: 150, a: 12, streak: 5, lastCk: 1, tier: 'coffee', days: 90, banned: 1 },
  { u: 'lizi', n: '栗子', p: 66, a: 9, streak: 1, lastCk: 3, tier: 'normal', days: 80 },
  { u: 'maidong', n: '麦冬', p: 31, a: 6, streak: 0, lastCk: 0, tier: 'normal', days: 60 },
  { u: 'qingning', n: '青柠', p: 8, a: 4, streak: 0, lastCk: 0, tier: 'normal', days: 30 },
  { u: 'baihua', n: '白桦', p: 4, a: 2, streak: 0, lastCk: 0, tier: 'normal', days: 14 },
  { u: 'yuhuo', n: '渔火', p: 0, a: 0, streak: 0, lastCk: 0, tier: 'normal', days: 1 },
  { u: 'wanfeng', n: '晚风', p: 99, a: 30, streak: 8, lastCk: 1, tier: 'normal', days: 70 },
]

/** 友链 */
const LINKS = [
  { n: '云上小栈', url: 'https://yunshang.bloghao.com', d: '在云端写字的另一个折腾星人', s: 1 },
  { n: '暮色笔记本', url: 'https://muse.bloghao.com', d: '摄影、旅行与胶片扫描', s: 2 },
  { n: '效率工具站', url: 'https://tools.bloghao.com', d: '每周一个效率小工具测评', s: 3 },
  { n: '老王的机房', url: 'https://laowang.bloghao.com', d: '自托管玩家的硬件乐园', s: 4 },
  { n: '面包屑', url: 'https://bread.bloghao.com', d: '读书笔记与书店散步', s: 5 },
  { n: '极简软件志', url: 'https://minimal.bloghao.com', d: '少即是多的软件推荐', s: 6 },
  { n: '山与咖啡', url: 'https://mountain.bloghao.com', d: '户外与手冲的双重沉迷', s: 7 },
  { n: '代码与诗', url: 'https://codepoem.bloghao.com', d: '程序员的人文自留地', s: 8 },
  { n: '申请中的博客', url: 'https://apply1.bloghao.com', d: '待站长审核的友链申请', pending: 1, s: 90 },
  { n: '又一个申请', url: 'https://apply2.bloghao.com', d: '另一个待审核申请', pending: 1, s: 91 },
]

/** 页面（除 about 外的自建页） */
const PAGES = [
  {
    t: '友链与订阅', slug: 'subscribe', nav: 1, d: 210,
    body: '<p>本站长期交换友链，要求很简单：<strong>有独立域名</strong>、近半年有更新、内容原创。在友链页底部提交申请，通过后会出现在列表里。</p><h2>订阅</h2><p>全站提供无截断的 <a href="/rss.xml">RSS 全文输出</a>，欢迎用阅读器订阅。算法不会把我的下一篇推给你，RSS 会。</p>',
  },
  {
    t: '书单（整理中）', slug: 'booklist', nav: 0, d: 30, draft: 1,
    body: '<p>今年的书单还在整理，先把读过的排个队。完成后会发布并挂到导航。</p>',
  },
]

/* ---------------- 组装 ---------------- */

function buildBody(post, authorName) {
  const paras = post.body.map((p) => `<p>${p}</p>`.replace(/^<p><h2>/, '<h2>').replace(/^<p><blockquote>/, '<blockquote>').replace(/^<p><ul>/, '<ul>').replace(/^<p><pre>/, '<pre>').replace(/^<p><ol>/, '<ol>').replace(/<\/ul><\/p>$/, '</ul>').replace(/<\/ol><\/p>$/, '</ol>').replace(/<\/h2><\/p>$/, '</h2>').replace(/<\/blockquote><\/p>$/, '</blockquote>').replace(/<\/pre><\/p>$/, '</pre>'))
  const fillerCount = 2 + Math.floor(rng() * 2)
  const fillers = []
  for (let i = 0; i < fillerCount; i++) fillers.push(FILLER[Math.floor(rng() * FILLER.length)])
  const mid = Math.max(1, paras.length - 1)
  const all = [...paras.slice(0, mid), ...fillers.map((f) => `<p>${f}</p>`), ...paras.slice(mid)]
  return all.join('\n')
}

function buildInsertPosts() {
  const rows = []
  let coverIdx = 0
  POSTS.forEach((p, idx) => {
    const published = !p.status || p.status === 'scheduled'
    const pubAt = p.futureDays ? now + p.futureDays * DAY : daysAgo(p.d)
    const createdAt = pubAt - (1 + Math.floor(rng() * 2)) * DAY
    const cover = p.cover ? `/images/${MONTH}/seed-cover-${String(p.cover).padStart(2, '0')}.png` : ''
    const imgs = p.imgs || []
    let content = buildBody(p)
    for (const n of imgs) {
      content += `\n<p><img src="/images/${MONTH}/seed-img-${String(n).padStart(2, '0')}.png" alt="配图"></p>`
    }
    if (p.pwd) {
      /* 口令哈希在 main() 预生成后经 postPwdHash 注入 */
      content = content // 占位：哈希在 SQL 生成时拼
    }
    assertNoSemicolon(content, `post ${p.s}`)
    assertNoSemicolon(p.sum, `sum ${p.s}`)
    const views = published ? Math.max(30, Math.round((150 - Math.min(150, p.d)) * 9 + rng() * 260)) : 0
    const likes = published ? Math.floor(views / (40 + Math.floor(rng() * 40))) : 0
    rows.push({
      slug: p.s,
      title: p.t,
      content,
      summary: p.sum,
      cover,
      tags: JSON.stringify(p.tags),
      status: p.trash ? 'published' : p.status || 'published',
      pinned: p.pin ? 1 : 0,
      views,
      likes,
      min_tier: p.tier || 'all',
      author_id: p.author === 2 ? 2 : 1,
      published_at: published ? pubAt : null,
      publish_at: p.futureDays ? pubAt : null,
      created_at: createdAt,
      updated_at: pubAt,
      deleted_at: p.trash ? now - p.trash * DAY : null,
      password: p.pwd || '',
      ai: p.ai ? 1 : 0,
    })
    void coverIdx
    void idx
  })
  return rows
}

function buildSql(h) {
  const out = []
  const ins = (sql) => out.push(sql)

  /* 清空业务表（本地开发库专用；settings 一并清空由冷启动重播默认值）。
   * 主键全部显式给 id（不依赖 AUTOINCREMENT 序列，重复播种引用也一致） */
  ;[
    'DELETE FROM comments', 'DELETE FROM post_categories', 'DELETE FROM posts', 'DELETE FROM weibo',
    'DELETE FROM member_points_log', 'DELETE FROM member_sessions', 'DELETE FROM members', 'DELETE FROM sessions',
    'DELETE FROM friend_links', 'DELETE FROM uploads', 'DELETE FROM visit_log', 'DELETE FROM bot_log',
    'DELETE FROM tags', 'DELETE FROM categories', 'DELETE FROM pages', 'DELETE FROM users', 'DELETE FROM settings', 'DELETE FROM tg_buffer',
  ].forEach((s) => ins(s + ';'))

  /* 站长与作者 */
  ins(`INSERT INTO users (id, username, password_hash, salt, display_name, avatar, role, created_at, updated_at) VALUES (1, 'admin', '${h.adminHash}', '${h.adminSalt}', '小吴', '/images/${MONTH}/seed-avatar.png', 'admin', ${now - 400 * DAY}, ${now});`)
  ins(`INSERT INTO users (id, username, password_hash, salt, display_name, avatar, role, created_at, updated_at) VALUES (2, 'xiaoyun', '${h.authorHash}', '${h.authorSalt}', '云舟', '', 'author', ${now - 200 * DAY}, ${now});`)

  /* 站点设置（冷启动 ensureSchema 的 INSERT OR IGNORE 不会覆盖这些键） */
  const settingsPairs = [
    ['siteName', SITE.name],
    ['siteDescription', SITE.desc],
    ['avatarUrl', `/images/${MONTH}/seed-avatar.png`],
    ['membersEnabled', '1'],
  ]
  ins('INSERT INTO settings (key, value) VALUES ' + settingsPairs.map(([k, v]) => `('${k}', '${escSql(assertNoSemicolon(v, `settings ${k}`))}')`).join(', ') + ';')

  /* 分类 / 标签（显式 id：分类 1-4，供 post_categories 引用） */
  ins('INSERT INTO categories (id, name, slug, sort, description, created_at) VALUES ' +
    CATEGORIES.map((c, i) => `(${i + 1}, '${c.name}', '${c.slug}', ${c.sort}, '${escSql(assertNoSemicolon(c.desc, 'cat'))}', ${now - 400 * DAY})`).join(', ') + ';')
  /* POSTS.c 两种写法都兼容（slug 或中文名） */
  const catId = Object.fromEntries(CATEGORIES.flatMap((c, i) => [[c.slug, i + 1], [c.name, i + 1]]))
  ins('INSERT INTO tags (id, name, created_at) VALUES ' + TAGS.map((t, i) => `(${i + 1}, '${escSql(t)}', ${now - 400 * DAY})`).join(', ') + ';')

  /* 文章（显式 id 1..N，与 POSTS 数组顺序一致，供 post_categories / comments 引用） */
  const postRows = buildInsertPosts()
  postRows.forEach((r, i) => {
    const pwdHash = r.password ? `${h.postSalt}:${h.postHash}` : ''
    ins(`INSERT INTO posts (id, slug, old_slugs, title, content, summary, cover, tags, status, pinned, views, likes, min_tier, author_id, published_at, publish_at, password_hash, ai_generated, created_at, updated_at, deleted_at) VALUES (${i + 1}, '${r.slug}', '[]', '${escSql(r.title)}', '${escSql(r.content)}', '${escSql(r.summary)}', '${r.cover}', '${escSql(r.tags)}', '${r.status}', ${r.pinned}, ${r.views}, ${r.likes}, '${r.min_tier}', ${r.author_id}, ${r.published_at ?? 'NULL'}, ${r.publish_at ?? 'NULL'}, '${pwdHash}', ${r.ai}, ${r.created_at}, ${r.updated_at}, ${r.deleted_at ?? 'NULL'});`)
    const cat = POSTS[i].c
    if (cat && !(POSTS[i].status && POSTS[i].status.startsWith('draft'))) {
      ins(`INSERT INTO post_categories (post_id, category_id) VALUES (${i + 1}, ${catId[cat]});`)
    }
  })

  /* 会员（显式 id 1..N，与 MEMBERS 数组顺序一致，供评论 member_id 引用） */
  MEMBERS.forEach((m, i) => {
    const created = now - m.days * DAY
    const lastCk = m.lastCk ? bjDate(now - m.lastCk * DAY) : ''
    const lastAct = (m.lastCk || m.a > 0) ? bjDate(now - (m.lastCk || 1) * DAY) : ''
    ins(`INSERT INTO members (id, username, password_hash, salt, email, display_name, avatar, qq, tier, points, status, created_at, updated_at, last_login_at, display_name_changed_at, active_days, last_active_day, checkin_streak, last_checkin_day) VALUES (${i + 1}, '${m.u}', '${h.memberHash}', '${h.memberSalt}', '', '${m.n}', '', '', '${m.tier}', ${m.p}, '${m.banned ? 'banned' : 'active'}', ${created}, ${now - DAY}, ${now - 2 * DAY}, NULL, ${m.a}, '${lastAct}', ${m.streak}, '${lastCk}');`)
  })

  /* 微博快讯（显式 id 1..N，供评论 weibo_id 引用） */
  WEIBOS.forEach((w, i) => {
    const pubAt = daysAgo(w.d, 7 + Math.floor(rng() * 15))
    const topics = Array.from(new Set((w.c.match(/#([^#\s，。！？]+)/g) || []).map((s) => s.slice(1))))
    const imgs = (w.imgs || []).map((n) => `/images/${MONTH}/seed-img-${String(n).padStart(2, '0')}.png`)
    assertNoSemicolon(w.c, `weibo ${i}`)
    ins(`INSERT INTO weibo (id, content, images, topics, status, pinned, likes, published_at, created_at, updated_at, deleted_at) VALUES (${i + 1}, '${escSql(w.c)}', '${escSql(JSON.stringify(imgs))}', '${escSql(JSON.stringify(topics))}', '${w.draft ? 'draft' : 'published'}', ${w.pin ? 1 : 0}, ${w.likes || 0}, ${w.draft ? 'NULL' : pubAt}, ${pubAt}, ${pubAt}, NULL);`)
  })

  /* 评论（文章 + 微博 + 留言板），显式 id 1..N（parent 楼中楼引用同一套 id） */
  const comments = buildComments()
  comments.forEach((cm) => {
    assertNoSemicolon(cm.content, `comment ${cm.id}`)
    ins(`INSERT INTO comments (id, post_id, weibo_id, parent_id, is_admin, member_id, nickname, email, website, qq, avatar, content, status, ip, ip_region, created_at) VALUES (${cm.id}, ${cm.post}, ${cm.weibo}, ${cm.parent}, ${cm.admin}, ${cm.member}, '${escSql(cm.nick)}', '', '', '', '', '${escSql(cm.content)}', '${cm.status}', '', '${cm.region}', ${cm.at});`)
  })

  /* 图片登记进媒体库（uploads：媒体页与媒体体检都用） */
  ins('INSERT INTO uploads (id, key, name, mime, size, created_at, hash) VALUES ' +
    h.uploads.map((u, i) => `(${i + 1}, '${u.key}', '${u.name}', 'image/png', ${u.size}, ${now - Math.floor(rng() * 90 * DAY)}, '${u.hash}')`).join(', ') + ';')

  /* 友链 */
  ins('INSERT INTO friend_links (name, url, description, icon, status, sort, source, ip, created_at, updated_at) VALUES ' +
    LINKS.map((l) => `('${l.n}', '${l.url}', '${escSql(assertNoSemicolon(l.d, 'link'))}', '', '${l.pending ? 'pending' : 'approved'}', ${l.s}, '${l.pending ? 'user' : 'admin'}', '', ${now - 100 * DAY}, ${now - 100 * DAY})`).join(', ') + ';')

  /* 自建页面（about 由冷启动播种） */
  PAGES.forEach((p) => {
    assertNoSemicolon(p.body, `page ${p.slug}`)
    ins(`INSERT INTO pages (title, slug, content, status, show_in_nav, sort, created_at, updated_at, deleted_at) VALUES ('${p.t}', '${p.slug}', '${escSql(p.body)}', '${p.draft ? 'draft' : 'published'}', ${p.nav ? 1 : 0}, ${p.nav ? 1 : 9}, ${now - p.d * DAY}, ${now - p.d * DAY}, NULL);`)
  })

  /* 访问日志：近 30 天散布 */
  const slugs = POSTS.filter((p) => !p.status && !p.trash).map((p) => p.s)
  const visitPaths = ['/', '/weibo', '/guestbook', '/archives', '/links', ...slugs.map((s) => `/post/${s}`)]
  const devs = ['desktop', 'desktop', 'desktop', 'desktop', 'mobile', 'mobile', 'mobile', 'tablet']
  const brs = ['chrome', 'chrome', 'chrome', 'edge', 'wechat', 'safari', 'firefox', 'other']
  const countries = ['CN', 'CN', 'CN', 'CN', 'CN', 'CN', 'HK', 'US', 'SG', 'JP']
  const refs = ['', '', '', '', '', 'bing.com', 'google.com', 'sspai.com']
  const vrows = []
  for (let i = 0; i < 360; i++) {
    const ts = now - Math.floor(rng() * 30 * DAY)
    vrows.push(`(${ts}, '${bjDate(ts)}', 'v${Math.floor(rng() * 0xffffff).toString(16).padStart(6, '0')}', '${pick(visitPaths)}', '', '${pick(refs)}', '${pick(devs)}', '${pick(brs)}', '${pick(countries)}')`)
  }
  ins('INSERT INTO visit_log (ts, day, vid, path, title, ref, dev, br, country) VALUES ' + vrows.join(', ') + ';')

  /* 爬虫 / AI 抓取日志：近 14 天 */
  const bots = [
    ['Googlebot', 'se'], ['Bingbot', 'se'], ['baiduspider', 'se'], ['YandexBot', 'se'],
    ['GPTBot', 'ai'], ['ClaudeBot', 'ai'], ['Google-Extended', 'ai'], ['Bytespider', 'ai'],
    ['Claude-SearchBot', 'ai-seek'], ['Claude-User', 'ai-seek'], ['PerplexityBot', 'ai-seek'],
    ['Feedly', 'feed'], ['FreshRSS', 'feed'], ['AhrefsBot', 'seo'], ['SemrushBot', 'seo'], ['Wayback Save Page Now', 'arch'],
  ]
  const brows = []
  for (let i = 0; i < 90; i++) {
    const [name, kind] = pick(bots)
    const ts = now - Math.floor(rng() * 14 * DAY)
    const path = kind === 'feed' ? '/rss.xml' : pick(['/', ...visitPaths.slice(3)])
    brows.push(`(${ts}, '${bjDate(ts)}', '${name}', '${kind}', '${path}', '${pick(countries)}')`)
  }
  ins('INSERT INTO bot_log (ts, day, name, kind, path, country) VALUES ' + brows.join(', ') + ';')

  return out.join('\n')
}

/** 评论构建：文章评论约 32 条（含楼中楼与待审）、微博评论 10、留言板 9 */
function buildComments() {
  const list = []
  let id = 0
  const add = (cm) => { cm.id = ++id; list.push(cm); return cm.id }
  const pubSlugs = POSTS.filter((p) => !p.status && !p.trash)
  const activeMembers = MEMBERS.filter((m) => !m.banned)

  const CMT_POOL = [
    '写得很细，收藏了，周末照着试一遍。',
    '同款经历，去年也是这么折腾过来的，看到这篇像看到自己。',
    '请教一下，第二步如果失败了怎么回滚？怕动手。',
    '感谢分享，正好在找这方面的资料，来得太及时了。',
    '看完立刻去翻了自家的账单，果然也是这个问题。',
    '图文并茂，手机上看排版也很舒服，赞。',
    '我卡在第三步两天了，看完你的思路突然通了，谢谢。',
    '数据很实在，比那些只给结论的文章强多了。',
    '这篇转发到群里了，大家都说有用。',
    '有一个小建议：清单部分可以做成表格，查起来更快。',
    '哈哈哈哈洗键那段笑死，两年不洗是真实的。',
    '读完去下单了同款滤杯，回来汇报使用体验。',
    '坐等后续，最好能写一个系列。',
    '「慢软件」这个说法太对了，现在什么都想催我。',
    '留言以示支持，博客越办越好。',
    '楼主人也太好了，评论区居然真的当天回。',
  ]
  const NICKS = ['路过的同学', 'Momo', '阿正', '山月', 'Kira', '奶茶三分糖', '住在隔壁的猫', '大卫', '南巷旧人', '拾光者', 'tt', '一只咸鱼', 'Pepper', '面包屑']

  /* 挑 14 篇文章铺评论，3 篇带楼中楼 */
  const picked = pubSlugs.filter((_, i) => i % 2 === 0).slice(0, 14)
  picked.forEach((p, i) => {
    const pid = POSTS.indexOf(p) + 1
    const count = i < 3 ? 4 : i < 7 ? 3 : 2
    let parent = 0
    for (let k = 0; k < count; k++) {
      const useMember = rng() < 0.45
      const m = useMember ? activeMembers[Math.floor(rng() * activeMembers.length)] : null
      const isAdmin = k === 0 && i % 4 === 0
      const saved = add({
        post: pid, weibo: 0, parent: 0, admin: isAdmin ? 1 : 0,
        member: isAdmin ? 0 : m ? MEMBERS.indexOf(m) + 1 : 0,
        nick: isAdmin ? '小吴' : m ? m.n : NICKS[(i * 3 + k) % NICKS.length],
        content: isAdmin ? '感谢支持，这个问题回头我专门写一篇展开讲。' : CMT_POOL[(i * 5 + k) % CMT_POOL.length],
        status: 'approved', region: pick(['CN:Guangdong', 'CN:Zhejiang', 'CN:Beijing', 'CN:Sichuan', 'US', 'HK', '']),
        at: daysAgo(Math.max(0.2, p.d - k * 0.4), 8 + Math.floor(rng() * 14)),
      })
      if (k === 0) parent = saved
      if (k === 1 && i === 0) {
        /* 楼中楼：作者回复读者 */
        add({
          post: pid, weibo: 0, parent, admin: 1, member: 0, nick: '小吴',
          content: '回滚这部分我补一段，感谢提醒，这确实是最容易翻车的地方。',
          status: 'approved', region: 'CN:Guangdong', at: daysAgo(Math.max(0.1, p.d - 1), 21),
        })
      }
    }
  })

  /* 待审评论 3 条（后台审核流测试用；先审后展关闭时新评论直接可见，这三条用来测「通过」动作） */
  ;[
    { slugIdx: 2, nick: '新访客小赵', content: '请问 Docker 方案里数据库要不要单独挂盘？' },
    { slugIdx: 4, nick: '键盘侠不侠', content: '静电容和红轴比，长时间写代码哪个更护手？' },
    { slugIdx: 9, nick: '终端美化派', content: '求一份终端配置文件的gist分享。' },
  ].forEach((x, i) => {
    add({
      post: x.slugIdx + 1, weibo: 0, parent: 0, admin: 0, member: 0, nick: x.nick,
      content: x.content, status: 'pending', region: pick(['CN:Shanghai', 'CN:Guangdong', '']),
      at: daysAgo(0.3 + i * 0.2, 10 + i),
    })
  })

  /* 微博评论 10 条 */
  const weiboIdx = WEIBOS.map((_, i) => i + 1).filter((i) => !WEIBOS[i - 1].draft)
  for (let i = 0; i < 10; i++) {
    const wid = weiboIdx[i % weiboIdx.length]
    const useMember = i % 2 === 0
    const m = activeMembers[i % activeMembers.length]
    add({
      post: 0, weibo: wid, parent: 0, admin: i === 1 ? 1 : 0,
      member: i === 1 ? 0 : useMember ? MEMBERS.indexOf(m) + 1 : 0,
      nick: i === 1 ? '小吴' : useMember ? m.n : NICKS[(i + 4) % NICKS.length],
      content: i === 1 ? '谢谢捧场，这周末就发完整版。' : pick(['快讯越做越好了，每天来看一眼已经成习惯。', '这条快讯笑死我。', '蹲一个后续。', '同感，做减法是真的爽。']),
      status: 'approved', region: pick(['CN:Guangdong', 'CN:Jiangsu', 'US', '']),
      at: daysAgo(Math.max(0.1, WEIBOS[wid - 1].d - 0.3), 12 + (i % 10)),
    })
  }

  /* 留言板 9 条（post_id=0 且 weibo_id=0），含两条站长回复的楼中楼（parent 用显式 id 计算） */
  const gbStart = list.length + 1 // 留言板第一条评论将拿到的 id
  const gb = [
    { nick: '路人甲', c: '路过留个爪印，博客做得很舒服，没有广告没有弹窗，太清爽了。' },
    { nick: '阿岚', c: '签到打卡，铁粉等级这个设计好可爱，为了「至交」两个字我也要坚持来。', m: 1 },
    { nick: '小吴', c: '欢迎常来，等级表还会微调，以官网公告为准。', admin: 1, parentOf: 2 },
    { nick: '北巷', c: '从搜索引擎的优化文章找过来的，结果在生活分类刷了一小时。', m: 3 },
    { nick: '晚风', c: '想问下博主用的什么阅读器？RSS 那篇里的界面好眼熟。', m: 12 },
    { nick: '小吴', c: '是某款本地优先的，下篇工具盘点里会写到，可以蹲一下。', admin: 1, parentOf: 5 },
    { nick: '渔火', c: '刚注册的新人来问个好，积分从零开始攒。', m: 9 },
    { nick: 'Momo', c: '友链已提交申请，贵站链接已挂好，有空回访～' },
    { nick: '拾贝', c: '每天午休来签到+看快讯，已经是我工位仪式感的一部分。', m: 5 },
  ]
  gb.forEach((x, i) => {
    add({
      post: 0, weibo: 0, parent: x.parentOf ? gbStart + x.parentOf - 1 : 0, admin: x.admin ? 1 : 0,
      member: x.m ? (x.admin ? 0 : x.m) : 0,
      nick: x.nick, content: x.c, status: 'approved',
      region: x.admin ? 'CN:Guangdong' : pick(['CN:Guangdong', 'CN:Beijing', 'CN:Zhejiang', 'US', '']),
      at: daysAgo(18 - i * 2, 9 + (i % 12)),
    })
  })
  return list
}

/* ---------------- 执行 ---------------- */

function runWrangler(args, label) {
  /* 不带 shell：node 直跑 wrangler.js（同 smoke.mjs 的做法）——shell:true 会把带空格的
   * node 路径（C:\Program Files\...）拆碎，Windows 上必炸 */
  const r = spawnSync(process.execPath, [WRANGLER_JS, ...args], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`✗ ${label} 失败：\n${(r.stdout || '') + (r.stderr || '')}`.slice(0, 3000))
    process.exit(1)
  }
  console.log(`✓ ${label}`)
}

async function main() {
  console.log('▸ 生成图片与口令哈希')
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const { createHash } = await import('node:crypto')
  const uploads = []
  for (const img of IMAGE_KEYS) {
    const buf = makePng(img.w, img.h, img.painter)
    writeFileSync(join(TMP, img.key.replace(/\//g, '__')), buf)
    uploads.push({
      key: `${MONTH}/${img.key}`,
      name: img.key.split('/').pop(),
      size: buf.length,
      hash: createHash('sha256').update(buf).digest('hex'),
    })
  }
  const [adminSalt, authorSalt, memberSalt, postSalt] = [hexSalt(), hexSalt(), hexSalt(), hexSalt()]
  const [adminHash, authorHash, memberHash, postHash] = await Promise.all([
    pbkdf2Hex(PW_ADMIN, adminSalt), pbkdf2Hex(PW_AUTHOR, authorSalt), pbkdf2Hex(PW_MEMBER, memberSalt), pbkdf2Hex(PW_POST, postSalt),
  ])
  const h = { adminSalt, adminHash, authorSalt, authorHash, memberSalt, memberHash, postSalt, postHash, uploads }

  console.log('▸ 生成 seed.sql')
  const sql = buildSql(h)
  writeFileSync(join(TMP, 'seed.sql'), sql)
  console.log(`  ${POSTS.length} 篇文章 / ${WEIBOS.length} 条快讯 / ${MEMBERS.length} 位会员 / ${LINKS.length} 友链 / ${IMAGE_KEYS.length} 张图`)

  console.log('▸ 导入本地 D1')
  runWrangler(['d1', 'execute', DB_NAME, '--local', '-y', '--file', join(TMP, 'seed.sql')], 'd1 execute seed.sql')

  console.log('▸ 上传图片到本地 R2')
  for (const img of IMAGE_KEYS) {
    runWrangler(['r2', 'object', 'put', `${BUCKET}/${img.key}`, '--file', join(TMP, img.key.replace(/\//g, '__')), '--local', '--content-type', 'image/png'], `r2 put ${img.key}`)
  }

  console.log('\n════════ 本地 3.0 演示环境就绪 ════════')
  console.log(`启动：npx wrangler dev --ip 0.0.0.0 --port 8787`)
  console.log(`站长后台 /admin ：admin / ${PW_ADMIN}`)
  console.log(`作者账号        ：xiaoyun / ${PW_AUTHOR}`)
  console.log(`会员（全部同密） ：member123456 —— 阿岚(lan01·至交) 远山(yuanshan·铁粉边缘) 北巷(beixiang·常客) 栗子(lizi) 渔火(yuhuo·新人)`)
  console.log(`密码文章访问口令 ：${PW_POST}（文章：私密：家庭服务器地址与端口备忘）`)
  console.log(`被封禁测试账号   ：石榴(shiliu)——登录可见 403 banned`)
  console.log(`回收站有 2 条软删内容、待审评论 3 条、友链待审 2 条`)
  console.log(`图片临时目录 ${TMP} 可删`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
