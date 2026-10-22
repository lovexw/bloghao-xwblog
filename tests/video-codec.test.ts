import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sniffVideoCodec } from '../src/store.ts'

/**
 * 视频编码嗅探（2026-10-22 站长反馈「微博有的视频打不开」）：
 * 现场是 iPhone 录的 HEVC（hvc1）——Chrome / 安卓大部分浏览器解不出来，表现是
 * 时长有、画面全黑、点了没反应。上传时认出编码，前端才好如实提示；
 * 这里守的是「认得出、认得准、认不准时返回 null 不瞎猜」。
 */

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))

/** 组一个 ISO-BMFF box：4 字节大端长度 + 4 字节类型 + 内容 */
function box(type: string, ...payload: Array<number[] | Uint8Array>): number[] {
  const body = payload.flatMap((p) => Array.from(p))
  const size = body.length + 8
  return [(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...ascii(type), ...body]
}

/** 最小 moov 桩：moov > trak > mdia > minf > stbl > stsd > entry(fourcc) */
function moovWith(entryFourcc: string | null, entryCount = 1): number[] {
  const entries = entryFourcc ? box(entryFourcc, new Array(8).fill(0)) : []
  const stsd = box(
    'stsd',
    [0, 0, 0, 0], // version / flags
    [(entryCount >>> 24) & 255, (entryCount >>> 16) & 255, (entryCount >>> 8) & 255, entryCount & 255],
    entries
  )
  return box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))))
}

const ftyp = (brand = 'isom') => box('ftyp', ascii(brand), [0, 0, 2, 0], ascii('isomiso2'))
const mdat = (bytes = 32) => box('mdat', new Array(bytes).fill(0))
const toBuf = (bytes: number[]) => new Uint8Array(bytes).buffer

test('mp4：stsd 里是 hvc1 / hev1 认成 hevc', () => {
  for (const fourcc of ['hvc1', 'hev1']) {
    const file = [...ftyp(), ...moovWith(fourcc), ...mdat()]
    assert.equal(sniffVideoCodec(toBuf(file)), 'hevc', fourcc)
  }
})

test('mp4：avc1 / avc3 认成 h264，vp09 / av01 各自认对', () => {
  assert.equal(sniffVideoCodec(toBuf([...ftyp(), ...moovWith('avc1'), ...mdat()])), 'h264')
  assert.equal(sniffVideoCodec(toBuf([...ftyp(), ...moovWith('avc3'), ...mdat()])), 'h264')
  assert.equal(sniffVideoCodec(toBuf([...ftyp(), ...moovWith('vp09'), ...mdat()])), 'vp9')
  assert.equal(sniffVideoCodec(toBuf([...ftyp(), ...moovWith('av01'), ...mdat()])), 'av1')
})

test('mp4：moov 在文件末尾（非 faststart 的 iPhone 原片）也认得出', () => {
  const file = [...ftyp(), ...mdat(4096), ...moovWith('hvc1')]
  assert.equal(sniffVideoCodec(toBuf(file)), 'hevc')
})

test('mp4：64 位 largesize 的 box 也能顺着走', () => {
  const inner = moovWith('hvc1')
  const body = inner.slice(8) // 去掉原 8 字节头
  const size = body.length + 16
  const large = [
    0, 0, 0, 1, ...ascii('moov'),
    0, 0, 0, 0, (size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255,
    ...body,
  ]
  assert.equal(sniffVideoCodec(toBuf([...ftyp(), ...large])), 'hevc')
})

test('webm：按 CodecID 明文串认（HEVC / VP9 / AV1 / H.264）', () => {
  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]
  const withId = (id: string) => toBuf([...ebml, ...ascii(id), 0x00, 0x00, 0x00])
  assert.equal(sniffVideoCodec(withId('V_MPEGH/ISO/HEVC')), 'hevc')
  assert.equal(sniffVideoCodec(withId('V_VP9')), 'vp9')
  assert.equal(sniffVideoCodec(withId('V_AV1')), 'av1')
  assert.equal(sniffVideoCodec(withId('V_MPEG4/ISO/AVC')), 'h264')
})

test('认不出来一律 null（不瞎猜、不误报成 HEVC）', () => {
  // 空 / 太短
  assert.equal(sniffVideoCodec(new ArrayBuffer(0)), null)
  assert.equal(sniffVideoCodec(toBuf([1, 2, 3, 4])), null)
  // 非视频容器（PNG 头）
  assert.equal(sniffVideoCodec(toBuf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])), null)
  // stsd 里是陌生编码
  assert.equal(sniffVideoCodec(toBuf([...ftyp(), ...moovWith('xxxx'), ...mdat()])), null)
  // stsd 的 entry_count = 0（没有样本描述可读）
  assert.equal(sniffVideoCodec(toBuf([...ftyp(), ...moovWith(null, 0), ...mdat()])), null)
  // box 长度越界（损坏文件）：宁可不判，也不要错判
  const broken = [...ftyp(), 0x7f, 0xff, 0xff, 0xff, ...ascii('moov'), 0, 0, 0, 0]
  assert.equal(sniffVideoCodec(toBuf(broken)), null)
})

test('只认容器结构：文件里恰好出现 hvc1 四个字节（如正文注释）不算 HEVC', () => {
  // 放在 mdat 里的 'hvc1' 不是样本描述——旧实现是全文扫字节，会误报
  const file = [...ftyp(), ...moovWith('avc1'), ...box('mdat', ascii('hvc1'), new Array(16).fill(0))]
  assert.equal(sniffVideoCodec(toBuf(file)), 'h264')
})
