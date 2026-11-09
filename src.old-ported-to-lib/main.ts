// ============================================================
// MasterGo → Claude Code 设计稿导出插件 · 主线程（沙箱）
//
// 职责：
//  1. 遍历选中/页面的节点树，序列化为语义化 design 数据结构
//  2. 自动汇总设计 Token（颜色 / 字体 / 间距 / 圆角 / 阴影）
//  3. 提取图片填充的真实字节（getImageByHref → getBytesAsync）
//  4. 为每个画板生成近似 SVG 预览 + Markdown 说明文档
//  5. 全部发送给插件 UI（iframe）打包下载
// ============================================================

const FORMAT = 'MasterGoExportToJSON'
const FORMAT_VERSION = 1
const MAX_IMAGES = 200 // 防止文件过大，最多提取的图片素材数量

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

type DesignFrame = DesignNode & { previewSvg: string }

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

interface Asset {
  id: string
  ref: string
  file: string
  mime: string
  bytes: Uint8Array
}

interface ExportResult {
  type: 'export-result'
  design: {
    format: string
    formatVersion: number
    exportedAt: string
    scope: 'selection' | 'page'
    document: { name: string; page: string }
    designTokens: {
      colors: ColorToken[]
      fonts: FontToken[]
      spacings: CountToken[]
      radii: CountToken[]
      shadows: ShadowToken[]
    }
    assets: { id: string; file: string; mime: string }[]
    frames: DesignFrame[]
  }
  markdown: string
  assets: Asset[]
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
      if (nodeName && !tok.sampleNames.includes(nodeName)) {
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
}

function serializePaints(
  paints: ReadonlyArray<Paint> | undefined,
  ctx: SerializeCtx,
  nodeName: string,
): SerializedPaint[] {
  if (!paints) return []
  const out: SerializedPaint[] = []
  for (const p of paints) {
    const base: SerializedPaint = {
      type: p.type,
      opacity: p.type === 'SOLID' ? round(p.color.a, 3) : round(p.alpha ?? 1, 3),
      visible: p.isVisible !== false,
      blendMode: p.blendMode,
    }
    if (p.type === 'SOLID') {
      base.hex = rgbaToHexA(p.color)
      base.rgba = {
        r: round(p.color.r, 3),
        g: round(p.color.g, 3),
        b: round(p.color.b, 3),
        a: round(p.color.a, 3),
      }
      ctx.tokens.addColor(base.hex, nodeName)
    } else if (p.type.startsWith('GRADIENT_')) {
      base.gradientStops = p.gradientStops.map((s) => ({
        position: round(s.position, 3),
        hex: rgbaToHexA(s.color),
        opacity: round(s.color.a, 3),
      }))
    } else if (p.type === 'IMAGE') {
      base.imageRef = p.imageRef
      base.scaleMode = p.scaleMode
      const asset = ctx.fileByRef.get(p.imageRef)
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
  for (const e of effects) {
    const base: SerializedEffect = {
      type: e.type,
      visible: e.isVisible !== false,
      blendMode: e.blendMode,
    }
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      base.hex = rgbaToHexA(e.color)
      base.rgba = {
        r: round(e.color.r, 3),
        g: round(e.color.g, 3),
        b: round(e.color.b, 3),
        a: round(e.color.a, 3),
      }
      base.offset = { x: round(e.offset.x), y: round(e.offset.y) }
      base.radius = round(e.radius)
      base.spread = round(e.spread)
    } else {
      base.radius = round(e.radius)
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

function serializeNode(node: SceneNode, ctx: SerializeCtx): DesignNode {
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

  // ---- 子节点
  let children: DesignNode[] = []
  if (NODE_TYPES_WITH_CHILDREN.has(type) && Array.isArray(n.children)) {
    children = (n.children as ReadonlyArray<SceneNode>).map((c) => serializeNode(c, ctx))
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

// ============================================================
// 图片素材提取
// ============================================================

function collectImageRefs(
  nodes: ReadonlyArray<SceneNode>,
  refs: Set<string>,
): void {
  for (const raw of nodes) {
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
      collectImageRefs(node.children as ReadonlyArray<SceneNode>, refs)
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

async function extractAssets(roots: ReadonlyArray<SceneNode>): Promise<{
  assets: Asset[]
  fileByRef: Map<string, { id: string; file: string }>
}> {
  const refs = new Set<string>()
  collectImageRefs(roots, refs)
  const assets: Asset[] = []
  const fileByRef = new Map<string, { id: string; file: string }>()
  let i = 0
  for (const ref of refs) {
    if (i >= MAX_IMAGES) break
    try {
      const bytes = await mg.getImageByHref(ref).getBytesAsync()
      const mime = sniffMime(bytes)
      const id = `image_${i + 1}`
      const file = `assets/img_${i + 1}.${EXT_BY_MIME[mime] ?? 'png'}`
      assets.push({ id, ref, file, mime, bytes })
      fileByRef.set(ref, { id, file })
      i++
    } catch (err) {
      console.warn('图片提取失败（已跳过）：', ref, err)
    }
  }
  return { assets, fileByRef }
}

// ============================================================
// SVG 近似预览生成（主线程字符串拼装，无需 DOM）
// ============================================================

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 粗略估算字符串渲染宽度（CJK ≈ 1em，其它 ≈ 0.55em） */
function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60)
    w += isWide ? fontSize : fontSize * 0.55
  }
  return w
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

function firstSolid(fills: SerializedPaint[]): SerializedPaint | null {
  return fills.find((f) => f.visible && f.type === 'SOLID' && f.hex) ?? null
}

function firstGradient(fills: SerializedPaint[]): SerializedPaint | null {
  return fills.find((f) => f.visible && f.type.startsWith('GRADIENT_')) ?? null
}

function hasImage(fills: SerializedPaint[]): boolean {
  return fills.some((f) => f.visible && f.type === 'IMAGE')
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
  const opacity = node.opacity < 1 ? ` opacity="${round(node.opacity, 2)}"` : ''
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
  const textW = Math.max(...lines.map((l) => estimateTextWidth(l, fontSize)))
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
  void textW
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
  const opacity = node.visible ? '' : ' visibility="hidden"'

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
          `<rect x="${round(x)}" y="${round(y)}" width="${round(node.width)}" height="${round(node.height)}" fill="${solid.hex}"${opacity}/>`,
        )
      }
    }
  }

  for (const child of node.children) {
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

function treeLines(nodes: DesignNode[], depth: number): string[] {
  const out: string[] = []
  for (const n of nodes) {
    const indent = '  '.repeat(depth)
    const geo =
      n.type === 'TEXT'
        ? `${n.width}×${n.height} "${(n.text?.characters ?? '').slice(0, 20)}"`
        : `${n.width}×${n.height}`
    out.push(`${indent}- ${n.type}「${n.name}」 (${n.x},${n.y}) ${geo}`)
    if (n.children.length) out.push(...treeLines(n.children, depth + 1))
  }
  return out
}

function generateMarkdown(
  design: ExportResult['design'],
  tokens: TokenCollector,
): string {
  const t = tokens.toJSON()
  const L: string[] = []
  L.push('# 设计稿导出（MasterGo → Claude Code）', '')
  L.push(`- 生成时间：${design.exportedAt}`)
  L.push(`- 文档：${design.document.name} · 页面：${design.document.page}`)
  L.push(`- 导出范围：${design.scope === 'selection' ? '当前选中图层' : '当前页面'}`)
  L.push(`- 画板数量：${design.frames.length}`, '')

  L.push('## 使用方式', '')
  L.push(
    '把本文件、design.json、assets/ 与 frames/ 一起放入项目目录，然后告诉 Claude Code：',
    '',
    '> 请读取 design.json（及 frames/ 下的 SVG 预览图），理解设计内容后，用所选技术栈还原这个 UI 设计。',
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

  L.push('## 画板', '')
  for (const f of design.frames) {
    L.push(`### ${f.name}（${f.width}×${f.height}）`, '')
    L.push('```text', ...treeLines(f.children, 0), '```', '')
  }
  return L.join('\n')
}

// ============================================================
// 入口
// ============================================================

function getRoots(scope: 'selection' | 'page'): SceneNode[] {
  const page = mg.document.currentPage
  if (scope === 'page') {
    return page.children as unknown as SceneNode[]
  }
  return [...page.selection]
}

function waitForUiReady(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const prev = mg.ui.onmessage
    mg.ui.onmessage = (msg: unknown) => {
      const m = msg as { type?: string } | null
      if (m && m.type === 'ready') finish()
      else if (prev) prev(msg)
    }
    const timer = setTimeout(finish, timeoutMs)
  })
}

async function exportDesign(scope: 'selection' | 'page'): Promise<ExportResult> {
  const roots = getRoots(scope)
  if (roots.length === 0) {
    throw new Error(
      scope === 'selection'
        ? '未选中任何图层，请先选中要导出的画板/图层。'
        : '当前页面为空。',
    )
  }

  // 1. 提取图片素材
  const { assets, fileByRef } = await extractAssets(roots)

  // 2. 序列化 + 收集 Token + 生成预览
  const tokens = new TokenCollector()
  const ctx: SerializeCtx = { fileByRef, tokens }
  const frames: DesignFrame[] = roots.map((root) => {
    const node = serializeNode(root, ctx)
    return { ...node, previewSvg: generateFrameSvg(node) }
  })

  const design: ExportResult['design'] = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    scope,
    document: { name: mg.document.name, page: mg.document.currentPage.name },
    designTokens: tokens.toJSON(),
    assets: assets.map((a) => ({ id: a.id, file: a.file, mime: a.mime })),
    frames,
  }
  const markdown = generateMarkdown(design, tokens)

  return { type: 'export-result', design, markdown, assets }
}

async function main(): Promise<void> {
  const scope: 'selection' | 'page' = mg.command === 'export-page' ? 'page' : 'selection'
  mg.showUI(__html__, { width: 520, height: 640 })
  try {
    await waitForUiReady()
    const result = await exportDesign(scope)
    mg.ui.postMessage(result)
    mg.notify('导出完成，请在插件面板中下载文件', { type: 'success' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[MasterGoExportToJSON]', err)
    mg.ui.postMessage({ type: 'export-error', message })
    mg.notify(message, { type: 'error' })
  }
}

main()
