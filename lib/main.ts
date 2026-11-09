// ============================================================
// MasterGo → Claude Code 设计稿导出插件 · 主线程（沙箱）
//
// 职责：
//  1. 遍历选中/页面的节点树，序列化为语义化 design 数据结构
//  2. 自动汇总设计 Token（颜色 / 字体 / 间距 / 圆角 / 阴影）
//  3. 提取图片填充的真实字节（getImageByHref → getBytesAsync）
//  4. 为每个画板生成真实 SVG/PNG 预览（exportAsync，失败时回退为近似 SVG）
//  5. 生成 Markdown 说明文档，全部发送给插件 UI（iframe）打包下载
// ============================================================

import { PluginMessage, sendMsgToUI, UIMessage } from '@messages/sender'

const FORMAT = 'MasterGoExportToJSON'
const FORMAT_VERSION = 2 // v2：design.json 按一级蒙版组拆分为 pages/*.json
const MAX_IMAGES = 200 // 防止文件过大，最多提取的图片素材数量
const MAX_PNG = 30 // 超过此数量的画板不再生成 PNG 预览（仅 SVG）
/** 每种颜色收集的样例节点名上限：仅用于 token 表的样例展示（最多显示 3 个），
 * 超过上限后停止收集，避免「同一颜色被大量不同命名节点使用」时 includes 查找退化为 O(n²) */
const SAMPLE_NAMES_MAX = 10

/** 跨导出缓存图片字节：同一会话内图片未变，重新导出直接复用，避免重复下载 */
const IMAGE_BYTE_CACHE = new Map<string, Uint8Array>()
const IMAGE_CACHE_MAX = 200 // 与 MAX_IMAGES 对齐，超出时淘汰最旧条目，防止内存膨胀
const IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024 // 缓存字节数上限：大图素材（单张数 MB）也能把内存撑爆，超出时同样淘汰最旧条目
/** 素材提取并发数：同时下载的张数，控制内存与耗时的平衡 */
const ASSET_FETCH_CONCURRENCY = 4

/** 当前缓存字节总数（逐项累加，淘汰时同步减） */
function totalCachedBytes(): number {
  let n = 0
  for (const v of IMAGE_BYTE_CACHE.values()) n += v.byteLength || 0
  return n
}

/** 宿主 API 调用超时（毫秒）：偶发挂起时按失败跳过，避免整个导出卡死、取消也失效 */
const IMAGE_FETCH_TIMEOUT = 15000
const FRAME_EXPORT_TIMEOUT = 60000
/** 序列化节点树时每隔多少个节点做一次取消检查（大画板也能随时取消） */
const NODE_CANCEL_CHECK_INTERVAL = 500

// ============================================================
// 插件窗口尺寸（宿主不提供手动拖动放大，由插件自身控制）
// ============================================================
/** 默认面板尺寸：足够宽以便画板卡片排成多列 */
const WINDOW_DEFAULT = { width: 640, height: 780 }
/** 窗口最小/最大尺寸：防止拖拽到不可用（过小）或超出宿主屏幕（过大） */
const WINDOW_MIN = { width: 420, height: 400 }
const WINDOW_MAX = { width: 1400, height: 1200 }
/** 持久化键：记住用户上次调整的窗口尺寸，下次打开恢复 */
const STORAGE_WINDOW_SIZE = 'mgo-window-size'

/** 尺寸夹取到合法范围并取整 */
function clampWindowSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(WINDOW_MIN.width, Math.min(WINDOW_MAX.width, Math.round(width))),
    height: Math.max(WINDOW_MIN.height, Math.min(WINDOW_MAX.height, Math.round(height))),
  }
}

// ============================================================
// 导出数据结构（schema）
// ============================================================

interface RGBAVal {
  r: number
  g: number
  b: number
  a: number
}

interface SerializedPaint {
  type: string
  hex?: string
  rgba?: RGBAVal
  opacity: number
  visible: boolean
  blendMode?: string
  gradientStops?: { position: number; hex: string; opacity: number }[]
  imageRef?: string
  assetId?: string
  file?: string
  scaleMode?: string
}

interface SerializedEffect {
  type: string
  hex?: string
  rgba?: RGBAVal
  offset?: { x: number; y: number }
  radius?: number
  spread?: number
  visible: boolean
  blendMode?: string
}

interface AutoLayoutInfo {
  flexMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  gap: number
  padding: { top: number; right: number; bottom: number; left: number }
  mainAxisAlignItems: string
  crossAxisAlignItems: string
  mainAxisSizingMode: string
  crossAxisSizingMode: string
}

interface TextSegment {
  start: number
  end: number
  fontFamily: string
  fontStyle: string
  fontWeight: number
  fontSize: number
  lineHeightPx: number | null
  letterSpacing: number | null
  textDecoration: string
  textCase: string
  fills: SerializedPaint[]
}

interface TextInfo {
  characters: string
  textAlignHorizontal: string
  textAlignVertical: string
  textAutoResize: string
  hasMissingFont: boolean
  segments: TextSegment[]
}

interface DesignNode {
  id: string
  name: string
  type: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  visible: boolean
  cornerRadius: number | 'MIXED' | null
  cornerRadii: {
    topLeft: number
    topRight: number
    bottomLeft: number
    bottomRight: number
  } | null
  fills: SerializedPaint[]
  strokes: SerializedPaint[]
  strokeWeight: number | null
  strokeAlign: string | null
  effects: SerializedEffect[]
  autoLayout: AutoLayoutInfo | null
  flexGrow: 0 | 1 | null
  alignSelf: string | null
  layoutPositioning: string | null
  constraints: { horizontal: string; vertical: string } | null
  text: TextInfo | null
  component: { name: string; ukey: string; isExternal: boolean } | null
  children: DesignNode[]
}

type DesignFrame = DesignNode & { svgFile: string; previewPngFile?: string }

interface ColorToken {
  hex: string
  usageCount: number
  sampleNames: string[]
}
interface FontToken {
  family: string
  style: string
  fontSize: number
  usageCount: number
}
interface CountToken {
  value: number
  usageCount: number
}
interface ShadowToken {
  label: string
  hex: string
  blur: number
  offsetX: number
  offsetY: number
  usageCount: number
}

interface ImageAsset {
  id: string
  ref: string
  file: string
  mime: string
  bytes: Uint8Array
}

/** 单个页面（一级蒙版组）的导出文档：一个页面对应一个 JSON 文件 */
interface PageDesignDoc {
  format: string
  formatVersion: number
  name: string
  nodeCount: number
  frames: DesignFrame[]
}

interface ExportDesignDoc {
  format: string
  formatVersion: number
  exportedAt: string
  scope: 'selection' | 'page'
  document: { name: string; page: string }
  nodeCount: number
  designTokens: {
    colors: ColorToken[]
    fonts: FontToken[]
    spacings: CountToken[]
    radii: CountToken[]
    shadows: ShadowToken[]
  }
  assets: { id: string; file: string; mime: string }[]
  /** 各页面（一级蒙版组）清单；每个页面一个 JSON 文件 */
  pages: { name: string; file: string; frameCount: number }[]
}

/** 发送给 UI 的单个画板预览 */
interface FrameExport {
  index: number
  name: string
  dimensions: string
  svgFileName: string
  pngFileName: string
  svg: string
  pngBase64: string | null
  /** SVG 为主线程生成的近似图（真实矢量导出失败/返回空串时的兜底）；UI 预览时优先用 PNG */
  svgApprox?: boolean
}

interface AssetPayload {
  id: string
  fileName: string
  mime: string
  data: string // base64
}

interface ExportResultPayload {
  design: ExportDesignDoc
  /** 各页面的 JSON 文件内容（已压缩序列化，UI 直接写入 ZIP） */
  pages: { name: string; file: string; json: string }[]
  markdown: string
  frames: FrameExport[]
  assets: AssetPayload[]
  stats: { frameCount: number; nodeCount: number; imageCount: number }
}

// ============================================================
// 基础工具
// ============================================================

const round = (n: number, digits = 2): number => Number(n.toFixed(digits))

function toHex(v: number): string {
  return Math.round(Math.max(0, Math.min(255, v * 255)))
    .toString(16)
    .padStart(2, '0')
}

/** RGB(RGBA) → #RRGGBB */
function rgbaToHex(c: { r: number; g: number; b: number }): string {
  return `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`.toUpperCase()
}

/** RGBA → #RRGGBBAA（含透明度，仅当 a<1 时输出 AA） */
function rgbaToHexA(c: RGBA): string {
  const base = rgbaToHex(c)
  if (typeof c.a === 'number' && c.a < 1) {
    return `${base}${toHex(c.a).toUpperCase()}`
  }
  return base
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Uint8Array → base64 字符串（沙箱内无 btoa，手动实现） */
function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  const chars = B64_CHARS
  const len = bytes.length
  let i = 0
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    parts.push(chars[(n >> 18) & 63], chars[(n >> 12) & 63], chars[(n >> 6) & 63], chars[n & 63])
  }
  const rem = len - i
  if (rem === 1) {
    const n = bytes[i] << 16
    parts.push(chars[(n >> 18) & 63], chars[(n >> 12) & 63], '=', '=')
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    parts.push(chars[(n >> 18) & 63], chars[(n >> 12) & 63], chars[(n >> 6) & 63], '=')
  }
  return parts.join('')
}

/** 文件名安全化（去非法字符） */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned || 'frame'
}

// ============================================================
// JSON 压缩：省略空值 / 默认值字段，减小 design.json 体积
// ============================================================

/** 字段名 → 默认值：序列化值等于默认时省略该字段（缺省即按默认值理解） */
const OMIT_IF_DEFAULT: Record<string, unknown> = {
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  visible: true,
  cornerRadius: 0,
  strokeWeight: 0,
  gap: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  fontWeight: 400,
  fontSize: 12,
  start: 0,
  position: 0,
  radius: 0,
  spread: 0,
  offsetX: 0,
  offsetY: 0,
  blur: 0,
  mainAxisAlignItems: 'FLEX_START',
  crossAxisAlignItems: 'FLEX_START',
  mainAxisSizingMode: 'FIXED',
  crossAxisSizingMode: 'FIXED',
  textAlignHorizontal: 'LEFT',
  textAlignVertical: 'TOP',
  textAutoResize: 'NONE',
  textDecoration: 'NONE',
  textCase: 'ORIGINAL',
  hasMissingFont: false,
  blendMode: 'NORMAL',
  scaleMode: 'FILL',
}

/** 递归省略 undefined/null/空数组/空对象/默认值字段（就地修改） */
function compactJson(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const v = obj[key]
    if (v === undefined || v === null) {
      delete obj[key]
      continue
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object') compactJson(item as Record<string, unknown>)
      }
      if (v.length === 0) delete obj[key]
      continue
    }
    if (typeof v === 'object') {
      compactJson(v as Record<string, unknown>)
      if (Object.keys(v).length === 0) delete obj[key]
      continue
    }
    if (v === '' && key !== 'characters') {
      delete obj[key]
    } else if (key in OMIT_IF_DEFAULT && v === OMIT_IF_DEFAULT[key]) {
      delete obj[key]
    }
  }
}

// ============================================================
// 设计 Token 收集器
// ============================================================

class TokenCollector {
  colors = new Map<string, ColorToken>()
  fonts = new Map<string, FontToken>()
  spacings = new Map<number, number>()
  radii = new Map<number, number>()
  shadows = new Map<string, ShadowToken>()

  addColor(hex: string, nodeName = ''): void {
    const tok = this.colors.get(hex)
    if (tok) {
      tok.usageCount++
      // 样例名只取前几个，收满即止（见 SAMPLE_NAMES_MAX）：既限制内存，也让 includes 长度有界
      if (nodeName && tok.sampleNames.length < SAMPLE_NAMES_MAX && !tok.sampleNames.includes(nodeName)) {
        tok.sampleNames.push(nodeName)
      }
    } else {
      this.colors.set(hex, {
        hex,
        usageCount: 1,
        sampleNames: nodeName ? [nodeName] : [],
      })
    }
  }

  addFont(family: string, style: string, fontSize: number): void {
    const key = `${family}|${style}|${fontSize}`
    const tok = this.fonts.get(key)
    if (tok) tok.usageCount++
    else this.fonts.set(key, { family, style, fontSize, usageCount: 1 })
  }

  addSpacing(value: number): void {
    this.spacings.set(value, (this.spacings.get(value) ?? 0) + 1)
  }

  addRadius(value: number): void {
    if (value > 0) this.radii.set(value, (this.radii.get(value) ?? 0) + 1)
  }

  addShadow(s: ShadowToken): void {
    const tok = this.shadows.get(s.label)
    if (tok) tok.usageCount++
    else this.shadows.set(s.label, { ...s, usageCount: 1 })
  }

  toJSON() {
    const sortByCount = <T extends { usageCount: number }>(a: T, b: T) =>
      b.usageCount - a.usageCount
    return {
      colors: [...this.colors.values()].sort(sortByCount),
      fonts: [...this.fonts.values()].sort(sortByCount),
      spacings: [...this.spacings.entries()]
        .map(([value, usageCount]) => ({ value, usageCount }))
        .sort((a, b) => b.usageCount - a.usageCount),
      radii: [...this.radii.entries()]
        .map(([value, usageCount]) => ({ value, usageCount }))
        .sort((a, b) => b.usageCount - a.usageCount),
      shadows: [...this.shadows.values()].sort(sortByCount),
    }
  }
}

// ============================================================
// 序列化
// ============================================================

// 任意节点形状（用于安全访问可空属性，规避联合类型的复杂度）
interface AnyNodeLike {
  id: string
  name: string
  type: string
  x?: number
  y?: number
  width?: number
  height?: number
  rotation?: number
  opacity?: number
  isVisible?: boolean
  fills?: ReadonlyArray<Paint>
  strokes?: ReadonlyArray<Paint>
  strokeWeight?: number
  strokeAlign?: string
  effects?: ReadonlyArray<Effect>
  cornerRadius?: number | symbol
  topLeftRadius?: number
  topRightRadius?: number
  bottomLeftRadius?: number
  bottomRightRadius?: number
  flexMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  itemSpacing?: number
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  mainAxisAlignItems?: string
  crossAxisAlignItems?: string
  mainAxisSizingMode?: string
  crossAxisSizingMode?: string
  flexGrow?: number
  alignSelf?: string
  layoutPositioning?: string
  constraints?: Constraints
  characters?: string
  hasMissingFont?: boolean
  textAlignHorizontal?: string
  textAlignVertical?: string
  textAutoResize?: string
  textStyles?: ReadonlyArray<TextSegStyle>
  children?: ReadonlyArray<SceneNode>
  mainComponent?: { name?: string; ukey?: string; isExternal?: boolean } | null
}

interface SerializeCtx {
  fileByRef: Map<string, { id: string; file: string }>
  tokens: TokenCollector
  /** 当前导出 token，序列化大节点树时也能响应取消 */
  token: number
  /** 已序列化节点计数（每 NODE_CANCEL_CHECK_INTERVAL 个节点检查一次取消） */
  nodeCount: number
  /** 帧内子进度回调：serializeNode 周期性调用，按真实节点数上报「序列化画板 n/X」区间内的进度 */
  reportFrame?: () => void
  /** 当前帧区间信息（exportDesign 帧循环开始时设置） */
  frameNo?: number
  totalFrames?: number
  frameName?: string
  frameBase?: number
  frameSpan?: number
  frameNodeCount?: number
  frameNodeStart?: number
}

/** 宽松的 Paint 形状（ReferencePaint 缺少部分字段，按需取用） */
interface PaintLike {
  type: string
  color?: RGBA
  alpha?: number
  isVisible?: boolean
  blendMode?: string
  gradientStops?: ReadonlyArray<{ position: number; color: RGBA }>
  imageRef?: string
  scaleMode?: string
}

/** 宽松的 Effect 形状（ReferenceEffect 缺少部分字段，按需取用） */
interface EffectLike {
  type: string
  isVisible?: boolean
  blendMode?: string
  color?: RGBA
  offset?: { x: number; y: number }
  radius?: number
  spread?: number
}

function serializePaints(
  paints: ReadonlyArray<Paint> | undefined,
  ctx: SerializeCtx,
  nodeName: string,
): SerializedPaint[] {
  if (!paints) return []
  const out: SerializedPaint[] = []
  for (const raw of paints) {
    const p = raw as unknown as PaintLike
    const base: SerializedPaint = {
      type: p.type,
      opacity: p.type === 'SOLID' ? round(p.color?.a ?? 1, 3) : round(p.alpha ?? 1, 3),
      visible: p.isVisible !== false,
      blendMode: p.blendMode,
    }
    if (p.type === 'SOLID' && p.color) {
      base.hex = rgbaToHexA(p.color)
      base.rgba = {
        r: round(p.color.r, 3),
        g: round(p.color.g, 3),
        b: round(p.color.b, 3),
        a: round(p.color.a, 3),
      }
      ctx.tokens.addColor(base.hex, nodeName)
    } else if (p.type.startsWith('GRADIENT_') && p.gradientStops) {
      base.gradientStops = p.gradientStops.map((s) => ({
        position: round(s.position, 3),
        hex: rgbaToHexA(s.color),
        opacity: round(s.color.a, 3),
      }))
    } else if (p.type === 'IMAGE') {
      base.imageRef = p.imageRef
      base.scaleMode = p.scaleMode
      const asset = ctx.fileByRef.get(p.imageRef ?? '')
      if (asset) {
        base.assetId = asset.id
        base.file = asset.file
      }
    }
    out.push(base)
  }
  return out
}

function serializeEffects(effects: ReadonlyArray<Effect> | undefined): SerializedEffect[] {
  if (!effects) return []
  const out: SerializedEffect[] = []
  for (const raw of effects) {
    const e = raw as unknown as EffectLike
    const base: SerializedEffect = {
      type: e.type,
      visible: e.isVisible !== false,
      blendMode: e.blendMode,
    }
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      base.hex = rgbaToHexA(e.color ?? { r: 0, g: 0, b: 0, a: 1 })
      base.rgba = e.color
        ? {
            r: round(e.color.r, 3),
            g: round(e.color.g, 3),
            b: round(e.color.b, 3),
            a: round(e.color.a, 3),
          }
        : undefined
      base.offset = { x: round(e.offset?.x ?? 0), y: round(e.offset?.y ?? 0) }
      base.radius = round(e.radius ?? 0)
      base.spread = round(e.spread ?? 0)
    } else {
      base.radius = round(e.radius ?? 0)
    }
    out.push(base)
  }
  return out
}

function serializeAutoLayout(n: AnyNodeLike, tokens: TokenCollector): AutoLayoutInfo | null {
  if (!n.flexMode || n.flexMode === 'NONE') return null
  const gap = round(n.itemSpacing ?? 0)
  if (gap > 0) tokens.addSpacing(gap)
  return {
    flexMode: n.flexMode,
    gap,
    padding: {
      top: round(n.paddingTop ?? 0),
      right: round(n.paddingRight ?? 0),
      bottom: round(n.paddingBottom ?? 0),
      left: round(n.paddingLeft ?? 0),
    },
    mainAxisAlignItems: n.mainAxisAlignItems ?? 'FLEX_START',
    crossAxisAlignItems: n.crossAxisAlignItems ?? 'FLEX_START',
    mainAxisSizingMode: n.mainAxisSizingMode ?? 'FIXED',
    crossAxisSizingMode: n.crossAxisSizingMode ?? 'FIXED',
  }
}

const NODE_TYPES_WITH_CHILDREN = new Set([
  'FRAME',
  'GROUP',
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'BOOLEAN_OPERATION',
  'SECTION',
  'INTELLIGENT_CONTAINER',
])

async function serializeNode(node: SceneNode, ctx: SerializeCtx): Promise<DesignNode> {
  // 节点级取消检查 + 周期性让出：单个超大画板序列化期间既能响应取消，进度消息/UI 渲染也能穿插执行
  if ((++ctx.nodeCount % NODE_CANCEL_CHECK_INTERVAL) === 0) {
    checkCancel(ctx.token)
    await yieldToUI()
    ctx.reportFrame?.() // 帧内子进度：按真实节点数推进，与「序列化画板 n/X」标签同维度
  }
  const n = node as unknown as AnyNodeLike
  const name = n.name ?? ''
  const type = n.type ?? 'UNKNOWN'

  // ---- 圆角
  let cornerRadius: number | 'MIXED' | null = null
  let cornerRadii: DesignNode['cornerRadii'] = null
  if (typeof n.cornerRadius === 'number') {
    cornerRadius = round(n.cornerRadius)
  } else if (n.cornerRadius !== undefined && n.cornerRadius !== null) {
    cornerRadius = 'MIXED'
  }
  if (type === 'RECTANGLE' || type === 'FRAME' || type === 'COMPONENT' || type === 'INSTANCE' || type === 'COMPONENT_SET') {
    const tl = n.topLeftRadius
    const tr = n.topRightRadius
    const bl = n.bottomLeftRadius
    const br = n.bottomRightRadius
    if (tl !== undefined || tr !== undefined || bl !== undefined || br !== undefined) {
      cornerRadii = {
        topLeft: round(tl ?? 0),
        topRight: round(tr ?? 0),
        bottomLeft: round(bl ?? 0),
        bottomRight: round(br ?? 0),
      }
      if (tl === tr && tl === bl && tl === br && tl !== undefined) {
        if (cornerRadius === 'MIXED') cornerRadius = round(tl)
      } else {
        cornerRadius = 'MIXED'
      }
    }
  }
  if (typeof cornerRadius === 'number') ctx.tokens.addRadius(cornerRadius)

  // ---- 填充 / 描边 / 特效
  const fills = serializePaints(n.fills, ctx, name)
  const strokes = serializePaints(n.strokes, ctx, name)
  const effects = serializeEffects(n.effects)
  for (const e of effects) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      ctx.tokens.addShadow({
        label: `${e.type}|${e.hex}|${e.radius}|${e.offset?.x}|${e.offset?.y}`,
        hex: e.hex ?? '#000000',
        blur: e.radius ?? 0,
        offsetX: e.offset?.x ?? 0,
        offsetY: e.offset?.y ?? 0,
        usageCount: 1,
      })
    }
  }

  // ---- 自动布局
  const autoLayout = serializeAutoLayout(n, ctx.tokens)

  // ---- 文本
  let text: TextInfo | null = null
  if (type === 'TEXT' && typeof n.characters === 'string') {
    const segments: TextSegment[] = (n.textStyles ?? []).map((s) => {
      const ts = s.textStyle
      const fills = serializePaints(s.fills, ctx, name)
      return {
        start: s.start,
        end: s.end,
        fontFamily: ts.fontName?.family ?? '未知字体',
        fontStyle: ts.fontName?.style ?? '',
        fontWeight: ts.fontWeight ?? 400,
        fontSize: ts.fontSize ?? 12,
        lineHeightPx:
          ts.lineHeightByPx ??
          (ts.lineHeight?.unit === 'PIXELS' ? (ts.lineHeight.value ?? null) : null),
        letterSpacing:
          ts.letterSpacing?.unit === 'PIXELS' ? (ts.letterSpacing.value ?? null) : null,
        textDecoration: ts.textDecoration ?? 'NONE',
        textCase: ts.textCase ?? 'ORIGINAL',
        fills,
      }
    })
    for (const seg of segments) {
      ctx.tokens.addFont(seg.fontFamily, seg.fontStyle, seg.fontSize)
      for (const f of seg.fills) if (f.hex) ctx.tokens.addColor(f.hex, name)
    }
    text = {
      characters: n.characters,
      textAlignHorizontal: n.textAlignHorizontal ?? 'LEFT',
      textAlignVertical: n.textAlignVertical ?? 'TOP',
      textAutoResize: n.textAutoResize ?? 'NONE',
      hasMissingFont: !!n.hasMissingFont,
      segments,
    }
  }

  // ---- 组件信息（实例）
  let component: DesignNode['component'] = null
  if (type === 'INSTANCE' && n.mainComponent) {
    component = {
      name: n.mainComponent.name ?? '',
      ukey: n.mainComponent.ukey ?? '',
      isExternal: !!n.mainComponent.isExternal,
    }
  }

  // ---- 子节点（顺序 await：保持与原同步递归一致的深度优先顺序，token 收集顺序不变）
  let children: DesignNode[] = []
  if (NODE_TYPES_WITH_CHILDREN.has(type) && Array.isArray(n.children)) {
    const cs = n.children as ReadonlyArray<SceneNode>
    for (const c of cs) children.push(await serializeNode(c, ctx))
  }

  return {
    id: n.id,
    name,
    type,
    x: round(n.x ?? 0),
    y: round(n.y ?? 0),
    width: round(n.width ?? 0),
    height: round(n.height ?? 0),
    rotation: round(n.rotation ?? 0),
    opacity: round(n.opacity ?? 1, 3),
    visible: n.isVisible !== false,
    cornerRadius,
    cornerRadii,
    fills,
    strokes,
    strokeWeight: typeof n.strokeWeight === 'number' ? round(n.strokeWeight) : null,
    strokeAlign: n.strokeAlign ?? null,
    effects,
    autoLayout,
    flexGrow: n.flexGrow === 1 ? 1 : n.flexGrow === 0 ? 0 : null,
    alignSelf: n.alignSelf ?? null,
    layoutPositioning: n.layoutPositioning ?? null,
    constraints: n.constraints
      ? { horizontal: n.constraints.horizontal, vertical: n.constraints.vertical }
      : null,
    text,
    component,
    children,
  }
}

function countNodes(nodes: DesignNode[]): number {
  let count = nodes.length
  for (const n of nodes) count += countNodes(n.children ?? [])
  return count
}

/** 统计一个原始画板根节点（SceneNode）的节点总数，用于帧内子进度的分母 */
function countRawNodes(node: unknown): number {
  const n = node as { children?: unknown[] }
  let c = 1
  if (Array.isArray(n.children)) for (const ch of n.children) c += countRawNodes(ch)
  return c
}

// ============================================================
// 页面（一级蒙版组）拆分
// ============================================================

/** 顶层待导出节点 → 页面的规划：一级蒙版组（GROUP）即一个页面，其直接子节点为该页的画板 */
interface PagePlan {
  name: string // 去重后的页面名（同名追加 _2/_3…）
  file: string // pages/<name>.json
  frameRoots: SceneNode[] // 该页包含的画板节点（直接导出 SVG/PNG 的根）
}

function buildPages(roots: SceneNode[]): PagePlan[] {
  const nameCount = new Map<string, number>()
  const usedFiles = new Set<string>()
  const nextName = (raw: string): string => {
    const base = raw.trim() || '未命名'
    const count = (nameCount.get(base) ?? 0) + 1
    nameCount.set(base, count)
    return count === 1 ? base : `${base}_${count}`
  }
  const nextFile = (name: string): string => {
    const safe = safeFileName(name) || 'page'
    let file = `pages/${safe}.json`
    let n = 2
    while (usedFiles.has(file)) {
      file = `pages/${safe}_${n}.json`
      n++
    }
    usedFiles.add(file)
    return file
  }

  const pages: PagePlan[] = []
  for (const root of roots) {
    const raw = (root as unknown as { name?: string }).name ?? ''
    const name = nextName(raw)
    const file = nextFile(name)
    const type = (root as unknown as { type?: string }).type
    // 一级蒙版组 = 页面：其直接子节点就是该页的画板；其余顶层节点各自成页
    const frameRoots =
      type === 'GROUP' && Array.isArray((root as unknown as { children?: unknown }).children)
        ? (root as unknown as { children: SceneNode[] }).children
        : [root]
    pages.push({ name, file, frameRoots })
  }
  return pages
}

// ============================================================
// 图片素材提取
// ============================================================

async function collectImageRefs(
  nodes: ReadonlyArray<SceneNode>,
  refs: Set<string>,
  token: number,
  count: { n: number },
): Promise<void> {
  for (const raw of nodes) {
    // 大节点树枚举期间周期让出事件循环：已 postMessage 的进度消息得以投递、UI 进度条保持平滑
    if ((++count.n % NODE_CANCEL_CHECK_INTERVAL) === 0) {
      checkCancel(token)
      await yieldToUI()
    }
    const node = raw as unknown as AnyNodeLike
    for (const list of [node.fills ?? [], node.strokes ?? []]) {
      for (const p of list) {
        if (p.type === 'IMAGE' && p.imageRef) refs.add(p.imageRef)
      }
    }
    // 文本段样式里的图片填充
    for (const s of node.textStyles ?? []) {
      for (const p of s.fills ?? []) {
        if (p.type === 'IMAGE' && p.imageRef) refs.add(p.imageRef)
      }
    }
    if (Array.isArray(node.children)) {
      await collectImageRefs(node.children as ReadonlyArray<SceneNode>, refs, token, count)
    }
  }
}

function sniffMime(bytes: Uint8Array): string {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return 'image/gif'
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return 'image/webp'
  return 'image/png'
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** 导出被中断时抛出，runExport 据此发 EXPORT_CANCELLED 而非 EXPORT_ERROR */
class ExportCancelledError extends Error {
  constructor() {
    super('导出已取消')
    this.name = 'ExportCancelledError'
  }
}

/** 导出中断控制：新一轮导出 / 用户取消都会递增序号，旧 token 立即失效 */
let exportSeq = 0
function exportCancelled(token: number): boolean {
  return token !== exportSeq
}
/** 在循环检查点调用，已中断则抛错终止当前导出 */
function checkCancel(token: number): void {
  if (exportCancelled(token)) throw new ExportCancelledError()
}

// ============================================================
// 宿主操作串行化 + 在途宿主调用登记（取消→再导出的并发/内存防御）
// ============================================================

/**
 * 所有宿主操作（导出、单画板/批量高清 PNG 下载）经 opQueue 串行化：同一批节点上并发发起
 * exportAsync / getBytesAsync 会叠加宿主渲染任务。多次「取消→立即再导出」时，若上一个导出的
 * 宿主调用还在后台运行就发起新的，宿主内存/渲染资源越积越多，最终触发「内存不足」，甚至宿主
 * 内部错误（数组越界）；串行化保证同一时刻只有一组宿主调用在跑。
 */
let opQueue: Promise<unknown> = Promise.resolve()
function enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
  const p = opQueue.then(fn)
  opQueue = p.then(
    () => undefined,
    () => undefined,
  ) // 队列吞错：错误由 fn 内部自行处理，不打断后续排队
  return p
}

/** 仍在后台运行的宿主调用（exportAsync / getBytesAsync 的原始 Promise）。
 * 取消导出时 withTimeout 只会放弃自己的包装 Promise，宿主调用本身无法中止，会继续在后台
 * 消耗渲染/内存资源直到自然结束；新导出开始前先等它们收尾，避免与遗留任务叠加。 */
const inflightHostCalls = new Set<Promise<unknown>>()
function trackHostCall<T>(p: Promise<T>): Promise<T> {
  inflightHostCalls.add(p)
  const drop = () => inflightHostCalls.delete(p)
  p.then(drop, drop)
  return p
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 等待上一个操作遗留的宿主调用收尾（上限 capMs，超时不再等——宿主调用最终会自行结束并释放资源）。 */
async function drainInflightHost(capMs: number): Promise<void> {
  const current = [...inflightHostCalls] // 只快照已有调用，不含本次操作将新发起的
  if (current.length === 0) return
  await Promise.race([Promise.allSettled(current), sleepMs(capMs)])
}

/** 让出事件循环：长同步段（大节点树序列化/素材枚举）期间，已 postMessage 的进度消息得以投递、UI 得以渲染 */
const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * 给宿主 API 调用加超时兜底：ms 毫秒内未返回则拒绝（按失败处理，调用方跳过）。
 * 宿主调用偶发「永不 resolve」时，导出循环能继续而不是整体卡死、取消也失效。
 * 传入 isCancelled 时每 200ms 轮询一次：导出被中断后不等宿主调用返回，立刻以取消中止。
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  isCancelled?: () => boolean,
): Promise<T> {
  const tracked = trackHostCall(p) // 登记原始宿主调用：取消放弃的是本包装，宿主调用仍会后台跑完
  return new Promise<T>((resolve, reject) => {
    let timer = 0
    let poller: number | null = null
    const settle = () => {
      clearTimeout(timer)
      if (poller !== null) clearInterval(poller)
    }
    timer = setTimeout(() => {
      if (poller !== null) clearInterval(poller)
      reject(new Error(`${label}超时（${ms}ms）`))
    }, ms)
    if (isCancelled) {
      poller = setInterval(() => {
        if (isCancelled()) {
          clearTimeout(timer)
          clearInterval(poller as number)
          reject(new ExportCancelledError())
        }
      }, 200)
    }
    tracked.then(
      (v) => {
        settle()
        resolve(v)
      },
      (e) => {
        settle()
        reject(e)
      },
    )
  })
}

/** 下载单个图片素材字节，带一次失败重试；取消时立即抛 ExportCancelledError，最终失败返回 null（由调用方跳过该素材）。
 * 宿主下载偶发失败（网络抖动 / 大图超时）时自动重试一次，避免素材丢失。 */
async function fetchImageBytes(token: number, ref: string): Promise<Uint8Array | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    checkCancel(token) // 每尝试前可中断
    try {
      const b = await withTimeout(
        mg.getImageByHref(ref).getBytesAsync(),
        IMAGE_FETCH_TIMEOUT,
        '图片下载',
        () => exportCancelled(token),
      )
      if (b instanceof Uint8Array && b.length > 0) return b
      // 返回空数据视为失败，尝试下一次
    } catch (err) {
      if (exportCancelled(token)) throw err // 取消优先：不吞取消，直接上抛
      if (attempt === 2) throw err // 第二次也失败，上抛由调用方跳过该素材
      console.warn(`图片下载失败（第 ${attempt} 次，将重试）：`, ref, err)
    }
  }
  return null
}

async function extractAssets(
  roots: ReadonlyArray<SceneNode>,
  token: number,
  report: (percent: number, label: string) => void,
): Promise<{
  assets: ImageAsset[]
  fileByRef: Map<string, { id: string; file: string }>
}> {
  const refs = new Set<string>()
  await collectImageRefs(roots, refs, token, { n: 0 })
  const list = [...refs].slice(0, MAX_IMAGES)
  const total = list.length
  if (total === 0) {
    report(30, '无图片素材')
    return { assets: [], fileByRef: new Map() }
  }
  report(0, `提取图片素材（共 ${total} 张）`)
  const assets: ImageAsset[] = []
  const fileByRef = new Map<string, { id: string; file: string }>()
  let completed = 0
  let next = 0
  // 小并发池：同时下载 ASSET_FETCH_CONCURRENCY 张；序号按 refs 顺序预分配（与完成顺序无关），命名保持稳定
  const worker = async (): Promise<void> => {
    while (next < list.length) {
      checkCancel(token) // 每张素材间可中断
      const ref = list[next]
      const idx = next
      next++
      let bytes: Uint8Array | null = null
      try {
        const cached = IMAGE_BYTE_CACHE.get(ref)
        if (cached) {
          bytes = cached
        } else {
          bytes = await fetchImageBytes(token, ref)
          if (bytes) {
            IMAGE_BYTE_CACHE.set(ref, bytes)
            // 超出条目数或总字节数上限时淘汰最旧条目（Map 按插入序迭代），防止内存膨胀
            if (IMAGE_BYTE_CACHE.size > IMAGE_CACHE_MAX || totalCachedBytes() > IMAGE_CACHE_MAX_BYTES) {
              let oldest = IMAGE_BYTE_CACHE.keys().next().value
              while (oldest !== undefined && (IMAGE_BYTE_CACHE.size > IMAGE_CACHE_MAX || totalCachedBytes() > IMAGE_CACHE_MAX_BYTES)) {
                IMAGE_BYTE_CACHE.delete(oldest)
                oldest = IMAGE_BYTE_CACHE.keys().next().value
              }
            }
          }
        }
      } catch (err) {
        console.warn('图片提取失败（已跳过）：', ref, err)
      }
      if (bytes) {
        const mime = sniffMime(bytes)
        const id = `image_${idx + 1}`
        const stem = `img_${idx + 1}`
        // 每个素材一个子文件夹，同一素材的不同倍率都放里面
        const file = `assets/${stem}/${stem}.${EXT_BY_MIME[mime] ?? 'png'}`
        assets.push({ id, ref, file, mime, bytes })
        fileByRef.set(ref, { id, file })
      }
      completed++
      report(Math.round((30 * completed) / total), `提取图片素材 ${completed}/${total}`)
      await yieldToUI() // 缓存命中时的纯同步段里也让出事件循环，进度消息及时投递
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ASSET_FETCH_CONCURRENCY, total) }, () => worker()),
  )
  report(30, '素材提取完成')
  return { assets, fileByRef }
}

// ============================================================
// SVG 近似预览生成（仅当 exportAsync 失败时回退，主线程字符串拼装）
// ============================================================

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function cssFontWeight(style: string): number {
  const s = style.toLowerCase()
  if (s.includes('thin') || s.includes('hairline')) return 100
  if (s.includes('extralight') || s.includes('ultralight')) return 200
  if (s.includes('light')) return 300
  if (s.includes('medium')) return 500
  if (s.includes('semibold') || s.includes('demibold')) return 600
  if (s.includes('extrabold') || s.includes('ultrabold')) return 800
  if (s.includes('black') || s.includes('heavy')) return 900
  if (s.includes('bold')) return 700
  return 400
}

function firstSolid(fills: SerializedPaint[] | undefined): SerializedPaint | null {
  return (fills ?? []).find((f) => f.visible !== false && f.type === 'SOLID' && f.hex) ?? null
}

function firstGradient(fills: SerializedPaint[] | undefined): SerializedPaint | null {
  return (fills ?? []).find((f) => f.visible !== false && f.type.startsWith('GRADIENT_')) ?? null
}

function hasImage(fills: SerializedPaint[] | undefined): boolean {
  return (fills ?? []).some((f) => f.visible !== false && f.type === 'IMAGE')
}

function svgRx(node: DesignNode): number {
  const r = node.cornerRadius
  if (typeof r === 'number') return Math.max(0, r)
  if (node.cornerRadii) return Math.max(0, node.cornerRadii.topLeft)
  return 0
}

function renderBackground(
  node: DesignNode,
  x: number,
  y: number,
  body: string[],
  defs: string[],
): void {
  const w = node.width
  const h = node.height
  if (w <= 0 || h <= 0) return
  const solid = firstSolid(node.fills)
  const grad = firstGradient(node.fills)
  const opacity = (node.opacity ?? 1) < 1 ? ` opacity="${round(node.opacity ?? 1, 2)}"` : ''
  if (solid) {
    body.push(
      `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${round(svgRx(node))}" fill="${solid.hex}"${opacity}/>`,
    )
  } else if (grad && grad.gradientStops && grad.gradientStops.length > 0) {
    const gid = `g${node.id.replace(/[^a-zA-Z0-9]/g, '')}`
    const stops = grad.gradientStops
      .map(
        (s) =>
          `<stop offset="${Math.round(s.position * 100)}%" stop-color="${s.hex}" stop-opacity="${round(s.opacity, 2)}"/>`,
      )
      .join('')
    const horizontal = grad.type === 'GRADIENT_LINEAR'
    defs.push(
      `<linearGradient id="${gid}" x1="0" y1="0" x2="${horizontal ? 1 : 0}" y2="${horizontal ? 0 : 1}">${stops}</linearGradient>`,
    )
    body.push(
      `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${round(svgRx(node))}" fill="url(#${gid})"${opacity}/>`,
    )
  } else if (hasImage(node.fills)) {
    // 图片填充：占位矩形，示意为图片区域
    body.push(
      `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${round(svgRx(node))}" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="5 4"${opacity}/>`,
    )
  }
  // 描边
  const stroke = firstSolid(node.strokes)
  if (stroke && node.strokeWeight) {
    body.push(
      `<rect x="${round(x + (node.strokeWeight ?? 0) / 2)}" y="${round(y + (node.strokeWeight ?? 0) / 2)}" width="${round(Math.max(0, w - (node.strokeWeight ?? 0)))}" height="${round(Math.max(0, h - (node.strokeWeight ?? 0)))}" rx="${round(Math.max(0, svgRx(node) - (node.strokeWeight ?? 0) / 2))}" fill="none" stroke="${stroke.hex}" stroke-width="${round(node.strokeWeight)}"${opacity}/>`,
    )
  }
}

function renderTextNode(
  node: DesignNode,
  x: number,
  y: number,
  body: string[],
): void {
  const t = node.text
  if (!t) return
  const seg = t.segments[0]
  const fontSize = seg?.fontSize ?? 12
  const family = seg?.fontFamily ?? 'sans-serif'
  const weight = cssFontWeight(seg?.fontStyle ?? '')
  const color = seg?.fills.find((f) => f.type === 'SOLID' && f.hex)?.hex ?? '#000000'
  const lines = t.characters.split('\n')
  const anchor =
    t.textAlignHorizontal === 'CENTER'
      ? 'middle'
      : t.textAlignHorizontal === 'RIGHT'
        ? 'end'
        : 'start'
  const lineHeight = seg?.lineHeightPx ?? fontSize * 1.3
  let anchorX: number
  if (anchor === 'middle') anchorX = x + node.width / 2
  else if (anchor === 'end') anchorX = x + node.width
  else anchorX = x
  const totalH = lines.length * lineHeight
  let baseline = y + fontSize
  if (t.textAlignVertical === 'CENTER') baseline = y + Math.max(0, (node.height - totalH) / 2) + fontSize
  else if (t.textAlignVertical === 'BOTTOM') baseline = y + node.height - totalH + fontSize
  lines.forEach((line, i) => {
    const yy = baseline + i * lineHeight
    body.push(
      `<text x="${round(anchorX)}" y="${round(yy)}" font-family="${escapeXml(family)}" font-size="${round(fontSize)}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(line)}</text>`,
    )
  })
}

function renderDesignNode(
  node: DesignNode,
  baseX: number,
  baseY: number,
  body: string[],
  defs: string[],
): void {
  const x = baseX + node.x
  const y = baseY + node.y
  const visibility = node.visible !== false ? '' : ' visibility="hidden"'

  if (node.type === 'TEXT' && node.text) {
    renderTextNode(node, x, y, body)
  } else {
    renderBackground(node, x, y, body, defs)
    if (node.type === 'ELLIPSE') {
      const cx = x + node.width / 2
      const cy = y + node.height / 2
      body.push(
        `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(node.width / 2)}" ry="${round(node.height / 2)}" fill="${firstSolid(node.fills)?.hex ?? 'transparent'}"/>`,
      )
    } else if (node.type === 'LINE') {
      const color = firstSolid(node.strokes)?.hex ?? '#333333'
      body.push(
        `<line x1="${round(x)}" y1="${round(y + node.height / 2)}" x2="${round(x + node.width)}" y2="${round(y + node.height / 2)}" stroke="${color}" stroke-width="${round(node.strokeWeight ?? 1)}"/>`,
      )
    } else if (node.type === 'POLYGON' || node.type === 'STAR' || node.type === 'PEN' || node.type === 'BOOLEAN_OPERATION') {
      // 复杂矢量：以带填充的矩形近似示意
      const solid = firstSolid(node.fills)
      if (solid) {
        body.push(
          `<rect x="${round(x)}" y="${round(y)}" width="${round(node.width)}" height="${round(node.height)}" fill="${solid.hex}"${visibility}/>`,
        )
      }
    }
  }

  for (const child of node.children ?? []) {
    renderDesignNode(child, x, y, body, defs)
  }
}

function generateFrameSvg(frame: DesignNode): string {
  const w = Math.max(1, round(frame.width))
  const h = Math.max(1, round(frame.height))
  const body: string[] = []
  const defs: string[] = []
  renderDesignNode(frame, 0, 0, body, defs)
  const defsStr = defs.length ? `<defs>${defs.join('')}</defs>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    defsStr +
    `<g clip-path="url(#frameClip)"><clipPath id="frameClip"><rect width="${w}" height="${h}"/></clipPath>` +
    body.join('') +
    `</g></svg>`
  )
}

// ============================================================
// Markdown 说明文档生成
// ============================================================

function treeLines(nodes: DesignNode[] | undefined, depth: number): string[] {
  const out: string[] = []
  for (const n of nodes ?? []) {
    const indent = '  '.repeat(depth)
    const geo =
      n.type === 'TEXT'
        ? `${n.width}×${n.height} "${(n.text?.characters ?? '').slice(0, 20)}"`
        : `${n.width}×${n.height}`
    out.push(`${indent}- ${n.type}「${n.name}」 (${n.x},${n.y}) ${geo}`)
    if (n.children?.length) out.push(...treeLines(n.children, depth + 1))
  }
  return out
}

function generateMarkdown(
  design: ExportDesignDoc,
  pages: (PageDesignDoc & { file: string })[],
  tokens: TokenCollector,
): string {
  const t = tokens.toJSON()
  const L: string[] = []
  L.push('# 设计稿导出（MasterGo → Claude Code）', '')
  L.push(`- 生成时间：${design.exportedAt}`)
  L.push(`- 文档：${design.document.name} · 页面：${design.document.page}`)
  L.push(`- 导出范围：${design.scope === 'selection' ? '当前选中图层' : '当前页面'}`)
  L.push(`- 页面（一级蒙版组）：${design.pages.length} · 画板数量：${design.pages.reduce((n, p) => n + p.frameCount, 0)} · 节点数量：${design.nodeCount}`)
  L.push(`- 图片素材：${design.assets?.length ?? 0} 张`, '')

  L.push('## 使用方式', '')
  L.push(
    '把本文件、design.json、pages/、frames/ 与 assets/ 一起放入项目目录，然后告诉 Claude Code：',
    '',
    '> 请读取 design.json 与 pages/ 目录下的页面 JSON（一级蒙版组，每个文件对应一个页面），结合 frames/svg/ 下的 SVG 预览与 frames/png/ 下各倍率的 PNG 预览，理解设计内容后，用所选技术栈还原这个 UI 设计。',
    '',
  )

  L.push('## 设计 Token 汇总', '')
  L.push('### 颜色', '')
  if (t.colors.length) {
    L.push('| Hex | 使用次数 | 示例图层 |')
    L.push('| --- | --- | --- |')
    for (const c of t.colors) L.push(`| ${c.hex} | ${c.usageCount} | ${c.sampleNames.slice(0, 3).join('、')} |`)
  } else L.push('（无纯色填充）')
  L.push('', '### 字体', '')
  if (t.fonts.length) {
    L.push('| 字体 | 字重 | 字号 | 使用次数 |')
    L.push('| --- | --- | --- | --- |')
    for (const f of t.fonts) L.push(`| ${f.family} | ${f.style} | ${f.fontSize} | ${f.usageCount} |`)
  } else L.push('（无文本）')
  L.push('', '### 间距 / 圆角 / 阴影', '')
  L.push(`- 间距：${t.spacings.map((s) => `${s.value}px×${s.usageCount}`).join('、') || '无'}`)
  L.push(`- 圆角：${t.radii.map((r) => `${r.value}px×${r.usageCount}`).join('、') || '无'}`)
  L.push(`- 阴影：${t.shadows.map((s) => `${s.hex} blur=${s.blur} offset=(${s.offsetX},${s.offsetY}) ×${s.usageCount}`).join('；') || '无'}`)
  L.push('')

  L.push('## 页面（一级蒙版组）', '')
  for (const page of pages) {
    L.push(`### ${page.name}（${page.frames.length} 个画板 · ${page.file}）`, '')
    for (const f of page.frames) {
      L.push(`#### ${f.name}（${f.width}×${f.height}）`, '')
      L.push(`- SVG 预览：${f.svgFile}`)
      if (f.previewPngFile) L.push(`- PNG 预览：${f.previewPngFile}`)
      L.push('```text', ...treeLines(f.children, 0), '```', '')
    }
  }
  return L.join('\n')
}

// ============================================================
// 画板真实渲染（exportAsync，公共 API）
// ============================================================

interface ExportableNode {
  exportAsync(settings?: ExportSettings): Promise<Uint8Array | string>
}

/**
 * 为单个画板节点生成预览：
 *  - SVG：优先 exportAsync({format:'SVG'}) 的真实矢量，失败/返回空串时回退近似 SVG（svgApprox=true）
 *  - PNG：exportAsync({format:'PNG'})，0.5 倍缩放，超出 MAX_PNG 跳过；0.5× 失败时用 1× 重试一次
 *        （蒙版等特殊节点在小倍率导出偶发失败，而更高倍率可正常导出）
 * token 用于宿主调用挂起时也能响应取消（轮询 isCancelled）。
 */
async function exportFramePreview(
  root: SceneNode,
  node: DesignNode,
  index: number,
  token: number,
): Promise<{ svg: string; pngBase64: string | null; svgApprox: boolean }> {
  const exportable = root as unknown as ExportableNode
  const cancelCheck = () => exportCancelled(token)
  const exportPng = (scale: number): Promise<string | null> =>
    withTimeout(
      exportable.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } }),
      FRAME_EXPORT_TIMEOUT,
      `PNG ${scale}× 导出`,
      cancelCheck,
    )
      .then((p): string | null => (p instanceof Uint8Array ? bytesToBase64(p) : null))
      .catch((err) => {
        if (err instanceof ExportCancelledError) throw err
        console.warn(`PNG ${scale}× 预览导出失败：`, root.id, err)
        return null
      })
  // SVG 与 PNG 预览互不依赖，同时发起，减少每个画板的等待时间；宿主调用均带超时 + 取消兜底
  const [svgRaw, png] = await Promise.all([
    withTimeout(exportable.exportAsync({ format: 'SVG' }), FRAME_EXPORT_TIMEOUT, 'SVG 导出', cancelCheck)
      .then((s): string | null => {
        const v = typeof s === 'string' ? s.trim() : ''
        if (!v) {
          if (typeof s === 'string') console.warn('SVG 导出返回空串，改用近似预览：', root.id)
          return null
        }
        return v
      })
      .catch((err) => {
        if (err instanceof ExportCancelledError) throw err
        console.warn('SVG 导出失败，改用近似预览：', root.id, err)
        return null
      }),
    index < MAX_PNG
      ? exportPng(0.5).then((p) => (p === null ? exportPng(1) : p)) // 0.5× 失败时用 1× 重试
      : Promise.resolve(null),
  ])
  const svg = svgRaw ?? generateFrameSvg(node)
  return { svg, pngBase64: png, svgApprox: svgRaw === null }
}

// ============================================================
// 入口
// ============================================================

type ExportScope = 'selection' | 'page' | 'subset'

function getRoots(scope: ExportScope): SceneNode[] {
  if (scope === 'page') {
    return mg.document.currentPage.children as unknown as SceneNode[]
  }
  if (scope === 'selection') {
    return [...mg.document.currentPage.selection]
  }
  return [] // subset 由 runExport 从 lastRoots 按序号映射，不走这里
}

// 最近一次导出的根节点，供「下载时按需重导出高清 PNG」与「导出勾选画板」使用
let lastRoots: SceneNode[] = []

/** 倍率上限（与 UI 侧一致），过大倍率会导致 exportAsync 失败，统一钳制 */
const MAX_SCALE = 16
function clampScale(s: number): number {
  return Number.isFinite(s) ? Math.max(0.1, Math.min(MAX_SCALE, s)) : 1
}

/** 按指定范围执行一次导出（异步、可中断），结果/进度/错误通过消息发送给 UI。
 * token 在调用时立即递增（即使实际工作仍在排队，也会先使在途导出失效）；实际工作经 opQueue
 * 串行化，且开始前先 drain 上一导出遗留的宿主调用，避免同一批节点上的导出任务叠加。 */
function runExport(scope: ExportScope, indices: number[] = []): void {
  const token = ++exportSeq // 新导出会使在途导出失效（即中断旧的）
  sendMsgToUI({ type: PluginMessage.EXPORTING, data: { token } })
  void enqueueOp(async () => {
    try {
      // 取消上一导出后，其宿主调用（exportAsync / getBytesAsync）无法中止、仍在后台运行：
      // 先等它们收尾（≤3s），再向同一批节点发起新的调用，防止渲染/下载任务叠加导致内存耗尽或宿主内部错误
      await drainInflightHost(3000)
      // subset：按 1-based 序号从上次成功导出的画板根节点中取子集（空/越界序号会被过滤掉）
      const roots =
        scope === 'subset'
          ? indices.map((i) => lastRoots[i - 1]).filter(Boolean)
          : getRoots(scope)
      const report = (percent: number, label: string) => {
        sendMsgToUI({ type: PluginMessage.EXPORT_PROGRESS, data: { token, percent, label } })
      }
      // 增量交付：每画板完成后立即发送（卡片边导边出）；最终的 EXPORT_RESULT 不再重复携带 frames
      const onFrame = (frame: FrameExport) => {
        sendMsgToUI({ type: PluginMessage.EXPORT_FRAME_READY, data: { token, frame } })
      }
      const { payload, frameRoots } = await exportDesign(scope, roots, token, report, onFrame)
      // 成功后再更新，供「下载时按需重导出高清 PNG」使用；失败/取消时保留上次成功结果
      lastRoots = frameRoots
      const resultData: Record<string, unknown> = { ...payload }
      delete resultData.frames
      sendMsgToUI({ type: PluginMessage.EXPORT_RESULT, data: { token, ...resultData } })
      mg.notify('导出完成，请在插件面板中下载文件', { type: 'success' })
    } catch (err) {
      if (err instanceof ExportCancelledError) {
        sendMsgToUI({ type: PluginMessage.EXPORT_CANCELLED, data: { token } })
        mg.notify('导出已取消')
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      console.error('[MasterGoExportToJSON]', err)
      sendMsgToUI({ type: PluginMessage.EXPORT_ERROR, data: { token, message } })
      mg.notify(message, { type: 'error' })
    }
  })
}

/** 按需重导出单个画板的高清 PNG（index 从 1 开始），发给 UI 下载 */
function exportFramePng(index1: number, scale: number): void {
  void enqueueOp(async () => {
    try {
      // 与导出共用串行队列 + 遗留宿主调用收尾：下载也是一次宿主渲染，避免与在途任务叠加
      await drainInflightHost(3000)
      const root = lastRoots[index1 - 1]
      if (!root) throw new Error('未找到对应画板，请先导出后再下载')
      const bytes = await withTimeout(
        (root as unknown as ExportableNode).exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: clampScale(scale) },
        }),
        FRAME_EXPORT_TIMEOUT,
        'PNG 导出',
      )
      if (!(bytes instanceof Uint8Array)) throw new Error('导出结果不是 PNG 数据')
      sendMsgToUI({
        type: PluginMessage.FRAME_PNG_READY,
        data: { index: index1, pngBase64: bytesToBase64(bytes) },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[MasterGoExportToJSON] 单画板 PNG 导出失败', err)
      sendMsgToUI({ type: PluginMessage.PNG_ERROR, data: { message } })
    }
  })
}

/** 按需重导出全部画板的高清 PNG（按所选倍率，每个倍率一条 ALL_PNG_READY 消息），供 ZIP 打包使用 */
function exportAllPng(scales: number[]): void {
  void enqueueOp(async () => {
    try {
      await drainInflightHost(3000) // 同上：不与在途宿主渲染叠加
      const list = (scales.length > 0 ? scales : [1]).map(clampScale)
      const total = lastRoots.length * list.length
      let done = 0
      for (const scale of list) {
        const frames: { index: number; pngBase64: string }[] = []
        for (const [i, root] of lastRoots.entries()) {
          try {
            const bytes = await withTimeout(
              (root as unknown as ExportableNode).exportAsync({
                format: 'PNG',
                constraint: { type: 'SCALE', value: scale },
              }),
              FRAME_EXPORT_TIMEOUT,
              'PNG 导出',
            )
            if (bytes instanceof Uint8Array) {
              frames.push({ index: i + 1, pngBase64: bytesToBase64(bytes) })
            }
          } catch (e) {
            console.warn('高清 PNG 导出失败（跳过）：', root.id, e)
          }
          // 逐画板上报打包进度，大导出时 UI 不再干等
          done++
          sendMsgToUI({
            type: PluginMessage.ZIP_PROGRESS,
            data: { done, total, label: `导出高清图 ${done}/${total}` },
          })
        }
        sendMsgToUI({ type: PluginMessage.ALL_PNG_READY, data: { scale, frames } })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[MasterGoExportToJSON] 批量 PNG 导出失败', err)
      sendMsgToUI({ type: PluginMessage.PNG_ERROR, data: { message } })
    }
  })
}

async function main(): Promise<void> {
  mg.showUI(__html__, { width: WINDOW_DEFAULT.width, height: WINDOW_DEFAULT.height })

  // 打开时恢复上次调整过的窗口尺寸（clientStorage 读不到则保持默认，静默失败）
  if (mg.clientStorage) {
    void mg.clientStorage
      .getAsync(STORAGE_WINDOW_SIZE)
      .then((stored) => {
        const s = stored as { width?: number; height?: number } | null
        if (s && typeof s.width === 'number' && typeof s.height === 'number') {
          const c = clampWindowSize(s.width, s.height)
          mg.ui.resize(c.width, c.height)
        }
      })
      .catch(() => {
        // 存储不可用：保持默认尺寸
      })
  }

  // 常驻消息监听：READY 仅作为握手；打开面板不自动导出，停留在初始引导态，
  // 由用户点「导出选中 / 导出所有」/「导出勾选画板」后再开始（避免打开面板即触发一次重导出）
  mg.ui.onmessage = (pluginMessage: unknown, _origin: string) => {
    const m = pluginMessage as { type?: string; data?: unknown } | null
    if (!m || typeof m.type !== 'string') return
    if (m.type === UIMessage.READY) {
      // 面板打开后显示引导态，等待用户发起导出
    } else if (m.type === UIMessage.RESIZE_WINDOW) {
      // 拖动右下角手柄调整窗口尺寸：clamp 后 resize 并记住（宿主无手动拖动放大能力）
      const d = m.data as { width?: number; height?: number } | null
      if (typeof d?.width === 'number' && typeof d?.height === 'number') {
        const c = clampWindowSize(d.width, d.height)
        mg.ui.resize(c.width, c.height)
        if (mg.clientStorage) void mg.clientStorage.setAsync(STORAGE_WINDOW_SIZE, c).catch(() => {})
      }
    } else if (m.type === UIMessage.EXPORT_SELECTION) {
      void runExport('selection')
    } else if (m.type === UIMessage.EXPORT_PAGE) {
      void runExport('page')
    } else if (m.type === UIMessage.EXPORT_FRAME_SUBSET) {
      // 导出勾选画板：UI 传 1-based 画板序号，映射到上次成功导出的画板根节点
      const d = m.data as { indices?: number[] } | null
      const indices = Array.isArray(d?.indices)
        ? d.indices.filter((i) => Number.isInteger(i) && i >= 1).sort((a, b) => a - b)
        : []
      void runExport('subset', indices)
    } else if (m.type === UIMessage.EXPORT_FRAME_PNG) {
      const d = m.data as { index?: number; scale?: number } | null
      void exportFramePng(d?.index ?? 0, d?.scale ?? 1)
    } else if (m.type === UIMessage.EXPORT_ALL_PNG) {
      const d = m.data as { scales?: number[] } | null
      const scales = Array.isArray(d?.scales) && d.scales.length > 0 ? d.scales : [1]
      void exportAllPng(scales)
    } else if (m.type === UIMessage.EXPORT_CANCEL) {
      exportSeq++ // 使在途导出失效，导出循环在下一个检查点抛 ExportCancelledError
    } else if (m.type === UIMessage.RELOAD_PLUGIN) {
      // 开发版「重新加载插件」：主线程无法自我重启（沙箱无 location/eval/宿主重载 API），
      // 只能取消在途导出、关闭插件，再提示开发者重新运行「打开插件」（或 Cmd+Option+P），
      // 宿主每次运行都会从磁盘重读 dist/main.js 与 dist/index.html，从而加载最新代码。
      exportSeq++ // 使在途导出失效，避免关闭前残留异步任务
      mg.notify('插件已关闭，请重新运行「打开插件」（或 Cmd+Option+P）以加载最新代码')
      mg.closePlugin()
    }
  }
}

main()

async function exportDesign(
  scope: ExportScope,
  roots: SceneNode[],
  token: number,
  report: (percent: number, label: string) => void,
  onFrame?: (frame: FrameExport) => void,
): Promise<{ payload: ExportResultPayload; frameRoots: SceneNode[] }> {
  if (roots.length === 0) {
    throw new Error(
      scope === 'selection'
        ? '未选中任何图层，请先选中要导出的画板/图层。'
        : scope === 'subset'
          ? '未勾选画板，请先在列表中选择要导出的画板。'
          : '当前页面为空。',
    )
  }

  // 1. 提取图片素材（进度 0–30%，逐张可中断）
  const { assets, fileByRef } = await extractAssets(roots, token, report)

  // 2. 按一级蒙版组拆分为页面，逐画板序列化 + 收集 Token + 生成预览（进度 30–100%）
  const tokens = new TokenCollector()
  const ctx: SerializeCtx = { fileByRef, tokens, token, nodeCount: 0 }
  // 帧内子进度：序列化大画板时按真实节点数上报，进度条与「序列化画板 n/X」标签落在同一区间
  ctx.reportFrame = () => {
    const done = Math.min(ctx.nodeCount - (ctx.frameNodeStart ?? 0), ctx.frameNodeCount ?? 1)
    const total = ctx.frameNodeCount || 1
    report(
      Math.round((ctx.frameBase ?? 0) + (ctx.frameSpan ?? 0) * (done / total)),
      `序列化画板 ${ctx.frameNo}/${ctx.totalFrames}「${ctx.frameName}」（${done}/${total} 节点）`,
    )
  }
  const pages = buildPages(roots)
  const totalFrames = pages.reduce((n, p) => n + p.frameRoots.length, 0)

  const frames: FrameExport[] = [] // 全部画板的预览，供 UI 卡片与 ZIP 使用
  const frameRoots: SceneNode[] = [] // 与 frames 按序对应，供高清 PNG 重导出
  const pageDocs: PageDesignDoc[] = [] // 每个页面的文档对象（含画板明细，供 markdown 使用）
  const pageFiles: { name: string; file: string; json: string; frameCount: number }[] = [] // 写入 ZIP 的页面 JSON
  let frameNo = 0
  for (const page of pages) {
    const pageFrames: DesignFrame[] = []
    for (const froot of page.frameRoots) {
      checkCancel(token)
      frameNo++
      const fname = (froot as unknown as { name?: string })?.name ?? `画板 ${frameNo}`
      const base = 30 + (70 * (frameNo - 1)) / totalFrames
      const span = 70 / totalFrames
      // 帧内分步上报 + 序列化中可取消：单个大画板耗时再长，进度条也会持续前进、取消随时生效
      report(Math.round(base), `序列化画板 ${frameNo}/${totalFrames}「${fname}」`)
      checkCancel(token)
      // 设置本帧的区间信息：序列化期间 serializeNode 按真实节点数在 [base, base+span] 内上报
      ctx.frameNo = frameNo
      ctx.totalFrames = totalFrames
      ctx.frameName = fname
      ctx.frameBase = base
      ctx.frameSpan = span
      ctx.frameNodeCount = countRawNodes(froot)
      ctx.frameNodeStart = ctx.nodeCount
      const node = await serializeNode(froot, ctx)
      checkCancel(token)
      report(Math.round(base + span), `渲染预览 ${frameNo}/${totalFrames}「${fname}」`)
      const { svg, pngBase64, svgApprox } = await exportFramePreview(froot, node, frameNo - 1, token)
      checkCancel(token)
      const safe = safeFileName(node.name)
      const idx = String(frameNo).padStart(2, '0')
      const stem = `${idx}_${safe}`
      // frames 按 svg / png 两大类分目录；png 下每个画板一个子文件夹，同一画板的不同倍率 PNG 都放里面
      const svgFileName = `frames/svg/${stem}.svg`
      const pngFileName = pngBase64 ? `frames/png/${stem}/${stem}.png` : ''
      frames.push({
        index: frameNo,
        name: node.name,
        dimensions: `${node.width}×${node.height}`,
        svgFileName,
        pngFileName,
        svg,
        pngBase64,
        svgApprox,
      })
      // 增量交付：单个画板导出完成立即发给 UI，卡片边导出边出现，不用等全部完成
      onFrame?.(frames[frames.length - 1]!)
      const df: DesignFrame = {
        ...node,
        svgFile: svgFileName,
        previewPngFile: pngBase64 ? pngFileName : undefined,
      }
      pageFrames.push(df)
      frameRoots.push(froot)
      report(Math.round(base + 70 / totalFrames), `画板 ${frameNo}/${totalFrames}「${fname}」完成`)
    }
    const pageDoc: PageDesignDoc = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      name: page.name,
      nodeCount: countNodes(pageFrames),
      frames: pageFrames,
    }
    compactJson(pageDoc as unknown as Record<string, unknown>)
    pageDocs.push(pageDoc)
    pageFiles.push({
      name: page.name,
      file: page.file,
      json: JSON.stringify(pageDoc),
      frameCount: pageFrames.length,
    })
  }

  const nodeCount = pageDocs.reduce((n, p) => n + p.nodeCount, 0)

  // 3. 汇总索引 design.json（页面清单 + 全局 Token + 素材清单，不含各页画板明细）
  const design: ExportDesignDoc = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    scope: scope === 'subset' ? 'page' : scope,
    document: { name: mg.document.name, page: mg.document.currentPage.name },
    nodeCount,
    designTokens: tokens.toJSON(),
    assets: assets.map((a) => ({ id: a.id, file: a.file, mime: a.mime })),
    pages: pageFiles.map((f) => ({ name: f.name, file: f.file, frameCount: f.frameCount })),
  }
  // 省略空值/默认值字段，进一步压缩 design.json（就地修改）
  compactJson(design as unknown as Record<string, unknown>)
  const markdown = generateMarkdown(
    design,
    pageDocs.map((p, i) => ({ ...p, file: pageFiles[i]?.file ?? '' })),
    tokens,
  )

  const payload: ExportResultPayload = {
    design,
    pages: pageFiles.map((f) => ({ name: f.name, file: f.file, json: f.json })),
    markdown,
    frames,
    assets: assets.map((a) => ({
      id: a.id,
      fileName: a.file,
      mime: a.mime,
      data: bytesToBase64(a.bytes),
    })),
    stats: { frameCount: totalFrames, nodeCount, imageCount: assets.length },
  }
  return { payload, frameRoots }
}
