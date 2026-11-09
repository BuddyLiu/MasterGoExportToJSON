<template>
  <div>
    <div v-if="view === 'main'" class="app">
      <header>
        <h1>设计稿导出（Claude Code）</h1>
        <p class="sub">把设计稿序列化为 Claude Code 可读的设计描述文件</p>
        <button class="help-link" @click="view = 'help'">帮助</button>
        <button class="reload-link" :disabled="status === 'exporting'" @click="reloadPlugin" title="关闭并重开插件以加载最新代码（开发用）">
          ↻ 重新加载插件
        </button>
      </header>

    <div class="re-export">
      <button :disabled="status === 'exporting'" @click="reExport('selection')">
        ↻ 导出选中
      </button>
      <button :disabled="status === 'exporting'" @click="reExport('page')">
        ↻ 导出所有
      </button>
    </div>

    <div v-if="status === 'idle' || status === 'exporting'" class="center">
      <div v-if="status === 'exporting'" class="spinner"></div>
      <template v-if="status === 'exporting'">
        <p>正在导出…（已完成的画板会逐个出现在下方）</p>
        <div class="progress-block">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: displayPercent + '%' }"></div>
          </div>
          <div class="progress-row">
            <span class="progress-pct">{{ Math.round(displayPercent) }}%</span>
            <span class="progress-label">{{ displayLabel }}</span>
            <button class="cancel-btn" :disabled="cancelling || completing" @click="cancelExport">
              {{ cancelling ? '正在取消…' : '取消导出' }}
            </button>
          </div>
        </div>
      </template>
      <div v-else class="idle-guide">
        <div v-if="notice" class="notice">{{ notice }}</div>
        <p class="idle-title">尚未导出设计稿</p>
        <p class="idle-hint">
          点击上方「导出选中」导出当前选中图层，或「导出所有」导出整个页面。<br>
          导出完成后会自动打包 <code>design-export.zip</code>，内含 design.json 索引、design.md 说明、
          各页画板明细（pages/*.json）、SVG/PNG 预览与图片素材，供 Claude Code 还原设计稿。
        </p>
      </div>
    </div>

    <div v-else-if="status === 'error'" class="error">
      <p>⚠️ 导出失败：{{ error }}</p>
    </div>

    <template v-if="status === 'done' && result">
      <section class="stats">
        <div class="stat"><b>{{ result.stats.frameCount }}</b><span>画板</span></div>
        <div class="stat"><b>{{ result.stats.nodeCount }}</b><span>节点</span></div>
        <div class="stat"><b>{{ result.stats.imageCount }}</b><span>图片素材</span></div>
      </section>

      <div v-if="notice" class="notice">{{ notice }}</div>

      <div class="export-scale">
        <span class="scale-label">导出倍率</span>
        <button
          v-for="s in ZIP_SCALE_PRESETS"
          :key="s"
          :class="{ active: selectedScales.includes(s) }"
          @click="toggleScale(s)"
        >{{ s }}×</button>
        <span
          v-for="s in customScales"
          :key="s"
          class="scale-chip"
          :class="{ active: selectedScales.includes(s) }"
        >
          <button class="chip-select" :title="`点击选中/取消 ${s}×`" @click="toggleCustomScale(s)">
            {{ s }}×
          </button>
          <button
            class="chip-del"
            :title="`删除自定义倍率 ${s}×`"
            @click.stop="removeCustomScale(s)"
          >×</button>
        </span>
        <button
          v-if="!showScaleInput"
          class="scale-add"
          title="添加自定义倍率"
          @click="openScaleInput"
        >＋</button>
        <input
          v-if="showScaleInput"
          v-model="customScaleInput"
          ref="scaleInputEl"
          class="scale-input"
          type="number"
          min="1"
          max="16"
          step="0.1"
          placeholder="输入倍率"
          @keydown.enter.prevent="addCustomScale"
          @keydown.esc.prevent="cancelScaleInput"
          @blur="addCustomScale"
        />
        <span class="scale-hint">预设点击选中/取消；点「＋」输入自定义倍率，回车后生成可选中/删除的标签，最大 16×</span>
      </div>

      <div class="compress-opt">
        <label class="compress-toggle">
          <input v-model="compress" type="checkbox" />
          <span>压缩图片</span>
        </label>
        <div v-if="compress" class="quality">
          <span class="quality-label">质量</span>
          <input
            v-model.number="compressQuality"
            class="quality-range"
            type="range"
            min="10"
            max="100"
            step="5"
          />
          <input
            v-model.number="compressQuality"
            class="quality-input"
            type="number"
            min="10"
            max="100"
            @change="clampQuality"
          />
          <span class="quality-unit">%</span>
          <p v-if="compressQuality < 60" class="quality-warn">
            ⚠ 质量过低会导致颜色断层 / 图片失真，建议 ≥ 60%
          </p>
        </div>
      </div>

      <div class="subset-actions">
        <button class="primary" :disabled="!selectedFrames.length" @click="exportSubset">
          导出勾选画板（{{ selectedFrames.length }}）
        </button>
        <button :disabled="allFramesSelected" @click="selectAllFrames">全选</button>
        <button :disabled="!selectedFrames.length" @click="clearFrameSelection">清空</button>
        <span class="subset-hint">勾选下方画板，可只导出选中的几个（按最近一次导出顺序编号）</span>
      </div>

      <div class="actions">
        <button class="primary" :disabled="zipping || allExporting" @click="downloadZip">
          {{ zipping ? '打包中…' : allExporting ? '导出高清图中…' : '⬇ 下载全部（ZIP）' }}
        </button>
        <button @click="openDocPreview('json')">预览 design.json</button>
        <button :disabled="copying" @click="copyDesignJson">
          {{ copying ? '已复制 ✓' : '复制 design.json' }}
        </button>
        <button @click="openDocPreview('md')">预览 design.md</button>
        <button @click="downloadMarkdown">下载 design.md</button>
      </div>

      <div v-if="zipping && zipProgress" class="zip-progress">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: (zipProgress?.percent ?? 0) + '%' }"></div>
        </div>
        <div class="progress-row">
          <span class="progress-pct">{{ zipProgress?.percent ?? 0 }}%</span>
          <span class="progress-label">{{ zipProgress?.label ?? '' }}</span>
        </div>
      </div>
    </template>

    <section v-if="result?.frames?.length" class="frames">
      <div
        v-for="f in result.frames"
        :key="f.index"
        class="frame-card"
        :class="{ sel: selectedFrames.includes(f.index) }"
      >
        <label
          class="frame-check"
          :title="selectedFrames.includes(f.index) ? '取消勾选' : '勾选后可在上方「导出勾选画板」单独导出'"
          @click.stop
        >
          <input
            type="checkbox"
            :checked="selectedFrames.includes(f.index)"
            @change="toggleFrameSelect(f.index)"
          />
        </label>
        <div
          class="frame-preview"
          :class="{ clickable: !!f.svg || !!f.pngBase64 }"
          :title="(!!f.svg || !!f.pngBase64) ? '点击查看大图' : ''"
          @click="openImagePreview(f)"
        >
          <img
            v-if="f.pngBase64"
            :src="`data:image/png;base64,${f.pngBase64}`"
            :alt="f.name"
          />
          <img
            v-else-if="f.svg && !thumbErrors.has(f.index)"
            :src="svgDataUrl(f)"
            :alt="f.name"
            class="thumb-svg"
            @error="markThumbError(f.index)"
          />
          <div v-else class="no-png">无预览</div>
        </div>
        <div class="frame-info">
          <b>{{ f.name }}</b>
          <span>{{ f.dimensions }}</span>
        </div>
      </div>
    </section>

      <footer class="hint">
        将 design.json、design.md、pages/、frames/、assets/ 放入项目目录后，告诉 Claude Code：
        “请读取 design.json 与 pages/ 下的页面 JSON，理解设计内容后还原这个 UI 设计。”
      </footer>
    </div>

    <div v-else class="app help-page">
      <header>
        <h1>使用帮助</h1>
        <p class="sub">设计稿导出（Claude Code）插件功能说明</p>
        <button class="help-link" @click="view = 'main'">← 返回</button>
      </header>

      <section class="help-section">
        <h2>这个插件做什么</h2>
        <p>
          把当前选中的图层或整页设计稿，序列化为 Claude Code 可以直接阅读的结构化文件
          （design.json / design.md / pages/*.json），并附带每个画板的 SVG / PNG 预览与图片素材，
          打包成 design-export.zip 供下载，让 Claude Code 依据设计稿还原 UI。
        </p>
      </section>

      <section class="help-section">
        <h2>导出流程</h2>
        <ol>
          <li>在画布上选中要导出的图层；需要整页导出时不用选中，点「导出所有」即可；</li>
          <li>点「导出选中」或「导出所有」，进度条实时显示，已完成的画板会逐个出现在下方，随时可「取消导出」；</li>
          <li>导出完成后，点击画板预览图可放大查看，并在大图预览中下载该画板的 SVG / PNG / JPG / WebP，或「下载全部（ZIP）」一次打包。</li>
        </ol>
      </section>

      <section class="help-section">
        <h2>导出倍率</h2>
        <p>
          控制下载位图的分辨率倍率（PNG / JPG / WebP）。预设 1× / 2× / 3× / 4× 可直接点击选中或取消；
          点「＋」会展开输入框（此时加号隐藏，回车或失焦后生成标签再加号恢复），可输入任意自定义倍率（最大 16×），
          自定义标签同样可选中、可删除。
          1× 引用图始终写入 ZIP，Claude Code 按 design.json 里的路径引用文件时不会断链。
        </p>
      </section>

      <section class="help-section">
        <h2>压缩图片</h2>
        <p>
          可选。开启后对下载的位图做量化重编码（PNG）或转 JPEG（不透明图），并自动取体积更小的结果，
          保证只减小体积、不会变大。质量低于 60% 时可能出现颜色断层，建议保持默认 80%。
        </p>
      </section>

      <section class="help-section">
        <h2>文件结构与 Claude Code 使用方式</h2>
        <p>ZIP 内包含：</p>
        <ul>
          <li><b>design.json</b> — 索引：全局设计 Token（颜色 / 字体 / 间距 / 圆角 / 阴影）与各页面清单；</li>
          <li><b>pages/*.json</b> — 每个一级蒙版组一页，内含该页所有画板的节点明细；</li>
          <li><b>design.md</b> — Markdown 概览，按页面分节展示画板与节点树；</li>
          <li><b>frames/svg、frames/png</b> — 各画板预览；</li>
          <li><b>assets/</b> — 图片素材。</li>
        </ul>
        <p>使用方式：下载 ZIP 解压后放入项目目录，告诉 Claude Code：</p>
        <pre class="help-quote">请读取 design.json 与 pages/ 下的页面 JSON，理解设计内容后还原这个 UI 设计。</pre>
      </section>

      <section class="help-section">
        <h2>查看预览</h2>
        <p>
          点击画板卡片上的预览图可打开大图：滚轮或 Ctrl+滚轮缩放，图片超出可视区域后单独滚轮上下滚动、
          Shift+滚轮横向滚动，双击放大 1.5 倍（Shift+双击缩小），按住拖动可平移。大图弹层内可直接下载该画板的
          SVG / PNG / JPG / WebP。
        </p>
      </section>

      <section class="help-section">
        <h2>常见问题</h2>
        <ul>
          <li><b>画板没有预览图？</b>预览图数量上限为 30 张（超出部分仅 SVG），但下载 PNG / JPG / WebP 时仍会按所选倍率实时重导出。</li>
          <li><b>高清图导出失败？</b>下载时按所选倍率在主线程重新导出，个别失败会跳过；ZIP 始终保留 1× 引用图。</li>
          <li><b>画板很多时导出慢？</b>进度条会持续前进，可随时「取消导出」；中断不影响已下载内容。</li>
        </ul>
      </section>
    </div>

    <!-- 画板大图预览弹层 -->
    <div v-if="imagePreview" class="modal-overlay">
      <div class="modal modal-image" @click.stop>
        <button class="modal-close" @click="closeImagePreview">×</button>
        <h3>{{ imagePreview.name }}</h3>
        <div
          ref="imageStageEl"
          class="image-stage"
          :class="{ dragging: imageDragging }"
          @wheel.prevent="onStageWheel"
          @mousedown.prevent="onStageMouseDown"
          @dblclick.prevent="onStageDblClick"
        >
          <img
            ref="imageEl"
            :src="imagePreview.src"
            :alt="imagePreview.name"
            :style="{ transform: viewTransform }"
            draggable="false"
            @load="onImageLoaded"
            @error="onImageError"
          />
        </div>
        <div class="modal-image-actions">
          <span class="zoom-pct">{{ zoomPct }}%</span>
          <button
            v-for="t in dlTypes"
            :key="t.key"
            class="frame-dl"
            :disabled="frameExporting !== null || status !== 'done'"
            :title="frameDlTitle(imagePreview.frame.index, t.key)"
            @click="downloadFrameImage(imagePreview.frame, t.key)"
          >
            {{ frameDlExporting(imagePreview.frame.index, t.key) ? '导出中…' : t.label }}
          </button>
        </div>
        <p class="modal-dim">
          {{ imagePreview.dimensions }} · 滚轮缩放/滚动 · Ctrl+滚轮缩放 · Shift+滚轮横向滚动 · 双击放大（Shift+双击缩小）· 拖动平移
        </p>
      </div>
    </div>

    <!-- design.json / design.md 预览弹层 -->
    <div v-if="docPreview" class="modal-overlay">
      <div class="modal modal-doc" @click.stop>
        <button class="modal-close" @click="closeDocPreview">×</button>
        <h3>{{ docPreview.title }}</h3>
        <div class="doc-actions">
          <button class="primary" :disabled="docCopying" @click="copyDocPreview">
            {{ docCopying ? '已复制 ✓' : '复制全部' }}
          </button>
          <button @click="downloadDocPreview">下载 {{ docPreview.title }}</button>
        </div>
        <pre class="doc-content" :class="docPreview.kind">{{ docPreview.content }}</pre>
      </div>
    </div>

    <!-- 窗口尺寸调节手柄：宿主窗口不支持手动拖动，由右下角手柄拖动调整（拖动时向主线程发 RESIZE_WINDOW） -->
    <div
      class="resize-handle"
      title="拖动右下角调整插件窗口大小（最小 420×400，最大 1400×1200，尺寸会被记住）"
      @mousedown.prevent="startResize"
    ></div>
  </div>
</template>

<script lang="ts" setup>
import { computed, nextTick, reactive, ref } from 'vue'
import JSZip from 'jszip'
import { PluginMessage, UIMessage, sendMsgToPlugin } from '@messages/sender'

interface FrameExport {
  index: number
  name: string
  dimensions: string
  svgFileName: string
  pngFileName: string
  svg: string
  pngBase64: string | null
  /** SVG 为主线程生成的近似图（真实矢量导出失败/返回空串时的兜底）；预览时优先用 PNG */
  svgApprox?: boolean
}
interface AssetPayload {
  id: string
  fileName: string
  mime: string
  data: string
}
/** design.json 索引（主线程已压缩），preview.html 生成器与 ZIP 写入复用其结构 */
interface DesignIndex {
  format?: string
  formatVersion?: number
  exportedAt?: string
  scope?: 'selection' | 'page'
  document?: { name?: string; page?: string }
  nodeCount?: number
  designTokens: {
    colors: { hex: string; usageCount: number; sampleNames?: string[] }[]
    fonts: { family: string; style: string; fontSize: number; usageCount: number }[]
    spacings: { value: number; usageCount: number }[]
    radii: { value: number; usageCount: number }[]
    shadows: { label: string; hex: string; blur: number; usageCount: number }[]
  }
  assets: { id: string; file: string; mime: string }[]
  pages?: { name: string; frameCount: number; file?: string }[]
}

interface ExportResultPayload {
  token?: number
  design: DesignIndex
  /** 各页面的 JSON 文件内容（一级蒙版组拆分，UI 直接写入 ZIP） */
  pages: { name: string; file: string; json: string }[]
  markdown: string
  frames: FrameExport[]
  assets: AssetPayload[]
  stats: { frameCount: number; nodeCount: number; imageCount: number }
}

const status = ref<'idle' | 'exporting' | 'done' | 'error'>('idle')
const error = ref('')
const result = ref<ExportResultPayload | null>(null)
/** 勾选要导出的画板（1-based 序号，对应 done 视图 result.frames[].index；新一轮导出会话开始时清空） */
const selectedFrames = ref<number[]>([])
const zipping = ref(false)
const copying = ref(false)
const notice = ref('')
const allExporting = ref(false)
/** 大图弹层内正在导出的下载任务：按（画板 index + 格式类型）定位，只有被点击的那个按钮显示「导出中…」 */
const frameExporting = ref<{ index: number; type: string } | null>(null)

/** 导出进度（主线程逐步上报） */
const progress = ref<{ percent: number; label: string } | null>(null)
/** ZIP 打包进度（高清重导出 + 压缩 + 写 ZIP 的细分步骤，逐项上报，大导出时不用干等） */
const zipProgress = ref<{ percent: number; label: string } | null>(null)
/** 当前导出的 token：-1 表示「正在等待新一轮导出的 EXPORTING」，旧消息一律忽略 */
const activeToken = ref(0)
const cancelling = ref(false)

/** 本轮导出开始时刻（毫秒时间戳）：用于保证进度条最短可见时长 */
const exportStartedAt = ref(0)
/** 进度条最短可见时长：再次导出时若因图片缓存/设计较小而秒完成，进度条不会一闪而过 */
const MIN_EXPORT_VISIBLE_MS = 400

// ---- 进度条平滑机制：遮住「主线程长同步段 / 消息批投递」造成的假死与 0→100 跳变 ----
/** 真实进度消息静默超过此时长后，进度条开始本地平滑前爬 */
const RAMP_GRACE_MS = 300
/** 本地平滑爬升封顶：100% 只由真实消息或完成动画给出 */
const RAMP_CEIL = 90
/** 平滑爬升/完成动画的 tick 间隔 */
const RAMP_TICK_MS = 100
/** 完成动画最短时长：快导出时从当前值平滑走到 100%，替代 0→100 跳变 */
const COMPLETE_MIN_MS = 800
/** 进度显示每 tick 最大跳变：真实消息大跨度到达（批投递）时摊平成平滑动画 */
const RAMP_MAX_JUMP = 25

/** 平滑动画定时器（setInterval） */
let rampTimer = 0
/** 最近一次真实进度消息到达时刻 */
let lastRealAt = 0
/** 上一次把真实进度应用到显示值的时刻（限速：≤RAMP_MAX_JUMP/拍，防止同步批投递一帧跳到 100） */
let lastAppliedAt = 0
/** 本地平滑爬升的 percent（动画值，与 progress 真实值分离，只进不退） */
const rampPercent = ref(0)
/** 正在播放「导出完成」动画（从当前显示值平滑推进到 100%） */
const completing = ref(false)
/** 完成动画待应用的 EXPORT_RESULT 与对应 token（防过期） */
let completePayload: ExportResultPayload | null = null
let completeToken = -1
/** 完成动画最迟收尾时刻 */
let completeDeadline = 0

/** 导出倍率（可多选，iOS 常用 2×/3×；1× = 设计稿原始尺寸） */
const ZIP_SCALE_PRESETS = [1, 2, 3, 4]
const MAX_SCALE = 16
const selectedScales = ref<number[]>([2, 3])
const customScaleInput = ref('')

/** 已添加的自定义倍率：渲染成标签，可选中、可删除 */
const customScales = ref<number[]>([])
/** 「＋」展开后是否显示自定义倍率输入框 */
const showScaleInput = ref(false)
const scaleInputEl = ref<HTMLInputElement | null>(null)

/** 界面视图：main = 主面板，help = 帮助页 */
const view = ref<'main' | 'help'>('main')

/** 卡片 SVG 缩略图加载失败的画板 index（回退显示「无预览」文案） */
const thumbErrors = reactive(new Set<number>())
function markThumbError(index: number): void {
  thumbErrors.add(index)
}

/** 点击画板预览图放大查看（优先矢量 SVG，无则回退 PNG 预览图） */
const imagePreview = ref<{ frame: FrameExport; name: string; dimensions: string; src: string } | null>(null)
/** design.json / design.md 内容预览弹层 */
const docPreview = ref<{ title: string; content: string; kind: 'json' | 'md' } | null>(null)
const docCopying = ref(false)

// ---- 预览大图：缩放 / 平移 / 拖动 ----
/** 最小缩放：缩到看不清前阻止继续缩小 */
const MIN_VIEW = 0.1
/** 最大缩放 */
const MAX_VIEW = 16
/** 滚轮每 100 delta 的缩放系数（|d| 越大缩放越快） */
const ZOOM_STEP = 1.12
/** 双击缩放固定倍数：双击放大 1.5×，Shift+双击缩小 1/1.5 */
const DBL_ZOOM = 1.5
const viewScale = ref(1)
const viewTx = ref(0)
const viewTy = ref(0)
const imageStageEl = ref<HTMLElement | null>(null)
const imageEl = ref<HTMLImageElement | null>(null)
const imageDragging = ref(false)
interface DragState {
  startX: number
  startY: number
  baseTx: number
  baseTy: number
}
let dragState: DragState | null = null

/** 下载类型按钮（从画板卡片移入预览弹层） */
const dlTypes = [
  { key: 'svg', label: 'SVG' },
  { key: 'png', label: 'PNG' },
  { key: 'jpeg', label: 'JPG' },
  { key: 'webp', label: 'WebP' },
] as const

/** 预览弹层尺寸：图片超过它即溢出（纵向滚动 / 横向 Shift+滚动） */
function stageSize(): { w: number; h: number } {
  return {
    w: imageStageEl.value?.clientWidth ?? 0,
    h: imageStageEl.value?.clientHeight ?? 0,
  }
}
function imageNaturalSize(): { w: number; h: number } {
  const img = imageEl.value
  if (!img) return { w: 0, h: 0 }
  // SVG data URL 的 naturalWidth 可能为 0，回退到解析出的显示尺寸
  return {
    w: img.naturalWidth || img.width || 0,
    h: img.naturalHeight || img.height || 0,
  }
}
function imageOverflows(): boolean {
  const st = stageSize()
  const n = imageNaturalSize()
  if (!st.w || !st.h || !n.w || !n.h) return false
  return n.w * viewScale.value > st.w || n.h * viewScale.value > st.h
}

/** 缩放后夹紧：图片未超出视口则居中；超出则把边缘挡回视口内（不露空白） */
function clampView(): void {
  const st = stageSize()
  const n = imageNaturalSize()
  if (!st.w || !st.h || !n.w || !n.h) return
  const iw = n.w * viewScale.value
  const ih = n.h * viewScale.value
  if (iw <= st.w) viewTx.value = (st.w - iw) / 2
  else viewTx.value = Math.min(0, Math.max(st.w - iw, viewTx.value))
  if (ih <= st.h) viewTy.value = (st.h - ih) / 2
  else viewTy.value = Math.min(0, Math.max(st.h - ih, viewTy.value))
}

/** 以视口内某点为中心缩放：t' = p - (p - t) * (s'/s) */
function zoomAt(cx: number, cy: number, factor: number): void {
  const next = Math.max(MIN_VIEW, Math.min(MAX_VIEW, viewScale.value * factor))
  const ratio = next / viewScale.value
  viewTx.value = cx - (cx - viewTx.value) * ratio
  viewTy.value = cy - (cy - viewTy.value) * ratio
  viewScale.value = next
  clampView()
}

/** 放大后超出可视区域：滚轮缩放；未超出：滚轮直接缩放。满足「滚轮缩放」与「单独滚轮上下滚动」两种诉求 */
function onStageWheel(e: WheelEvent): void {
  if (e.shiftKey) {
    // Shift+滚轮：横向滚动（图片超出视口时有效；未超出时 clampView 会保持居中）
    viewTx.value -= e.deltaY
    clampView()
    return
  }
  const st = stageSize()
  // 鼠标位置作为缩放中心
  const rect = imageStageEl.value?.getBoundingClientRect()
  const cx = rect ? e.clientX - rect.left : st.w / 2
  const cy = rect ? e.clientY - rect.top : st.h / 2
  if (e.ctrlKey || !imageOverflows()) {
    // Ctrl+滚轮 或 图片未超出视口：缩放
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * st.h : e.deltaY
    zoomAt(cx, cy, Math.pow(ZOOM_STEP, -d / 100))
  } else {
    // 单独滚轮：垂直滚动
    viewTy.value -= e.deltaY
    clampView()
  }
}

/** 双击缩放 1.5×（Shift+双击缩小），以双击点为缩放中心 */
function onStageDblClick(e: MouseEvent): void {
  const rect = imageStageEl.value?.getBoundingClientRect()
  const cx = rect ? e.clientX - rect.left : stageSize().w / 2
  const cy = rect ? e.clientY - rect.top : stageSize().h / 2
  zoomAt(cx, cy, e.shiftKey ? 1 / DBL_ZOOM : DBL_ZOOM)
}

/** 按下开始拖动（记录起点与基线位移） */
function onStageMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return
  dragState = { startX: e.clientX, startY: e.clientY, baseTx: viewTx.value, baseTy: viewTy.value }
  imageDragging.value = true
  window.addEventListener('mousemove', onWindowMouseMove)
  window.addEventListener('mouseup', onWindowMouseUp)
}
function onWindowMouseMove(e: MouseEvent): void {
  if (!dragState) return
  viewTx.value = dragState.baseTx + (e.clientX - dragState.startX)
  viewTy.value = dragState.baseTy + (e.clientY - dragState.startY)
  clampView()
}
function onWindowMouseUp(): void {
  dragState = null
  imageDragging.value = false
  window.removeEventListener('mousemove', onWindowMouseMove)
  window.removeEventListener('mouseup', onWindowMouseUp)
}

/** 图片变换：translate 在前、scale 在后（transform-origin 0 0） */
const viewTransform = computed(() => `translate(${viewTx.value}px, ${viewTy.value}px) scale(${viewScale.value})`)
/** 缩放百分比显示 */
const zoomPct = computed(() => Math.round(viewScale.value * 100))

/** JPEG / WebP 转码质量（0–1，足够高避免二次有损） */
const IMAGE_CONVERT_QUALITY = 0.92

/** 图片压缩：不需要超高清时用较低质量减小体积 */
const compress = ref(false)
const compressQuality = ref(80)

let noticeTimer = 0
function showNotice(text: string): void {
  notice.value = text
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = ''), 4000)
}

function toggleScale(s: number): void {
  const i = selectedScales.value.indexOf(s)
  if (i >= 0) {
    if (selectedScales.value.length > 1) selectedScales.value.splice(i, 1)
  } else {
    selectedScales.value.push(s)
    selectedScales.value.sort((a, b) => a - b)
  }
}

/** 「＋」点击：展开自定义倍率输入框并聚焦 */
function openScaleInput(): void {
  showScaleInput.value = true
  requestAnimationFrame(() => scaleInputEl.value?.focus())
}

/** Esc：取消本次自定义输入，收起输入框 */
function cancelScaleInput(): void {
  customScaleInput.value = ''
  showScaleInput.value = false
}

function addCustomScale(): void {
  // type="number" 的 v-model 会把输入 cast 成 number，先转回字符串再 trim，避免对数字调 .trim() 抛错
  const raw = String(customScaleInput.value ?? '').trim()
  customScaleInput.value = ''
  showScaleInput.value = false
  if (!raw) return // 空输入（如输入框失焦）静默忽略
  const v = Number(raw)
  if (!Number.isFinite(v) || v <= 0) {
    showNotice('请输入有效的倍率（如 1.5 或 6）')
    return
  }
  if (v > MAX_SCALE) {
    showNotice(`倍率过大，最大支持 ${MAX_SCALE}×`)
    return
  }
  // 与预设重复：直接选中预设即可，不生成自定义标签
  if (ZIP_SCALE_PRESETS.includes(v)) {
    toggleScale(v)
    return
  }
  if (!customScales.value.includes(v)) customScales.value.push(v)
  if (!selectedScales.value.includes(v)) {
    selectedScales.value.push(v)
    selectedScales.value.sort((a, b) => a - b)
  }
}

/** 删除自定义倍率标签：同时从自定义列表与选中列表中移除 */
function removeCustomScale(s: number): void {
  const i = customScales.value.indexOf(s)
  if (i >= 0) customScales.value.splice(i, 1)
  const j = selectedScales.value.indexOf(s)
  if (j >= 0) selectedScales.value.splice(j, 1)
}

/** 自定义标签点击：与预设按钮一致的选中/取消 */
function toggleCustomScale(s: number): void {
  const i = selectedScales.value.indexOf(s)
  if (i >= 0) {
    if (selectedScales.value.length > 1) selectedScales.value.splice(i, 1)
  } else {
    selectedScales.value.push(s)
    selectedScales.value.sort((a, b) => a - b)
  }
}

/** 质量输入框失焦/回车后钳制到 10–100 */
function clampQuality(): void {
  const q = Math.round(Number(compressQuality.value))
  compressQuality.value = Number.isFinite(q) ? Math.max(10, Math.min(100, q)) : 80
}

function scaleSuffix(scale: number): string {
  const s = Number(scale.toFixed(2)).toString()
  return s === '1' ? '' : `@${s}x`
}

/** 待响应请求：UI 发请求 → 主线程导出 → 一条或多条 READY 消息返回 */
interface PendingRequest {
  readyType: string
  remaining: number
  results: unknown[]
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  finish: () => void
  timer: number
}
let pending: PendingRequest | null = null

/** 请求并等待单条结果 */
function request<T = unknown>(
  sendType: string,
  readyType: string,
  data?: unknown,
): Promise<T> {
  return requestBatch<T>(sendType, readyType, 1, data).then((r) => r[0])
}

/** 请求并等待 count 条 READY 消息（如按多个倍率分批返回），按顺序汇总 */
function requestBatch<T = unknown>(
  sendType: string,
  readyType: string,
  count: number,
  data?: unknown,
): Promise<T[]> {
  if (pending) {
    window.clearTimeout(pending.timer)
    pending.reject(new Error('上一个请求尚未完成'))
    pending = null
  }
  return new Promise<T[]>((resolve, reject) => {
    const entry: PendingRequest = {
      readyType,
      remaining: count,
      results: [],
      resolve: (d) => entry.results.push(d),
      reject,
      finish: () => {
        if (pending === entry) pending = null
        resolve([...entry.results] as T[])
      },
      timer: window.setTimeout(() => {
        if (pending === entry) pending = null
        reject(new Error('导出超时，请重试'))
      }, 30000 * Math.max(1, count)),
    }
    pending = entry
    sendMsgToPlugin({ type: sendType as never, data })
  })
}

// 通知主线程：UI 已就绪，可以开始导出
sendMsgToPlugin({ type: UIMessage.READY })

window.onmessage = (event) => {
  const msg = event.data as { type?: string; data?: unknown } | null
  if (!msg) return
  if (msg.type === PluginMessage.EXPORTING) {
    const d = msg.data as { token?: number } | null
    activeToken.value = d?.token ?? activeToken.value
    beginExportSession()
  } else if (msg.type === PluginMessage.EXPORT_PROGRESS) {
    const d = msg.data as { token?: number; percent?: number; label?: string } | null
    if (d?.token !== activeToken.value) return // 过期导出（已取消/被新导出取代）
    progress.value = { percent: d?.percent ?? 0, label: d?.label ?? '' }
    lastRealAt = Date.now() // 真实消息刷新静默计时
    // 限速追进：正常慢导出时小步真实消息立即显示（不滞后）；
    // 大批消息同步到达（主线程长同步段后批投递）时每拍只应用 RAMP_MAX_JUMP，
    // 剩余的交给 ticker 继续以相同速率追，避免「0→100」一帧跳变
    const real = d?.percent ?? 0
    if (real > rampPercent.value && Date.now() - lastAppliedAt >= RAMP_TICK_MS) {
      rampPercent.value += Math.min(real - rampPercent.value, RAMP_MAX_JUMP)
      lastAppliedAt = Date.now()
    }
  } else if (msg.type === PluginMessage.EXPORT_FRAME_READY) {
    // 增量交付：单个画板完成，边导边渲染卡片，不用等全部完成
    const d = msg.data as { token?: number; frame?: FrameExport } | null
    if (!d?.frame || d.token !== activeToken.value) return
    result.value = {
      ...(result.value ?? ({} as Omit<ExportResultPayload, 'frames'>)),
      frames: [...(result.value?.frames ?? []), d.frame],
    } as ExportResultPayload
  } else if (msg.type === PluginMessage.EXPORT_RESULT) {
    const d = msg.data as ExportResultPayload
    if (d.token !== undefined && d.token !== activeToken.value) return
    finishExport(d)
  } else if (msg.type === PluginMessage.EXPORT_CANCELLED) {
    const d = msg.data as { token?: number } | null
    if (d?.token !== activeToken.value) return
    stopTicker()
    completing.value = false
    completePayload = null
    completeToken = -1
    completeDeadline = 0
    rampPercent.value = 0
    status.value = 'idle'
    progress.value = null
    cancelling.value = false
    result.value = null // 未导出完成，半截卡片不可用，一并清掉
    showNotice('已取消导出')
  } else if (msg.type === PluginMessage.EXPORT_ERROR) {
    const d = msg.data as { token?: number; message?: string } | null
    if (d?.token !== undefined && d.token !== activeToken.value) return
    stopTicker()
    completing.value = false
    completePayload = null
    completeToken = -1
    completeDeadline = 0
    rampPercent.value = 0
    error.value = d?.message ?? '未知错误'
    status.value = 'error'
    progress.value = null
    cancelling.value = false
    result.value = null
  } else if (
    msg.type === PluginMessage.FRAME_PNG_READY ||
    msg.type === PluginMessage.ALL_PNG_READY
  ) {
    if (pending && pending.readyType === msg.type) {
      pending.resolve(msg.data)
      pending.remaining -= 1
      if (pending.remaining <= 0) {
        window.clearTimeout(pending.timer)
        pending.finish()
      }
    }
  } else if (msg.type === PluginMessage.ZIP_PROGRESS) {
    const d = msg.data as { done?: number; total?: number; label?: string } | null
    if (!d || !d.total) return
    zipProgress.value = {
      percent: Math.min(100, Math.round((100 * (d.done ?? 0)) / d.total)),
      label: d.label ?? '',
    }
  } else if (msg.type === PluginMessage.PNG_ERROR) {
    const d = msg.data as { message?: string } | null
    if (pending) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error(d?.message ?? 'PNG 导出失败'))
      pending = null
    }
  }
}

/** 进度条显示值：完成动画期间走动画值；平时走限速追进后的平滑值（只前进不后退） */
const displayPercent = computed(() => rampPercent.value)
// 静默期（主线程长时间无真实消息）进度条靠假设值爬升，此时不再显示具体阶段标签，
// 避免「序列化画板 n/X」这种明确计数配上虚高的百分比造成对不上的观感
const displayLabel = computed(() => {
  void rampPercent.value // 依赖显示值：ticker 每拍推进也会驱动本标签重算，静默期标签能及时切换
  if (completing.value) return '导出完成…'
  if (Date.now() - lastRealAt > RAMP_GRACE_MS) return '正在处理…'
  return progress.value?.label ?? ''
})

/** 平滑动画主循环：100ms 一跳，同时驱动「限速追进」「静默前爬」与「完成动画」 */
function progressTicker(): void {
  const now = Date.now()
  if (completing.value) {
    // 完成动画：向 100% 平滑推进；到位后停留补足最短可见时长再收尾
    if (rampPercent.value < 100) {
      const step = Math.max(2, (100 - rampPercent.value) * 0.2)
      rampPercent.value = Math.min(100, rampPercent.value + step)
    }
    if (now >= completeDeadline) applyExportResult()
    return
  }
  // 目标值：真实消息 与 静默期假设进度 取较大者（假设进度封顶 RAMP_CEIL，不误报完成）
  let target = progress.value?.percent ?? 0
  if (now - lastRealAt > RAMP_GRACE_MS) {
    const r = rampPercent.value
    target = Math.max(target, Math.min(RAMP_CEIL, r + Math.max(0.8, (RAMP_CEIL - r) * 0.18)))
  }
  // 限速追进：单次跳变 ≤ RAMP_MAX_JUMP，把「0→100 批投递」摊平成平滑动画；小步真实消息原样显示
  if (target > rampPercent.value) {
    const jump = target - rampPercent.value
    rampPercent.value += Math.min(jump, RAMP_MAX_JUMP)
  }
}

function startTicker(): void {
  if (rampTimer) return
  rampTimer = window.setInterval(progressTicker, RAMP_TICK_MS)
}

function stopTicker(): void {
  if (rampTimer) {
    window.clearInterval(rampTimer)
    rampTimer = 0
  }
}

/** 新一轮导出会话起点：复位进度相关状态并启动平滑动画 */
function beginExportSession(): void {
  stopTicker()
  completing.value = false
  completePayload = null
  completeToken = -1
  completeDeadline = 0
  exportStartedAt.value = Date.now()
  rampPercent.value = 0
  lastRealAt = Date.now()
  lastAppliedAt = 0 // 首条真实消息不受限速门控，立即上屏（避免开局 0% 假死）
  progress.value = { percent: 0, label: '准备中…' }
  cancelling.value = false
  result.value = null // 新一轮导出，清掉旧结果（含上次的增量卡片）
  svgDataUrlCache.clear() // 旧帧 svg 已清，SVG data URL 缓存一并清掉，避免缓存无界增长
  selectedFrames.value = [] // 新一轮导出，勾选复位（导出勾选画板已在发送前取走序号）
  status.value = 'exporting'
  startTicker()
}

/** 完成动画收尾：应用真实的 EXPORT_RESULT，切到完成态 */
function applyExportResult(): void {
  stopTicker()
  completing.value = false
  const d = completePayload
  const token = completeToken
  completePayload = null
  completeToken = -1
  completeDeadline = 0
  rampPercent.value = 0
  if (!d || activeToken.value !== token) return // 收尾期间又开始了新导出，本次作废
  // 结尾不再重复携带 frames（已增量交付），合并已收到的卡片，保证下载/打包用的是完整列表
  result.value = { ...d, frames: result.value?.frames ?? [] }
  status.value = 'done'
  progress.value = null
  cancelling.value = false
}

/** 收到 EXPORT_RESULT：慢导出直接收尾；快导出/消息批投递时从当前显示值平滑走到 100%，替代 0→100 跳变 */
function finishExport(d: ExportResultPayload): void {
  const token = d.token ?? activeToken.value
  if (activeToken.value !== token) return
  const now = Date.now()
  const remaining = MIN_EXPORT_VISIBLE_MS - (now - exportStartedAt.value)
  // 导出足够久、且真实消息已把进度条推到顶（用户全程看着它跑完）→ 直接收尾，不再多演
  if (remaining <= 0 && displayPercent.value >= 99) {
    completePayload = d
    completeToken = token
    applyExportResult()
    return
  }
  completePayload = d
  completeToken = token
  // 快导出/批投递：从「平滑值」动画到 100%；若真实消息已到 100% 则停留补足最短可见时长
  completeDeadline = now + Math.max(remaining, COMPLETE_MIN_MS)
  completing.value = true
}

function reExport(scope: 'selection' | 'page'): void {
  // 等待主线程发来带新 token 的 EXPORTING，在此之前忽略所有旧消息
  activeToken.value = -1
  beginExportSession()
  sendMsgToPlugin({
    type: scope === 'selection' ? UIMessage.EXPORT_SELECTION : UIMessage.EXPORT_PAGE,
  })
}

/** 重新加载插件：主线程无自重启能力，关闭插件后由开发者重新运行「打开插件」加载最新代码 */
function reloadPlugin(): void {
  stopTicker()
  showNotice('正在关闭插件…')
  sendMsgToPlugin({ type: UIMessage.RELOAD_PLUGIN })
}

// ---- 窗口尺寸：宿主不支持手动拖动放大，右下角手柄拖动时把目标尺寸发给主线程 resize ----
const RESIZE_MIN = { width: 420, height: 400 }
const RESIZE_MAX = { width: 1400, height: 1200 }
/** 拖动节流：连续拖动时最多每 60ms 发一次，避免消息刷屏 */
let resizeDragState: { startX: number; startY: number; startW: number; startH: number } | null = null
let resizeTimer: number | undefined = undefined

function sendResize(width: number, height: number): void {
  const w = Math.max(RESIZE_MIN.width, Math.min(RESIZE_MAX.width, Math.round(width)))
  const h = Math.max(RESIZE_MIN.height, Math.min(RESIZE_MAX.height, Math.round(height)))
  sendMsgToPlugin({ type: UIMessage.RESIZE_WINDOW, data: { width: w, height: h } })
}

function startResize(e: MouseEvent): void {
  if (resizeDragState) return
  // window.innerWidth/innerHeight 即插件窗口当前尺寸（UI iframe 填满宿主窗口）
  resizeDragState = { startX: e.clientX, startY: e.clientY, startW: window.innerWidth, startH: window.innerHeight }
  const onMove = (ev: MouseEvent): void => {
    if (!resizeDragState) return
    const w = resizeDragState.startW + ev.clientX - resizeDragState.startX
    const h = resizeDragState.startH + ev.clientY - resizeDragState.startY
    if (resizeTimer) window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => sendResize(w, h), 60)
  }
  const onUp = (ev: MouseEvent): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    if (resizeTimer) window.clearTimeout(resizeTimer)
    resizeTimer = undefined
    // 松手前补发一次最终尺寸，确保落在的目标尺寸生效（即使最后一次 mousemove 被节流掉）
    if (resizeDragState) {
      sendResize(
        resizeDragState.startW + ev.clientX - resizeDragState.startX,
        resizeDragState.startH + ev.clientY - resizeDragState.startY,
      )
    }
    resizeDragState = null
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ---- 勾选画板导出：面板内直接挑几个画板重新导出，不必回到 MasterGo 里改选区 ----
function toggleFrameSelect(index: number): void {
  const i = selectedFrames.value.indexOf(index)
  if (i >= 0) selectedFrames.value.splice(i, 1)
  else selectedFrames.value.push(index)
}
function selectAllFrames(): void {
  selectedFrames.value = (result.value?.frames ?? []).map((f) => f.index)
}
function clearFrameSelection(): void {
  selectedFrames.value = []
}
const allFramesSelected = computed(() => {
  const fs = result.value?.frames ?? []
  return fs.length > 0 && fs.every((f) => selectedFrames.value.includes(f.index))
})
/** 导出勾选画板：把选中的 1-based 画板序号发给主线程，映射到最近一次导出的画板根节点重新导出 */
function exportSubset(): void {
  const indices = [...selectedFrames.value].sort((a, b) => a - b)
  if (indices.length === 0) {
    showNotice('请先勾选要导出的画板')
    return
  }
  activeToken.value = -1
  beginExportSession()
  sendMsgToPlugin({ type: UIMessage.EXPORT_FRAME_SUBSET, data: { indices } })
}

/** 取消当前在途导出（若主线程一直未响应，10s 后强制复位 UI） */
function cancelExport(): void {
  if (cancelling.value) return
  cancelling.value = true
  sendMsgToPlugin({ type: UIMessage.EXPORT_CANCEL })
  setTimeout(() => {
    if (cancelling.value) {
      stopTicker()
      completing.value = false
      rampPercent.value = 0
      cancelling.value = false
      status.value = 'idle'
      progress.value = null
      showNotice('取消超时，请重试')
    }
  }, 10000)
}

// SVG data URL 缓存：卡片缩略图在导出进度渲染等高频重渲染场景反复调用 svgDataUrl，
// 对几十 KB 的 SVG 反复 encodeURIComponent 是纯开销；同一 svg 字符串结果恒定，按内容缓存。
// 新一轮导出开始时清空（旧帧 svg 已随 result 清掉，避免跨导出串味）
const svgDataUrlCache = new Map<string, string>()
function svgDataUrl(f: FrameExport): string {
  let url = svgDataUrlCache.get(f.svg)
  if (url === undefined) {
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(f.svg)}`
    svgDataUrlCache.set(f.svg, url)
  }
  return url
}

function downloadName(f: FrameExport, ext: 'svg' | 'png'): string {
  const safe = f.name.replace(/[\\/:*?"<>|]/g, '_') || `frame_${f.index}`
  return `${String(f.index).padStart(2, '0')}_${safe}.${ext}`
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** ZIP 里该画板 PNG 的路径：frames/png/<画板名>/<画板名>@<倍率>.png（同一画板不同倍率在一个子文件夹） */
function scaledPngName(f: FrameExport, scale: number): string {
  const base =
    f.pngFileName || `frames/png/${frameStem(f)}/${frameStem(f)}.png`
  return base.replace(/\.png$/, `${scaleSuffix(scale)}.png`)
}

function triggerDownload(href: string, name: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function loadImageFromDataUrl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

function canvasToBase64(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('图片编码失败'))
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(new Error('图片编码失败'))
        reader.readAsDataURL(blob)
      },
      type,
      quality,
    )
  })
}

/** 画布尺寸安全上限：超大画布（高清素材 × 高倍率，如 4000px×16 倍）会超出浏览器 canvas
 * 分配上限，导致 toBlob 静默失败、ZIP 打包中断或内存爆涨。单边 ≤12000、总像素 ≤5000 万
 * （约 190MB RGBA/张），超限等比缩小到安全值（低于上限时返回原尺寸）。 */
const MAX_CANVAS_DIM = 12000
const MAX_CANVAS_PIXELS = 50_000_000
function clampCanvasSize(w: number, h: number): { width: number; height: number } {
  let cw = Math.max(1, Math.round(w))
  let ch = Math.max(1, Math.round(h))
  const dimScale = Math.min(1, MAX_CANVAS_DIM / Math.max(cw, ch))
  cw = Math.max(1, Math.round(cw * dimScale))
  ch = Math.max(1, Math.round(ch * dimScale))
  const pxScale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cw * ch)))
  if (pxScale < 1) {
    cw = Math.max(1, Math.round(cw * pxScale))
    ch = Math.max(1, Math.round(ch * pxScale))
  }
  return { width: cw, height: ch }
}

/** 缩小采样检测是否含透明像素（决定压缩用 JPEG 还是 PNG） */
function imageHasTransparency(img: HTMLImageElement): boolean {
  const w = Math.min(img.naturalWidth, 32)
  const h = Math.min(img.naturalHeight, 32)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  ctx.drawImage(img, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h).data
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 255) return true
  }
  return false
}

/** 等比放大图片到指定倍率（canvas，客户端处理 assets 素材） */
async function scaleImage(
  base64: string,
  mime: string,
  scale: number,
): Promise<{ base64: string; type: string }> {
  const type = mime.startsWith('image/') ? mime : 'image/png'
  const img = await loadImageFromDataUrl(`data:${type};base64,${base64}`)
  // 放大后可能超出画布安全上限（见 clampCanvasSize），钳制到安全尺寸，避免 toBlob 失败/内存爆涨
  const c = clampCanvasSize(img.naturalWidth * scale, img.naturalHeight * scale)
  if (c.width !== Math.max(1, Math.round(img.naturalWidth * scale))) {
    console.warn('图片放大超过画布安全上限，已缩小处理：', img.naturalWidth, img.naturalHeight, '×', scale)
  }
  const canvas = document.createElement('canvas')
  canvas.width = c.width
  canvas.height = c.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return { base64, type: 'image/png' }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return { base64: await canvasToBase64(canvas, 'image/png'), type: 'image/png' }
}

/** 质量档（10–100）→ 每通道保留位数：100→8 不压缩，80→6，50→4，10→3 */
function bitsForQuality(q: number): number {
  return Math.max(3, Math.min(8, Math.round(q * 0.08)))
}

/**
 * 均匀量化通道位数后用 PNG 重编码（保留 alpha、尺寸不变）。
 * 同色区域变多 → PNG 的 deflate 压缩率大幅提升，是对 PNG 真正生效的压缩方式；
 * 失败返回空串，由调用方跳过该候选。
 */
async function quantizePng(img: HTMLImageElement, bits: number): Promise<string> {
  // 原图尺寸可能超过画布安全上限，钳制后按画布尺寸采样，避免 getImageData 分配爆炸
  const c = clampCanvasSize(img.naturalWidth, img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = c.width
  canvas.height = c.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return ''
  try {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = id.data
    const step = 256 / (1 << bits)
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.round(d[i] / step) * step
      d[i + 1] = Math.round(d[i + 1] / step) * step
      d[i + 2] = Math.round(d[i + 2] / step) * step
    }
    ctx.putImageData(id, 0, 0)
    return await canvasToBase64(canvas, 'image/png')
  } catch {
    return ''
  }
}

/**
 * 压缩图片：候选包括「量化 PNG（保透明度）」与「JPEG（仅不透明图）」，
 * 与输入对比取体积最小者，保证压缩只会减小、不会变大。
 */
async function compressData(
  data: { base64: string; type: string },
  quality: number,
): Promise<{ base64: string; type: string }> {
  const bits = bitsForQuality(quality)
  if (bits >= 8) return data
  const img = await loadImageFromDataUrl(`data:${data.type};base64,${data.base64}`)
  const candidates: { base64: string; type: string }[] = []
  const quantized = await quantizePng(img, bits)
  if (quantized) candidates.push({ base64: quantized, type: 'image/png' })
  if (!imageHasTransparency(img)) {
    try {
      const c = clampCanvasSize(img.naturalWidth, img.naturalHeight) // 超限原图同样钳制，防 canvas 失败
      const canvas = document.createElement('canvas')
      canvas.width = c.width
      canvas.height = c.height
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const jq = Math.max(0.1, Math.min(1, quality / 100))
        const jpeg = await canvasToBase64(canvas, 'image/jpeg', jq)
        if (jpeg) candidates.push({ base64: jpeg, type: 'image/jpeg' })
      }
    } catch {
      /* JPEG 候选失败不影响量化 PNG */
    }
  }
  let best = data
  for (const c of candidates) {
    if (c.base64 && c.base64.length < best.base64.length) best = c
  }
  return best
}

/** 小并发池：同时执行 limit 个任务，返回按输入顺序排列的结果（用于图片压缩/放大的并行处理） */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
      done++
      onProgress?.(done, items.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

function frameStem(f: FrameExport): string {
  return downloadName(f, 'png').replace(/\.png$/, '')
}

function framePngName(f: FrameExport, scale: number, type: string): string {
  let name = downloadName(f, 'png').replace(/\.png$/, `${scaleSuffix(scale)}.png`)
  if (type === 'image/jpeg') name = name.replace(/\.png$/, '.jpg')
  else if (type === 'image/webp') name = name.replace(/\.png$/, '.webp')
  return name
}

function frameSvgName(f: FrameExport, scale: number): string {
  return downloadName(f, 'svg').replace(/\.svg$/, `${scaleSuffix(scale)}.svg`)
}

/** 把 PNG 字节（base64）转成 JPEG / WebP（canvas 编码）；JPEG 底透明区域填白 */
async function convertFormat(
  pngBase64: string,
  fmt: 'image/jpeg' | 'image/webp',
  quality: number,
): Promise<string> {
  const img = await loadImageFromDataUrl(`data:image/png;base64,${pngBase64}`)
  const c = clampCanvasSize(img.naturalWidth, img.naturalHeight) // 大图按安全上限钳制，防 canvas 失败
  const canvas = document.createElement('canvas')
  canvas.width = c.width
  canvas.height = c.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画布不可用')
  if (fmt === 'image/jpeg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvasToBase64(canvas, fmt, quality)
}

/** 该画板该格式是否正在导出中（只有它显示「导出中…」） */
function frameDlExporting(index: number, type: string): boolean {
  const ex = frameExporting.value
  return ex !== null && ex.index === index && ex.type === type
}

/** 弹层下载按钮的悬停提示：导出其他格式时告知暂时不可点 */
function frameDlTitle(index: number, type: string): string {
  if (status.value !== 'done') return '导出完成后可下载'
  const ex = frameExporting.value
  if (ex && (ex.index !== index || ex.type !== type)) return '正在导出其他格式，请稍候'
  return ''
}

/** 单个画板按所选倍率下载：SVG 用矢量；PNG 走主线程重导出；JPG/WebP 在主线程 PNG 基础上 canvas 转码 */
async function downloadFrameImage(f: FrameExport, type: 'svg' | 'png' | 'jpeg' | 'webp'): Promise<void> {
  if (frameExporting.value !== null) return
  const scales = [...selectedScales.value].sort((a, b) => a - b)
  if (scales.length === 0) scales.push(1)
  frameExporting.value = { index: f.index, type }
  try {
    if (type === 'svg') {
      if (scales.length === 1) {
        triggerDownload(svgDataUrl(f), frameSvgName(f, scales[0]))
      } else {
        // 多个倍率 → 打成压缩包（SVG 为矢量，各倍率同内容，按命名区分；文本默认 DEFLATE）
        const zip = new JSZip()
        for (const scale of scales) zip.file(frameSvgName(f, scale), f.svg)
        const blob = await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 },
        })
        downloadBlob(blob, `${frameStem(f)}_svg.zip`)
      }
      showNotice(`已下载 ${f.name} SVG（${scales.map((s) => `${s}×`).join(' ')}）`)
      return
    }

    const mime = type === 'jpeg' ? 'image/jpeg' : type === 'webp' ? 'image/webp' : 'image/png'
    const ext = type === 'jpeg' ? 'jpg' : type
    // 逐倍率导出该画板 PNG，按需转码/压缩
    const items: { base64: string; type: string; scale: number }[] = []
    for (const scale of scales) {
      const data = await request<{ index: number; pngBase64: string }>(
        UIMessage.EXPORT_FRAME_PNG,
        PluginMessage.FRAME_PNG_READY,
        { index: f.index, scale },
      )
      let imgData: { base64: string; type: string } = { base64: data.pngBase64, type: 'image/png' }
      if (type === 'jpeg' || type === 'webp') {
        imgData = {
          base64: await convertFormat(
            data.pngBase64,
            type === 'jpeg' ? 'image/jpeg' : 'image/webp',
            IMAGE_CONVERT_QUALITY,
          ),
          type: mime,
        }
      } else if (compress.value) {
        imgData = await compressData(imgData, compressQuality.value)
      }
      items.push({ ...imgData, scale })
    }

    if (items.length === 1) {
      const e = items[0]
      triggerDownload(`data:${e.type};base64,${e.base64}`, framePngName(f, e.scale, e.type))
    } else {
      // 多个倍率 → 打成压缩包；图片字节已是压缩编码，用 STORE 避免 DEFLATE 徒增耗时（文本元数据走默认压缩）
      const zip = new JSZip()
      for (const e of items) zip.file(framePngName(f, e.scale, e.type), e.base64, { base64: true, compression: 'STORE' })
      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      })
      downloadBlob(blob, `${frameStem(f)}_${ext}.zip`)
    }
    showNotice(`已下载 ${f.name} ${type.toUpperCase()}（${scales.map((s) => `${s}×`).join(' ')}）`)
  } catch (err) {
    showNotice(err instanceof Error ? err.message : `${type.toUpperCase()} 下载失败`)
  } finally {
    frameExporting.value = null
  }
}

/** 生成自包含的聚合预览页 preview.html：按页面分组展示全部画板（优先矢量 SVG，其次 1× 高清 PNG，最后 0.5× 预览图），
 * 附设计 Token 与素材清单，点击画板弹层放大。全部内容内联、无外部依赖，解压 ZIP 后浏览器直接打开即可浏览。 */
function buildPreviewHtml(
  design: {
    document?: { name?: string; page?: string }
    exportedAt?: string
    scope?: 'selection' | 'page'
    nodeCount?: number
    designTokens: {
      colors: { hex: string; usageCount: number; sampleNames?: string[] }[]
      fonts: { family: string; style: string; fontSize: number; usageCount: number }[]
      spacings: { value: number; usageCount: number }[]
      radii: { value: number; usageCount: number }[]
      shadows: { label: string; hex: string; blur: number; usageCount: number }[]
    }
    assets: { id: string; file: string; mime: string }[]
  },
  frames: { index: number; name: string; dimensions: string; svg: string; pngBase64: string | null; svgApprox?: boolean }[],
  pages: { name: string; frameCount: number; file?: string }[],
  hiRes: Map<string, string> | null,
): string {
  const esc = (s: string) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  // main 侧 compactJson 会把空数组/空对象字段就地删除（如无素材时 design.assets、全空时的
  // designTokens 及其子数组都可能是 undefined），这里统一兜底，避免 .map 崩掉打包
  const t = design.designTokens ?? { colors: [], fonts: [], spacings: [], radii: [], shadows: [] }
  const scopeText = design.scope === 'selection' ? '当前选中图层' : '当前页面'
  const exportedAt = design.exportedAt ? new Date(design.exportedAt).toLocaleString('zh-CN') : ''

  // 每个画板渲染：优先真实 SVG（svgApprox 的近似图退而用 PNG），其次 1× 高清 PNG，最后 0.5× 预览图
  const frameBlock = (f: (typeof frames)[number]) => {
    let img = ''
    if (!f.svgApprox && f.svg) {
      img = `<img src="${svgUrl(f.svg)}" alt="${esc(f.name)}">`
    } else {
      const png = hiRes?.get(`1:${f.index}`) ?? f.pngBase64
      if (png) img = `<img src="data:image/png;base64,${png}" alt="${esc(f.name)}">`
      else img = `<div class="no-preview">无预览</div>`
    }
    return (
      `<div class="frame" title="点击放大">` +
      `<div class="frame-img">${img}</div>` +
      `<div class="cap"><b>${esc(f.name)}</b><span>${esc(f.dimensions)}</span></div>` +
      `</div>`
    )
  }

  const pageList = pages && pages.length > 0 ? pages : [{ name: design.document?.page ?? '全部画板', frameCount: frames.length }]
  let frameIdx = 0
  const pageBlocks = pageList
    .map((p) => {
      const slice = frames.slice(frameIdx, frameIdx + (p.frameCount || frames.length - frameIdx))
      frameIdx += slice.length
      return (
        `<div class="page">` +
        `<h3 class="page-title">${esc(p.name)}<span class="count">${slice.length} 个画板 · ${esc(p.file ?? '')}</span></h3>` +
        `<div class="grid">${slice.map(frameBlock).join('')}</div>` +
        `</div>`
      )
    })
    .join('')

  const colorChips = (t.colors ?? [])
    .map((c) => {
      const title = `${c.hex} ×${c.usageCount}${c.sampleNames?.length ? '（' + c.sampleNames.slice(0, 3).join('、') + '…）' : ''}`
      return `<span class="chip" title="${esc(title)}"><span class="swatch" style="background:${c.hex}"></span>${esc(c.hex)} ×${c.usageCount}</span>`
    })
    .join('')
  const fontChips = (t.fonts ?? [])
    .map((f) => `<span class="chip" title="字号 ${f.fontSize}px · 使用 ${f.usageCount} 次">${esc(f.family)} ${esc(f.style)} ${f.fontSize}px ×${f.usageCount}</span>`)
    .join('')
  const spacerChips = (t.spacings ?? [])
    .map((s) => `<span class="chip" title="使用 ${s.usageCount} 次">间距 ${s.value}px ×${s.usageCount}</span>`)
    .join('')
  const radiusChips = (t.radii ?? [])
    .map((r) => `<span class="chip" title="使用 ${r.usageCount} 次">圆角 ${r.value}px ×${r.usageCount}</span>`)
    .join('')
  const shadowChips = (t.shadows ?? [])
    .map((s) => `<span class="chip" title="${esc(s.label)} · 模糊 ${s.blur}px · 使用 ${s.usageCount} 次">阴影 ${esc(s.label)} ×${s.usageCount}</span>`)
    .join('')
  const assetRows = (design.assets ?? [])
    .map((a) => `<tr><td>${esc(a.id)}</td><td><code>${esc(a.file)}</code></td><td>${esc(a.mime)}</td></tr>`)
    .join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>设计稿预览 · ${esc(design.document?.name ?? '未命名文档')}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; margin: 0; background: #f3f4f6; color: #111827; }
  header { padding: 18px 28px; background: #fff; border-bottom: 1px solid #e5e7eb; position: sticky; top: 0; z-index: 10; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header .meta { color: #6b7280; font-size: 12px; line-height: 1.6; }
  main { padding: 22px 28px; max-width: 1200px; margin: 0 auto; }
  .section { margin-bottom: 30px; }
  .section h2 { font-size: 15px; margin: 0 0 12px; color: #374151; }
  .panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; }
  .tokens { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 999px; padding: 4px 10px; font-size: 12px; color: #374151; }
  .chip .swatch { width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(0,0,0,.08); }
  table.assets { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.assets th, table.assets td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #f3f4f6; }
  table.assets th { color: #6b7280; font-weight: 500; }
  table.assets code { background: #f3f4f6; border-radius: 4px; padding: 1px 5px; }
  .page { margin-bottom: 28px; }
  .page-title { font-size: 14px; font-weight: 600; margin: 0 0 10px; color: #374151; }
  .page-title .count { color: #9ca3af; font-weight: 400; margin-left: 8px; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
  .frame { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; cursor: zoom-in; }
  .frame:hover { box-shadow: 0 4px 14px rgba(0,0,0,.08); }
  .frame-img { padding: 8px; background: #fff; }
  .frame-img img { width: 100%; display: block; background: #fff; }
  .frame-img .no-preview { display: flex; align-items: center; justify-content: center; height: 120px; color: #9ca3af; font-size: 12px; }
  .frame .cap { padding: 8px 10px; border-top: 1px solid #f3f4f6; font-size: 12px; }
  .frame .cap b { display: block; font-weight: 600; }
  .frame .cap span { color: #9ca3af; }
  .modal { display: none; position: fixed; inset: 0; background: rgba(17,24,39,.82); z-index: 100; padding: 40px; overflow: auto; text-align: center; }
  .modal.show { display: block; }
  .modal-body img { max-width: 100%; max-height: 85vh; background: #fff; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
  .modal-cap { color: #e5e7eb; margin-top: 14px; font-size: 13px; }
  footer { padding: 18px 28px; color: #9ca3af; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>${esc(design.document?.name ?? '设计稿')} · ${esc(design.document?.page ?? '')}</h1>
  <div class="meta">导出范围：${scopeText}${design.nodeCount != null ? ' · 节点数 ' + design.nodeCount : ''}${exportedAt ? ' · 导出时间 ' + exportedAt : ''}</div>
</header>
<main>
  <section class="section">
    <h2>设计 Token</h2>
    <div class="panel">
      ${colorChips ? '<div class="tokens" style="margin-bottom:10px"><span class="chip" style="background:#eef2ff;color:#4338ca">颜色</span>' + colorChips + '</div>' : ''}
      ${fontChips ? '<div class="tokens" style="margin-bottom:10px"><span class="chip" style="background:#eef2ff;color:#4338ca">字体</span>' + fontChips + '</div>' : ''}
      ${spacerChips ? '<div class="tokens" style="margin-bottom:10px"><span class="chip" style="background:#eef2ff;color:#4338ca">间距</span>' + spacerChips + '</div>' : ''}
      ${radiusChips ? '<div class="tokens" style="margin-bottom:10px"><span class="chip" style="background:#eef2ff;color:#4338ca">圆角</span>' + radiusChips + '</div>' : ''}
      ${shadowChips ? '<div class="tokens"><span class="chip" style="background:#eef2ff;color:#4338ca">阴影</span>' + shadowChips + '</div>' : ''}
      ${!colorChips && !fontChips && !spacerChips && !radiusChips && !shadowChips ? '<div class="tokens"><span class="chip">无 Token</span></div>' : ''}
    </div>
  </section>
  ${design.assets?.length ? `<section class="section">
    <h2>图片素材（${design.assets.length}）</h2>
    <div class="panel"><table class="assets"><thead><tr><th>ID</th><th>路径</th><th>格式</th></tr></thead><tbody>${assetRows}</tbody></table></div>
  </section>` : ''}
  <section class="section">
    <h2>画板（${frames.length}）</h2>
    ${pageBlocks}
  </section>
</main>
<footer>由「设计稿导出（Claude Code）」插件生成 · 配合 design.json / pages/*.json 使用</footer>
<div class="modal" id="modal"><div class="modal-body" id="modal-body"></div><div class="modal-cap" id="modal-cap"></div></div>
<script>
  (function () {
    var modal = document.getElementById('modal');
    var body = document.getElementById('modal-body');
    var cap = document.getElementById('modal-cap');
    document.addEventListener('click', function (e) {
      var frame = e.target.closest ? e.target.closest('.frame') : null;
      if (frame) {
        var img = frame.querySelector('.frame-img img');
        if (img) {
          body.innerHTML = '';
          var clone = img.cloneNode(false);
          body.appendChild(clone);
          var b = frame.querySelector('.cap b');
          var s = frame.querySelector('.cap span');
          cap.textContent = (b ? b.textContent : '') + (s ? ' — ' + s.textContent : '');
          modal.classList.add('show');
        }
      }
      if (e.target === modal) modal.classList.remove('show');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') modal.classList.remove('show');
    });
  })();
<\/script>
</body>
</html>`
}

async function downloadZip(): Promise<void> {
  if (!result.value) return
  zipping.value = true
  zipProgress.value = { percent: 0, label: '准备打包…' }
  try {
    const r = result.value
    const scales = [...selectedScales.value].sort((a, b) => a - b)
    if (scales.length === 0) scales.push(1)

    // 1) 高清 PNG 重导出（主线程逐画板上报「导出高清图 x/y」；整批失败则回退预览图）
    let hiRes: Map<string, string> | null = null
    allExporting.value = true
    try {
      const perScale = await requestBatch<
        { scale: number; frames: { index: number; pngBase64: string }[] }
      >(
        UIMessage.EXPORT_ALL_PNG,
        PluginMessage.ALL_PNG_READY,
        scales.length,
        { scales },
      )
      hiRes = new Map()
      for (const msg of perScale) {
        for (const fr of msg.frames) {
          hiRes.set(`${msg.scale}:${fr.index}`, fr.pngBase64)
        }
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '高清 PNG 导出失败，ZIP 将仅含 1× 引用图与预览图')
    } finally {
      allExporting.value = false
    }

    const zip = new JSZip()
    zip.file('design.json', JSON.stringify(r.design, null, 2))
    zip.file('design.md', r.markdown)
    // 聚合预览页：自包含 HTML，解压后浏览器直接打开即可按页面浏览全部画板 / Token / 素材
    // 页面清单取 design.json 索引的 pages（含 frameCount），而非 payload 的 pages（含 json 内容）
    zip.file('preview.html', buildPreviewHtml(r.design, r.frames, r.design.pages ?? [], hiRes))

    // pages：按一级蒙版组（页面）拆分后的 JSON，每页一个文件
    for (const p of r.pages ?? []) {
      zip.file(p.file, p.json)
    }

    // frames：SVG 直接写入
    for (const f of r.frames) {
      zip.file(f.svgFileName, f.svg)
    }

    // 2) 引用保证：1× 原图/预览始终写入 design.json 引用的路径——无论选什么倍率，
    //    Claude Code 按 previewPngFile / assets[].file 找文件一定找得到。
    //    引用文件不压缩（压缩可能改成 .jpg 断引用），保证引用必有且字节可用。
    const baseFrames = r.frames.filter((f) => !!f.pngBase64 || !!hiRes?.has(`1:${f.index}`))
    const baseTotal = baseFrames.length + r.assets.length
    let baseDone = 0
    const reportBase = () => {
      baseDone++
      zipProgress.value = {
        percent: Math.round((100 * baseDone) / Math.max(1, baseTotal)),
        label: `写入引用图 ${baseDone}/${baseTotal}`,
      }
    }
    for (const f of baseFrames) {
      // 1×：优先用高清 1×（用户选了 1× 时），否则用 0.5× 预览图；写预览图引用的路径
      const png = hiRes?.get(`1:${f.index}`) ?? f.pngBase64
      if (!png) continue
      // 无预览的画板（超出 MAX_PNG）pngFileName 为空：用同名路径兜底，保证有 1× 时也能落地
      // 引用图片字节已是压缩编码，STORE 存储（不压缩，保证字节可用且加快打包）
      zip.file(f.pngFileName || scaledPngName(f, 1), png, { base64: true, compression: 'STORE' })
      reportBase()
    }
    for (const a of r.assets) {
      // a.fileName 已是 assets/<素材名>/<素材名>.png，与 design.json 的 assets[].file 完全一致
      zip.file(a.fileName, a.data, { base64: true, compression: 'STORE' })
      reportBase()
    }

    // 3) 所选额外倍率（1× 已在上面处理）：画板 PNG 仅取高清导出（失败不硬塞预览图冒充该倍率）；
    //    素材多倍率在 UI 侧 canvas 等比放大；压缩开启时重编码（取 JPEG 则按 .jpg 命名）
    const frameExtraTasks: { f: FrameExport; scale: number; png: string }[] = []
    for (const f of r.frames) {
      for (const scale of scales) {
        if (scale === 1) continue
        const png = hiRes?.get(`${scale}:${f.index}`)
        if (png) frameExtraTasks.push({ f, scale, png })
      }
    }
    const assetExtraTasks: { a: AssetPayload; scale: number }[] = []
    for (const a of r.assets) {
      for (const scale of scales) {
        if (scale === 1) continue
        assetExtraTasks.push({ a, scale })
      }
    }
    const extraTotal = frameExtraTasks.length + assetExtraTasks.length
    let extraDone = 0
    const label = compress.value ? '压缩图片' : '处理图片'
    const reportExtra = () => {
      extraDone++
      zipProgress.value = {
        percent: Math.round((100 * extraDone) / Math.max(1, extraTotal)),
        label: `${label} ${extraDone}/${extraTotal}`,
      }
    }
    // 4 个并发同时压缩，画板×倍率很多时显著提速（压缩是 canvas 重编码，比写 ZIP 慢得多）
    await mapPool(frameExtraTasks, 4, async (t) => {
      const imgData = compress.value
        ? await compressData({ base64: t.png, type: 'image/png' }, compressQuality.value)
        : { base64: t.png, type: 'image/png' }
      const name =
        imgData.type === 'image/jpeg'
          ? scaledPngName(t.f, t.scale).replace(/\.png$/, '.jpg')
          : scaledPngName(t.f, t.scale)
      zip.file(name, imgData.base64, { base64: true, compression: 'STORE' })
    }, reportExtra)
    await mapPool(assetExtraTasks, 4, async (t) => {
      const { a, scale } = t
      // fileName 已是 assets/<素材名>/<素材名>.png，取 basename 做子文件夹名，避免多层嵌套
      const stem = a.fileName.replace(/^.*\//, '').replace(/\.[^./]+$/, '')
      const data = compress.value
        ? await compressData(await scaleImage(a.data, a.mime, scale), compressQuality.value)
        : await scaleImage(a.data, a.mime, scale)
      const ext = data.type === 'image/jpeg' ? 'jpg' : 'png'
      zip.file(`assets/${stem}/${stem}${scaleSuffix(scale)}.${ext}`, data.base64, { base64: true, compression: 'STORE' })
    }, reportExtra)

    // 4) 压缩写 ZIP（JSZip 按字节量回报进度；文本文件默认 DEFLATE，图片字节 STORE）
    const blob = await zip.generateAsync(
      {
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      },
      (meta) => {
        const pct = Math.round(meta.percent)
        zipProgress.value = { percent: pct, label: `写入 ZIP ${pct}%` }
      },
    )
    downloadBlob(blob, 'design-export.zip')
    const scaleText = scales.map((s) => `${s}×`).join(' ')
    const compressText = compress.value ? `，压缩 ${compressQuality.value}%` : ''
    showNotice(`已打包 ${r.frames.length} 个画板、${r.assets.length} 个素材（${scaleText}${compressText}；1× 引用图始终包含）`)
  } catch (err) {
    // 打包链路任一环失败（canvas 编码、图片解码、JSZip 写入等）都要明确提示：
    // 没有这里，异常会以 unhandled rejection 静默冒出，用户只看到「打包中…」一闪就没了反馈
    const message = err instanceof Error ? err.message : String(err)
    console.error('[MasterGoExportToJSON] ZIP 打包失败', err)
    showNotice(`打包失败：${message}`)
  } finally {
    zipping.value = false
    zipProgress.value = null
  }
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* 继续走 fallback */
    }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

async function copyDesignJson(): Promise<void> {
  if (!result.value) return
  await copyText(JSON.stringify(result.value.design, null, 2))
  copying.value = true
  setTimeout(() => (copying.value = false), 1500)
}

function downloadMarkdown(): void {
  if (!result.value) return
  const blob = new Blob([result.value.markdown], {
    type: 'text/markdown;charset=utf-8',
  })
  downloadBlob(blob, 'design.md')
}

// ---- 预览：画板大图 / design.json / design.md ----

/** 打开画板大图预览：真实矢量 SVG 优先（放大不失真）；近似 SVG 或没有 SVG 时用 PNG */
function openImagePreview(f: FrameExport): void {
  if (!f.svg && !f.pngBase64) return
  // svgApprox = 主线程近似生成的 SVG（非真实矢量），预览时优先用 PNG 预览图，避免看到失真/残缺的近似内容
  const usePng = !!f.pngBase64 && (!f.svg || f.svgApprox === true)
  imagePreview.value = {
    frame: f,
    name: f.name,
    dimensions: f.dimensions,
    src: usePng ? pngSrc(f) : f.svg ? svgDataUrl(f) : pngSrc(f),
  }
  // 重置缩放/平移；等图片可测量后再做初始布局（首次打开：缩到正好放得下，避免一打开就溢出）
  viewScale.value = 1
  viewTx.value = 0
  viewTy.value = 0
  void nextTick(() => {
    const img = imageEl.value
    if (!img) return
    if (img.complete) applyFit()
    else img.addEventListener('load', applyFit, { once: true })
  })
}

function pngSrc(f: FrameExport): string {
  return `data:image/png;base64,${f.pngBase64}`
}

/** 大图从 SVG 回退到 PNG：SVG data URL 加载失败或渲染为空白时调用 */
function fallbackToPngPreview(): void {
  const pv = imagePreview.value
  if (!pv || !pv.frame.pngBase64 || pv.src === pngSrc(pv.frame)) return
  imagePreview.value = { ...pv, src: pngSrc(pv.frame) }
  // src 变化后等新图加载完成再做初始布局
  void nextTick(() => {
    const img = imageEl.value
    if (img) {
      if (img.complete) applyFit()
      else img.addEventListener('load', applyFit, { once: true })
    }
  })
}

function onImageError(): void {
  const pv = imagePreview.value
  if (pv && pv.src.startsWith('data:image/svg+xml')) fallbackToPngPreview()
}

/**
 * 大图加载完成：若是 SVG 且渲染为全透明（蒙版导出的「合法但空白」图），回退 PNG。
 * 注意：这里不调用 applyFit —— 初始布局由 openImagePreview / fallbackToPngPreview 里
 * 的 nextTick+load 监听负责。若在 load 事件里直接 applyFit，弹层布局可能尚未稳定
 * （舞台宽度读到偏小的中间值），导致初始缩放偏小且之后被 clamp 住不恢复。
 */
async function onImageLoaded(): Promise<void> {
  const pv = imagePreview.value
  const img = imageEl.value
  if (!pv || !img || !pv.src.startsWith('data:image/svg+xml') || !pv.frame.pngBase64) return
  if (!img.naturalWidth || !img.naturalHeight) return
  const blank = await isBlankCanvasImage(img)
  if (blank) fallbackToPngPreview()
}

/** 把图片画到 canvas 采样 alpha：整张全透明视为空白图（仅用于检测“合法但空白”的 SVG 预览） */
async function isBlankCanvasImage(img: HTMLImageElement): Promise<boolean> {
  try {
    const c = document.createElement('canvas')
    c.width = Math.min(img.naturalWidth, 512)
    c.height = Math.min(img.naturalHeight, 512)
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return false
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] > 0) return false
    }
    return true
  } catch {
    return false // 跨域等异常时不做判定，保留当前预览
  }
}

/** 按图片实际尺寸缩到恰好放得下（若比弹层小则保持原尺寸并居中） */
function applyFit(): void {
  const st = stageSize()
  const n = imageNaturalSize()
  if (st.w && st.h && n.w && n.h) {
    const fit = Math.min(st.w / n.w, st.h / n.h, 1)
    if (fit > 0 && fit < 1) zoomAt(st.w / 2, st.h / 2, fit)
    clampView()
  }
}
function closeImagePreview(): void {
  imagePreview.value = null
  onWindowMouseUp()
}

function openDocPreview(kind: 'json' | 'md'): void {
  if (!result.value) return
  docPreview.value =
    kind === 'json'
      ? {
          title: 'design.json',
          content: JSON.stringify(result.value.design, null, 2),
          kind,
        }
      : { title: 'design.md', content: result.value.markdown, kind }
}
function closeDocPreview(): void {
  docPreview.value = null
}

/** 预览弹层内复制全部内容（JSON / Markdown 通用） */
async function copyDocPreview(): Promise<void> {
  if (!docPreview.value) return
  await copyText(docPreview.value.content)
  docCopying.value = true
  setTimeout(() => (docCopying.value = false), 1500)
}

/** 预览弹层内下载当前文档 */
function downloadDocPreview(): void {
  if (!docPreview.value) return
  const kind = docPreview.value.kind
  const blob = new Blob([docPreview.value.content], {
    type: kind === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8',
  })
  downloadBlob(blob, kind === 'json' ? 'design.json' : 'design.md')
}

// 预览弹层只允许点右上角「×」关闭：不在空白处点击/Esc 关闭，避免误触退出（如图片拖动后松手落在遮罩上）
</script>

<style>
:root {
  color-scheme: light dark;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Microsoft YaHei', sans-serif;
  font-size: 13px;
  background: #f5f6f8;
  color: #1f2328;
}
.app {
  /* 不设 max-width：面板窗口由插件控制尺寸（右下角可拖动调整），内容跟随窗口宽度排布多列卡片 */
  margin: 0 auto;
  padding: 14px;
}
header h1 {
  font-size: 16px;
  margin: 0 0 2px;
}
header .sub {
  margin: 0 0 12px;
  color: #6b7280;
}
.re-export {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.re-export button {
  flex: 1;
  background: #eef2ff;
  border-color: #c7d2fe;
  color: #3730a3;
}
.center {
  text-align: center;
  padding: 48px 0;
  color: #6b7280;
}
.idle-guide {
  max-width: 380px;
  margin: 0 auto;
  text-align: left;
}
.idle-guide .notice {
  text-align: center;
}
.idle-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: #111827;
}
.idle-hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: #6b7280;
}
.idle-hint code {
  padding: 1px 4px;
  border-radius: 3px;
  background: #f3f4f6;
  font-size: 11.5px;
  color: #4b5563;
}
.spinner {
  width: 28px;
  height: 28px;
  margin: 0 auto 10px;
  border: 3px solid #e5e7eb;
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.progress-block {
  margin-top: 14px;
  text-align: left;
}
.zip-progress {
  margin-top: 12px;
  text-align: left;
  animation: fade-in 0.2s ease;
}
@keyframes fade-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}
.progress-bar {
  width: 100%;
  height: 8px;
  background: #e5e7eb;
  border-radius: 4px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #8b5cf6);
  border-radius: 4px;
  transition: width 0.25s ease;
}
.progress-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
  color: #6b7280;
}
.progress-pct {
  font-weight: 600;
  min-width: 36px;
  text-align: right;
}
.progress-label {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cancel-btn {
  flex-shrink: 0;
  padding: 3px 10px;
  font-size: 12px;
  border: 1px solid #fecaca;
  background: #fff;
  color: #b91c1c;
  border-radius: 6px;
  cursor: pointer;
}
.cancel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.error {
  padding: 16px;
  border: 1px solid #fecaca;
  background: #fef2f2;
  border-radius: 8px;
  color: #b91c1c;
}
.stats {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.stat {
  flex: 1;
  text-align: center;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px;
}
.stat b {
  display: block;
  font-size: 18px;
}
.stat span {
  color: #6b7280;
  font-size: 12px;
}
.notice {
  margin-bottom: 10px;
  padding: 8px 10px;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  border-radius: 6px;
  color: #065f46;
  font-size: 12px;
}
.export-scale {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.export-scale .scale-label {
  color: #6b7280;
  font-size: 12px;
}
.export-scale button {
  padding: 4px 10px;
  font-size: 12px;
  min-width: 34px;
}
.export-scale button.active {
  background: #3b82f6;
  border-color: #3b82f6;
  color: #fff;
}
.scale-input {
  width: 58px;
  padding: 4px 6px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
  background: #fff;
  color: #1f2328;
}
.scale-input.active {
  border-color: #3b82f6;
  box-shadow: 0 0 0 1px #3b82f6;
}
.scale-hint {
  color: #9ca3af;
  font-size: 11px;
}
.compress-opt {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.compress-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.compress-toggle input {
  accent-color: #3b82f6;
}
.quality {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #6b7280;
}
.quality input[type='range'] {
  width: 120px;
  accent-color: #3b82f6;
}
.quality-input {
  width: 52px;
  padding: 4px 6px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
  background: #fff;
  color: #1f2328;
}
.quality-unit {
  color: #6b7280;
}
.quality-warn {
  flex-basis: 100%;
  margin: 0;
  color: #b45309;
  font-size: 11px;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.subset-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 10px 12px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
}
.subset-hint {
  color: #6b7280;
  font-size: 12px;
  margin-left: 4px;
}
button {
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
}
button:hover:not(:disabled) {
  border-color: #9ca3af;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
button.primary {
  background: #3b82f6;
  border-color: #3b82f6;
  color: #fff;
  font-weight: 600;
}
.frames {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}
.frame-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
  position: relative;
}
.frame-card.sel {
  border-color: #3b82f6;
  box-shadow: 0 0 0 1px #3b82f6;
}
.frame-check {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 3;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid #d1d5db;
  border-radius: 5px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.frame-check input {
  margin: 0;
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: #3b82f6;
}
.frame-preview {
  height: 120px;
  background: #f9fafb;
  display: flex;
  align-items: center;
  justify-content: center;
}
.frame-preview img {
  max-width: 100%;
  max-height: 100%;
}
.no-png {
  color: #9ca3af;
  font-size: 12px;
}
.frame-info {
  padding: 8px 10px 10px;
  display: flex;
  justify-content: space-between;
  gap: 6px;
}
.frame-info span {
  color: #6b7280;
  font-size: 12px;
  white-space: nowrap;
}
.hint {
  margin-top: 16px;
  padding: 10px 12px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  color: #1e40af;
  line-height: 1.5;
}
header {
  position: relative;
}
.help-link {
  position: absolute;
  top: 0;
  right: 0;
  padding: 4px 10px;
  font-size: 12px;
  color: #3b82f6;
  border-color: #bfdbfe;
  background: transparent;
}
/* ---- 开发版「重新加载插件」：与「帮助」并排在右上角，颜色加深以区分 ---- */
.reload-link {
  position: absolute;
  top: 0;
  right: 46px;
  padding: 4px 10px;
  font-size: 12px;
  color: #b45309;
  border-color: #fcd9a8;
  background: transparent;
}
.reload-link:disabled {
  color: #d1d5db;
  border-color: #e5e7eb;
  cursor: not-allowed;
}
/* ---- 窗口尺寸调节手柄：固定右下角，拖动发送 RESIZE_WINDOW 由主线程 mg.ui.resize ---- */
.resize-handle {
  position: fixed;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  background: linear-gradient(
      135deg,
      transparent 0 50%,
      #94a3b8 50% 62%,
      transparent 62%
    ),
    linear-gradient(135deg, transparent 0 72%, #cbd5e1 72% 82%, transparent 82%);
  background-size: 100% 100%;
  z-index: 40;
}
.resize-handle:hover {
  filter: brightness(0.8);
}
/* ---- 自定义倍率标签：chip = 选中按钮 + 删除按钮 ---- */
.scale-chip {
  display: inline-flex;
  align-items: center;
  gap: 0;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  overflow: hidden;
  background: #fff;
}
.scale-chip.active {
  border-color: #3b82f6;
}
.scale-chip.active .chip-select {
  background: #3b82f6;
  border-color: #3b82f6;
  color: #fff;
}
.scale-chip .chip-select {
  padding: 4px 6px 4px 10px;
  font-size: 12px;
  min-width: 30px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: #1f2328;
}
.scale-chip .chip-del {
  padding: 4px 6px;
  font-size: 12px;
  border: none;
  border-left: 1px solid #e5e7eb;
  border-radius: 0;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
}
.scale-chip .chip-del:hover {
  color: #b91c1c;
  background: #fef2f2;
}
.scale-add {
  padding: 4px 8px;
  font-size: 13px;
  min-width: 30px;
}
/* ---- 画板预览图可点击 ---- */
.frame-preview.clickable {
  cursor: zoom-in;
}
/* ---- 弹层 ---- */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: fade-in 0.15s ease;
}
.modal {
  position: relative;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  max-width: 90vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  padding: 16px;
}
.modal h3 {
  margin: 0 0 10px;
  font-size: 14px;
  padding-right: 28px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.modal-close {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 18px;
  line-height: 1;
  color: #6b7280;
  border-radius: 50%;
}
.modal-close:hover {
  background: #f3f4f6;
  color: #1f2328;
}
.modal-image {
  width: min(88vw, 720px);
  height: min(70vh, 640px);
}
/* 预览大图：缩放/平移舞台（点击图片开始拖动；滚轮缩放/滚动；Shift+滚轮横向滚动） */
.image-stage {
  flex: 1;
  min-height: 300px;
  overflow: hidden;
  position: relative;
  border-radius: 6px;
  background:
    linear-gradient(45deg, #e7e7e7 25%, transparent 25%, transparent 75%, #e7e7e7 75%),
    linear-gradient(45deg, #e7e7e7 25%, transparent 25%, transparent 75%, #e7e7e7 75%);
  background-size: 20px 20px;
  background-position: 0 0, 10px 10px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.image-stage.dragging {
  cursor: grabbing;
}
.image-stage img {
  position: absolute;
  top: 0;
  left: 0;
  max-width: none;
  max-height: none;
  transform-origin: 0 0;
  pointer-events: none;
}
.modal-image-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-shrink: 0;
}
.modal-image-actions .zoom-pct {
  font-size: 12px;
  color: #6b7280;
  min-width: 42px;
  font-variant-numeric: tabular-nums;
}
.modal-image-actions .frame-dl {
  font-size: 12px;
  color: #3b82f6;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
  padding: 3px 10px;
  background: transparent;
  cursor: pointer;
}
.modal-image-actions .frame-dl:disabled {
  opacity: 0.6;
  cursor: default;
}
.modal-dim {
  margin: 10px 0 0;
  color: #6b7280;
  font-size: 12px;
  line-height: 1.5;
}
.modal-doc {
  width: min(90vw, 720px);
}
.doc-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-shrink: 0;
}
.doc-content {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 12px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60vh;
  color: #1f2328;
}
/* ---- 帮助页 ---- */
.help-page .help-section {
  margin-bottom: 14px;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  line-height: 1.7;
}
.help-page .help-section h2 {
  margin: 0 0 6px;
  font-size: 14px;
}
.help-page .help-section p,
.help-page .help-section li {
  color: #374151;
  font-size: 13px;
}
.help-page .help-section ul,
.help-page .help-section ol {
  margin: 6px 0;
  padding-left: 20px;
}
.help-quote {
  margin: 8px 0 0;
  padding: 8px 10px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 6px;
  color: #1e40af;
  font-size: 12px;
  white-space: pre-wrap;
}
@media (prefers-color-scheme: dark) {
  body {
    background: #1a1d21;
    color: #e5e7eb;
  }
  .stat, .frame-card {
    background: #24272c;
    border-color: #33383f;
  }
  .frame-preview {
    background: #1f2328;
  }
  button {
    background: #24272c;
    border-color: #3f4550;
    color: #e5e7eb;
  }
  .re-export button {
    background: #312e81;
    border-color: #4338ca;
    color: #c7d2fe;
  }
  .scale-input {
    background: #24272c;
    border-color: #3f4550;
    color: #e5e7eb;
  }
  .notice {
    background: #064e3b;
    border-color: #065f46;
    color: #a7f3d0;
  }
  .quality-value {
    color: #e5e7eb;
  }
  .modal-image-actions .frame-dl {
    color: #93c5fd;
    border-color: #1e3a8a;
  }
  .hint {
    background: #1e293b;
    border-color: #334155;
    color: #93c5fd;
  }
  .resize-handle {
    background: linear-gradient(
        135deg,
        transparent 0 50%,
        #475569 50% 62%,
        transparent 62%
      ),
      linear-gradient(135deg, transparent 0 72%, #334155 72% 82%, transparent 82%);
  }
  .progress-bar {
    background: #33383f;
  }
  .progress-row {
    color: #9ca3af;
  }
  .cancel-btn {
    background: #24272c;
    border-color: #7f1d1d;
    color: #fca5a5;
  }
  .modal {
    background: #24272c;
  }
  .modal-close {
    color: #9ca3af;
  }
  .modal-close:hover {
    background: #33383f;
    color: #e5e7eb;
  }
  .modal-dim {
    color: #9ca3af;
  }
  .image-stage {
    background:
      linear-gradient(45deg, #33383f 25%, transparent 25%, transparent 75%, #33383f 75%),
      linear-gradient(45deg, #33383f 25%, transparent 25%, transparent 75%, #33383f 75%);
  }
  .modal-image-actions .zoom-pct {
    color: #9ca3af;
  }
  .doc-content {
    background: #1a1d21;
    border-color: #33383f;
    color: #e5e7eb;
  }
  .scale-chip {
    background: #24272c;
    border-color: #3f4550;
  }
  .scale-chip .chip-select {
    color: #e5e7eb;
  }
  .scale-chip .chip-del {
    border-left-color: #3f4550;
    color: #6b7280;
  }
  .scale-chip .chip-del:hover {
    color: #fca5a5;
    background: #3b1d1d;
  }
  .help-link {
    color: #93c5fd;
    border-color: #1e3a8a;
  }
  .help-page .help-section {
    background: #24272c;
    border-color: #33383f;
  }
  .help-page .help-section p,
  .help-page .help-section li {
    color: #cbd5e1;
  }
  .help-quote {
    background: #1e293b;
    border-color: #334155;
    color: #93c5fd;
  }
}
</style>
