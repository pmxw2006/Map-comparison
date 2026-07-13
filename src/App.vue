<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  Images,
  Link2,
  Maximize2,
  Minimize2,
  RotateCcw,
  ScanLine,
  Unlink,
  Upload,
} from '@lucide/vue'
import PanoramaViewer from './components/PanoramaViewer.vue'
import type { PanoramaItem, PanoramaViewerExpose, ViewState } from './types/panorama'

const DEFAULT_VIEW: ViewState = { yaw: 285, pitch: -2, fov: 70 }
const MAX_PANORAMAS = 4

function createDemoPanoramas(): PanoramaItem[] {
  return [
    {
      id: 'demo-a',
      name: '全景影像 A',
      tag: '基准影像',
      detail: '7296 × 3648 · 360°',
      src: '/panoramas/key-biscayne-1.jpg',
      fileName: 'key-biscayne-1.jpg',
      northOffset: 0,
    },
    {
      id: 'demo-b',
      name: '全景影像 B',
      tag: '对比影像',
      detail: '7296 × 3648 · 360°',
      src: '/panoramas/key-biscayne-2.jpg',
      fileName: 'key-biscayne-2.jpg',
      northOffset: 0,
    },
  ]
}

const panoramas = ref<PanoramaItem[]>(createDemoPanoramas())
const views = ref<ViewState[]>(panoramas.value.map(() => ({ ...DEFAULT_VIEW })))
const activeIndex = ref(0)
const syncEnabled = ref(true)
const usingDemo = ref(true)
const isFullscreen = ref(false)
const filePicker = ref<HTMLInputElement | null>(null)
const viewerRefs = ref<Array<PanoramaViewerExpose | null>>([])
const toast = ref('')
let toastTimer = 0

const activeView = computed(() => views.value[activeIndex.value] ?? DEFAULT_VIEW)
const activePanorama = computed(() => panoramas.value[activeIndex.value] ?? panoramas.value[0])
const normalizedHeading = computed(() => {
  const offset = activePanorama.value?.northOffset ?? 0
  return ((Math.round(activeView.value.yaw + offset) % 360) + 360) % 360
})
const pitchText = computed(() => {
  const pitch = Math.round(activeView.value.pitch)
  return `${pitch > 0 ? '+' : ''}${pitch}°`
})
const headingText = computed(() => String(normalizedHeading.value).padStart(3, '0'))
const gridClass = computed(() => `count-${Math.min(panoramas.value.length, MAX_PANORAMAS)}`)

function setViewerRef(element: unknown, index: number) {
  viewerRefs.value[index] = (element as PanoramaViewerExpose | null) ?? null
}

function notify(message: string) {
  toast.value = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 2600)
}

// 同步开启时，任一画面的变化都会作为唯一视角源广播到全部查看器。
function handleViewChange(index: number, view: ViewState) {
  activeIndex.value = index
  if (syncEnabled.value) {
    views.value = views.value.map(() => ({ ...view }))
  } else {
    views.value[index] = { ...view }
  }
}

function toggleSync() {
  syncEnabled.value = !syncEnabled.value
  if (syncEnabled.value) {
    const source = { ...activeView.value }
    views.value = views.value.map(() => ({ ...source }))
    notify('已同步到当前活动视角')
  } else {
    notify('已切换为独立视角')
  }
}

function releaseObjectUrls(items: PanoramaItem[]) {
  // 浏览器为上传文件创建的 blob URL 不会自动释放，替换和退出时统一回收。
  items.forEach((item) => {
    if (item.isObjectUrl) URL.revokeObjectURL(item.src)
  })
}

function resetDemo() {
  releaseObjectUrls(panoramas.value)
  panoramas.value = createDemoPanoramas()
  views.value = panoramas.value.map(() => ({ ...DEFAULT_VIEW }))
  viewerRefs.value = []
  activeIndex.value = 0
  syncEnabled.value = true
  usingDemo.value = true
  notify('已恢复示例全景')
}

function openFilePicker() {
  filePicker.value?.click()
}

function handleUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const selected = Array.from(input.files ?? []).filter((file) => file.type.startsWith('image/'))
  input.value = ''
  if (!selected.length) {
    notify('未选择可用的图片文件')
    return
  }

  if (usingDemo.value) {
    releaseObjectUrls(panoramas.value)
    panoramas.value = []
    views.value = []
    viewerRefs.value = []
    usingDemo.value = false
  }

  const available = MAX_PANORAMAS - panoramas.value.length
  if (available <= 0) {
    notify(`页面最多展示 ${MAX_PANORAMAS} 幅，请先移除一幅影像`)
    return
  }
  const accepted = selected.slice(0, Math.max(0, available))
  const baseIndex = panoramas.value.length
  const uploadedItems = accepted.map((file, index): PanoramaItem => ({
    id: `upload-${Date.now()}-${index}`,
    name: file.name.replace(/\.[^.]+$/, '') || `上传影像 ${baseIndex + index + 1}`,
    tag: `上传影像 ${baseIndex + index + 1}`,
    detail: `${(file.size / 1024 / 1024).toFixed(1)} MB · 本地文件`,
    src: URL.createObjectURL(file),
    fileName: file.name,
    northOffset: 0,
    isObjectUrl: true,
  }))

  panoramas.value.push(...uploadedItems)
  views.value.push(...uploadedItems.map(() => ({ ...activeView.value })))
  activeIndex.value = Math.max(0, baseIndex)

  if (accepted.length < selected.length) {
    notify(`已上传 ${accepted.length} 幅，页面最多展示 ${MAX_PANORAMAS} 幅`)
  } else {
    notify(`已上传 ${accepted.length} 幅全景图片`)
  }
}

function removePanorama(index: number) {
  const [removed] = panoramas.value.splice(index, 1)
  if (removed?.isObjectUrl) URL.revokeObjectURL(removed.src)
  views.value.splice(index, 1)
  viewerRefs.value.splice(index, 1)
  if (index < activeIndex.value) activeIndex.value -= 1
  activeIndex.value = Math.min(activeIndex.value, panoramas.value.length - 1)
  notify('已移除影像')
}

function downloadOriginal(item: PanoramaItem) {
  const anchor = document.createElement('a')
  anchor.href = item.src
  anchor.download = item.fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  notify(`正在下载 ${item.fileName}`)
}

function drawCover(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const sourceRatio = source.width / source.height
  const targetRatio = width / height
  let sx = 0
  let sy = 0
  let sw = source.width
  let sh = source.height

  if (sourceRatio > targetRatio) {
    sw = source.height * targetRatio
    sx = (source.width - sw) / 2
  } else {
    sh = source.width / targetRatio
    sy = (source.height - sh) / 2
  }
  context.drawImage(source, sx, sy, sw, sh, x, y, width, height)
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
}

async function exportComparison() {
  const renderers = viewerRefs.value.slice(0, panoramas.value.length)
  renderers.forEach((viewer) => viewer?.renderNow())
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  const sources = renderers.map((viewer) => viewer?.getCanvas()).filter(Boolean) as HTMLCanvasElement[]
  if (!sources.length) {
    notify('当前没有可导出的全景画面')
    return
  }

  // 统一用 16:9 单元格合成，避免不同屏幕尺寸导致下载结果比例不一致。
  const columns = sources.length === 1 ? 1 : 2
  const rows = Math.ceil(sources.length / columns)
  const cellWidth = 1200
  const cellHeight = 675
  const canvas = document.createElement('canvas')
  canvas.width = cellWidth * columns
  canvas.height = cellHeight * rows
  const context = canvas.getContext('2d')
  if (!context) return

  context.fillStyle = '#0e1418'
  context.fillRect(0, 0, canvas.width, canvas.height)
  sources.forEach((source, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = column * cellWidth
    const y = row * cellHeight
    drawCover(context, source, x, y, cellWidth, cellHeight)

    context.fillStyle = 'rgba(7, 12, 15, 0.74)'
    context.fillRect(x, y + cellHeight - 58, cellWidth, 58)
    context.fillStyle = '#ffffff'
    context.font = '600 22px system-ui, sans-serif'
    context.fillText(panoramas.value[index]?.name ?? `影像 ${index + 1}`, x + 22, y + cellHeight - 23)
    context.fillStyle = '#ffb02e'
    context.font = '600 18px ui-monospace, monospace'
    const view = views.value[index] ?? DEFAULT_VIEW
    context.fillText(
      `AZ ${String(Math.round(view.yaw)).padStart(3, '0')}°  PITCH ${Math.round(view.pitch)}°  FOV ${Math.round(view.fov)}°`,
      x + cellWidth - 390,
      y + cellHeight - 24,
    )
  })

  const blob = await canvasToBlob(canvas)
  if (!blob) {
    notify('对比图生成失败')
    return
  }

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `全景对比-${new Date().toISOString().slice(0, 10)}.jpg`
  anchor.click()
  URL.revokeObjectURL(url)
  notify('对比图已生成')
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen()
  } else {
    await document.documentElement.requestFullscreen()
  }
}

function goBack() {
  if (window.history.length > 1) window.history.back()
  else notify('当前已是起始页面')
}

function handleFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement)
}

onMounted(() => {
  document.addEventListener('fullscreenchange', handleFullscreenChange)
})

onBeforeUnmount(() => {
  window.clearTimeout(toastTimer)
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  releaseObjectUrls(panoramas.value)
})
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="header-brand">
        <button class="icon-button" type="button" title="返回" aria-label="返回" @click="goBack">
          <ArrowLeft :size="19" />
        </button>
        <div class="brand-mark" aria-hidden="true"><ScanLine :size="20" /></div>
        <div class="title-block">
          <h1>全景影像对比</h1>
          <p>桌面端多画面同步查看</p>
        </div>
      </div>

      <div class="header-actions">
        <button type="button" class="primary-action" @click="openFilePicker">
          <Upload :size="17" />
          <span>上传全景</span>
        </button>
        <button class="icon-button" type="button" title="恢复示例" aria-label="恢复示例" @click="resetDemo">
          <RotateCcw :size="17" />
        </button>
        <input
          ref="filePicker"
          class="visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          @change="handleUpload"
        />
      </div>
    </header>

    <div class="context-bar">
      <div class="sync-state" :class="{ muted: !syncEnabled }">
        <span class="status-dot" />
        {{ syncEnabled ? '视角同步中' : '独立视角' }}
      </div>
      <div class="context-divider" />
      <div><Images :size="14" /> {{ panoramas.length }} 幅全景</div>
      <div class="context-spacer" />
      <div>最多 {{ MAX_PANORAMAS }} 幅</div>
    </div>

    <main class="workspace">
      <section class="panorama-grid" :class="gridClass" aria-label="全景影像对比区">
        <PanoramaViewer
          v-for="(panorama, index) in panoramas"
          :key="panorama.id"
          :ref="(element) => setViewerRef(element, index)"
          :image="panorama"
          :view="views[index] ?? DEFAULT_VIEW"
          :index="index"
          :active="activeIndex === index"
          :removable="panoramas.length > 1"
          @activate="activeIndex = index"
          @view-change="(view) => handleViewChange(index, view)"
          @download="downloadOriginal(panorama)"
          @remove="removePanorama(index)"
        />
      </section>
    </main>

    <footer class="app-footer">
      <div class="active-view-label">
        <span>活动画面</span>
        <strong>{{ String(activeIndex + 1).padStart(2, '0') }}</strong>
      </div>

      <div class="view-readout" aria-label="活动画面视角">
        <span>方位 <strong>{{ headingText }}°</strong></span>
        <span>俯仰 <strong>{{ pitchText }}</strong></span>
        <span>视场 <strong>{{ Math.round(activeView.fov) }}°</strong></span>
      </div>

      <div class="footer-actions">
        <button type="button" :class="{ active: syncEnabled }" @click="toggleSync">
          <Link2 v-if="syncEnabled" :size="17" />
          <Unlink v-else :size="17" />
          <span>视角同步</span>
        </button>
        <button type="button" @click="toggleFullscreen">
          <Minimize2 v-if="isFullscreen" :size="17" />
          <Maximize2 v-else :size="17" />
          <span>{{ isFullscreen ? '退出全屏' : '全屏' }}</span>
        </button>
        <button type="button" class="export-button" @click="exportComparison">
          <Download :size="17" />
          <span>保存对比图</span>
        </button>
      </div>
    </footer>

    <Transition name="toast">
      <div v-if="toast" class="toast-message" role="status">
        <CheckCircle2 :size="17" />
        <span>{{ toast }}</span>
      </div>
    </Transition>
  </div>
</template>
