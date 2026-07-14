<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Database,
  Download,
  GalleryHorizontalEnd,
  HardDriveUpload,
  Images,
  Link2,
  LoaderCircle,
  Map,
  Maximize2,
  Minimize2,
  ScanLine,
  Trash2,
  Unlink,
  Upload,
  X,
} from '@lucide/vue'
import OrthophotoMap from './components/OrthophotoMap.vue'
import PanoramaViewer from './components/PanoramaViewer.vue'
import type { PanoramaItem, PanoramaViewerExpose, StoredImageDto, ViewState } from './types/panorama'

const DEFAULT_VIEW: ViewState = { yaw: 0, pitch: -2, fov: 70 }
const MAX_PANORAMAS = 4

const library = ref<PanoramaItem[]>([])
const visibleIds = ref<string[]>([])
const views = ref<ViewState[]>([])
const activeIndex = ref(0)
const selectedMapId = ref<string | null>(null)
const syncEnabled = ref(true)
const workspaceMode = ref<'panorama' | 'orthophoto'>('panorama')
const libraryOpen = ref(false)
const loadingCatalog = ref(true)
const uploading = ref(false)
const isFullscreen = ref(false)
const filePicker = ref<HTMLInputElement | null>(null)
const viewerRefs = ref<Array<PanoramaViewerExpose | null>>([])
const toast = ref('')
let toastTimer = 0

const panoramas = computed(() =>
  visibleIds.value.map((id) => library.value.find((item) => item.id === id)).filter(Boolean) as PanoramaItem[],
)
const activeView = computed(() => views.value[activeIndex.value] ?? DEFAULT_VIEW)
const activePanorama = computed(() => panoramas.value[activeIndex.value] ?? null)
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

// 后端接口使用 snake_case；进入 Vue 状态前统一转成 camelCase，模板里就不需要关心接口字段格式。
function fromDto(item: StoredImageDto): PanoramaItem {
  return {
    id: item.id,
    name: item.name,
    tag: item.orthophoto_status === 'ready' ? '全景 · 地面反投影已生成' : '全景影像',
    detail: `${item.width} × ${item.height} · ${(item.file_size / 1024 / 1024).toFixed(1)} MB`,
    src: item.image_url,
    fileName: item.file_name,
    northOffset: item.north_offset,
    downloadUrl: item.download_url,
    createdAt: item.created_at,
    latitude: item.latitude,
    longitude: item.longitude,
    absoluteAltitude: item.absolute_altitude,
    relativeAltitude: item.relative_altitude,
    projectionAltitude: item.projection_altitude,
    heading: item.heading,
    orthophotoStatus: item.orthophoto_status,
    orthophotoKind: item.orthophoto_kind,
    orthophotoUrl: item.orthophoto_url,
    overlayBounds: item.overlay_bounds,
    nearbyIds: item.nearby_ids,
  }
}

function setViewerRef(element: unknown, index: number) {
  viewerRefs.value[index] = (element as PanoramaViewerExpose | null) ?? null
}

function notify(message: string) {
  toast.value = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 2800)
}

async function responseJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  const payload = await response.json().catch(() => null)
  throw new Error(payload?.detail ?? `请求失败（${response.status}）`)
}

// 影像库变化后重建当前对比区的视角数组，避免删除/上传后出现视角和影像错位。
function rebuildViews() {
  const source = views.value[activeIndex.value] ?? DEFAULT_VIEW
  views.value = panoramas.value.map(() => ({ ...source }))
  viewerRefs.value = []
  activeIndex.value = Math.min(activeIndex.value, Math.max(0, panoramas.value.length - 1))
  if (!selectedMapId.value || !library.value.some((item) => item.id === selectedMapId.value)) {
    selectedMapId.value = panoramas.value[0]?.id ?? library.value[0]?.id ?? null
  }
}

async function loadCatalog(initial = false) {
  try {
    const response = await fetch('/api/images')
    library.value = (await responseJson<StoredImageDto[]>(response)).map(fromDto)
    if (initial) visibleIds.value = library.value.slice(0, MAX_PANORAMAS).map((item) => item.id)
    else visibleIds.value = visibleIds.value.filter((id) => library.value.some((item) => item.id === id))
    rebuildViews()
  } catch (error) {
    notify(error instanceof Error ? error.message : '无法连接影像服务')
  } finally {
    loadingCatalog.value = false
  }
}

// 同步开启时，任一画面的变化都会广播给当前比较区的全部查看器。
function handleViewChange(index: number, view: ViewState) {
  activeIndex.value = index
  selectedMapId.value = panoramas.value[index]?.id ?? selectedMapId.value
  if (syncEnabled.value) views.value = views.value.map(() => ({ ...view }))
  else views.value[index] = { ...view }
}

function toggleSync() {
  syncEnabled.value = !syncEnabled.value
  if (syncEnabled.value) {
    const source = { ...activeView.value }
    views.value = views.value.map(() => ({ ...source }))
    notify('已同步到当前活动视角')
  } else notify('已切换为独立视角')
}

function openFilePicker() {
  filePicker.value?.click()
}

async function handleUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const selected = Array.from(input.files ?? []).filter((file) => file.type.startsWith('image/'))
  input.value = ''
  if (!selected.length) {
    notify('未选择可用的图片文件')
    return
  }

  uploading.value = true
  const form = new FormData()
  selected.forEach((file) => form.append('files', file))
  try {
    // 上传后端会保存原图、提取大疆元数据，并生成可叠加到天地图的地面反投影结果。
    const uploaded = await responseJson<StoredImageDto[]>(
      await fetch('/api/images', { method: 'POST', body: form }),
    )
    const uploadedIds = uploaded.map((item) => item.id)
    await loadCatalog(false)
    visibleIds.value = [...uploadedIds, ...visibleIds.value.filter((id) => !uploadedIds.includes(id))].slice(
      0,
      MAX_PANORAMAS,
    )
    selectedMapId.value = uploadedIds[0] ?? selectedMapId.value
    rebuildViews()
    notify(`已永久保存 ${uploaded.length} 幅影像${selected.length > MAX_PANORAMAS ? '，其余可在影像库中选择' : ''}`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '上传失败')
  } finally {
    uploading.value = false
  }
}

function toggleLibraryItem(id: string) {
  if (visibleIds.value.includes(id)) {
    visibleIds.value = visibleIds.value.filter((visibleId) => visibleId !== id)
  } else if (visibleIds.value.length >= MAX_PANORAMAS) {
    notify(`对比区最多显示 ${MAX_PANORAMAS} 幅影像`)
    return
  } else visibleIds.value.push(id)
  rebuildViews()
}

function removePanorama(index: number) {
  const item = panoramas.value[index]
  if (!item) return
  visibleIds.value = visibleIds.value.filter((id) => id !== item.id)
  rebuildViews()
  notify('已移出当前对比，原文件仍保留在影像库')
}

async function permanentlyDelete(item: PanoramaItem) {
  if (!window.confirm(`永久删除“${item.name}”及其生成结果？`)) return
  try {
    await responseJson<{ deleted: boolean }>(await fetch(`/api/images/${item.id}`, { method: 'DELETE' }))
    await loadCatalog(false)
    notify('影像文件已永久删除')
  } catch (error) {
    notify(error instanceof Error ? error.message : '删除失败')
  }
}

function downloadOriginal(item: PanoramaItem) {
  const anchor = document.createElement('a')
  anchor.href = item.downloadUrl
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
  // 导出对比图时按 cover 方式裁切每个 WebGL 画面，保持网格统一比例。
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
  if (workspaceMode.value !== 'panorama') {
    notify('请在全景视图中保存当前对比画面')
    return
  }
  // 先强制每个 Three.js 查看器渲染当前帧，再从 canvas 读取像素生成下载图。
  const renderers = viewerRefs.value.slice(0, panoramas.value.length)
  renderers.forEach((viewer) => viewer?.renderNow())
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const sources = renderers.map((viewer) => viewer?.getCanvas()).filter(Boolean) as HTMLCanvasElement[]
  if (!sources.length) {
    notify('当前没有可导出的全景画面')
    return
  }

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
    const x = (index % columns) * cellWidth
    const y = Math.floor(index / columns) * cellHeight
    drawCover(context, source, x, y, cellWidth, cellHeight)
    context.fillStyle = 'rgba(7, 12, 15, 0.74)'
    context.fillRect(x, y + cellHeight - 58, cellWidth, 58)
    context.fillStyle = '#fff'
    context.font = '600 22px system-ui, sans-serif'
    context.fillText(panoramas.value[index]?.name ?? `影像 ${index + 1}`, x + 22, y + cellHeight - 23)
  })

  const blob = await canvasToBlob(canvas)
  if (!blob) return notify('对比图生成失败')
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `全景对比-${new Date().toISOString().slice(0, 10)}.jpg`
  anchor.click()
  URL.revokeObjectURL(url)
  notify('对比图已生成')
}

async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen()
  else await document.documentElement.requestFullscreen()
}

function goBack() {
  if (window.history.length > 1) window.history.back()
  else notify('当前已是起始页面')
}

function selectMapImage(id: string) {
  selectedMapId.value = id
  const index = panoramas.value.findIndex((item) => item.id === id)
  if (index >= 0) activeIndex.value = index
}

function handleFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement)
}

onMounted(() => {
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  void loadCatalog(true)
})

onBeforeUnmount(() => {
  window.clearTimeout(toastTimer)
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
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
          <h1>无人机全景影像工作台</h1>
          <p>全景对比 · 地面反投影 · 天地图叠加</p>
        </div>
      </div>

      <div class="workspace-switch" aria-label="工作模式">
        <button
          type="button"
          :class="{ active: workspaceMode === 'panorama' }"
          @click="workspaceMode = 'panorama'"
        >
          <GalleryHorizontalEnd :size="16" /> 全景视图
        </button>
        <button
          type="button"
          :class="{ active: workspaceMode === 'orthophoto' }"
          @click="workspaceMode = 'orthophoto'"
        >
          <Map :size="16" /> 正射地图
        </button>
      </div>

      <div class="header-actions">
        <button type="button" @click="libraryOpen = !libraryOpen">
          <Database :size="17" />
          <span>影像库</span>
          <small>{{ library.length }}</small>
        </button>
        <button type="button" class="primary-action" :disabled="uploading" @click="openFilePicker">
          <LoaderCircle v-if="uploading" class="spinner" :size="17" />
          <Upload v-else :size="17" />
          <span>{{ uploading ? '保存并处理' : '上传全景' }}</span>
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
      <div class="sync-state" :class="{ muted: workspaceMode !== 'panorama' || !syncEnabled }">
        <span class="status-dot" />
        {{ workspaceMode === 'panorama' ? (syncEnabled ? '视角同步中' : '独立视角') : '天地图影像底图' }}
      </div>
      <div class="context-divider" />
      <div><Images :size="14" /> 当前 {{ panoramas.length }} 幅</div>
      <div class="context-divider" />
      <div><HardDriveUpload :size="14" /> 文件永久保存</div>
      <div class="context-spacer" />
      <div>{{ workspaceMode === 'orthophoto' ? '20 米内自动归为同位置候选' : `最多 ${MAX_PANORAMAS} 幅同步对比` }}</div>
    </div>

    <main class="workspace">
      <div v-if="loadingCatalog" class="workspace-state">
        <LoaderCircle class="spinner" :size="28" />
        <strong>正在读取影像库</strong>
      </div>

      <div v-else-if="library.length === 0" class="workspace-state empty-state">
        <div><Upload :size="30" /></div>
        <strong>影像库为空</strong>
        <span>上传大疆 2:1 全景图后，服务器会永久保存原图并生成地面反投影预览</span>
        <button type="button" :disabled="uploading" @click="openFilePicker">选择全景图片</button>
      </div>

      <template v-else-if="workspaceMode === 'panorama'">
        <div v-if="panoramas.length === 0" class="workspace-state empty-state">
          <div><Images :size="30" /></div>
          <strong>当前对比区为空</strong>
          <span>从影像库选择 1 至 {{ MAX_PANORAMAS }} 幅影像</span>
          <button type="button" @click="libraryOpen = true">打开影像库</button>
        </div>
        <section v-else class="panorama-grid" :class="gridClass" aria-label="全景影像对比区">
          <PanoramaViewer
            v-for="(panorama, index) in panoramas"
            :key="panorama.id"
            :ref="(element) => setViewerRef(element, index)"
            :image="panorama"
            :view="views[index] ?? DEFAULT_VIEW"
            :index="index"
            :active="activeIndex === index"
            :removable="true"
            @activate="activeIndex = index; selectedMapId = panorama.id"
            @view-change="(view) => handleViewChange(index, view)"
            @download="downloadOriginal(panorama)"
            @remove="removePanorama(index)"
          />
        </section>
      </template>

      <OrthophotoMap
        v-else
        :images="library"
        :selected-id="selectedMapId ?? library[0]?.id ?? null"
        @select="selectMapImage"
      />

      <Transition name="drawer">
        <aside v-if="libraryOpen" class="library-drawer" aria-label="永久影像库">
          <div class="library-heading">
            <div>
              <strong>永久影像库</strong>
              <span>{{ library.length }} 幅已保存影像</span>
            </div>
            <button type="button" title="关闭影像库" aria-label="关闭影像库" @click="libraryOpen = false">
              <X :size="18" />
            </button>
          </div>
          <div class="library-list">
            <article v-for="item in library" :key="item.id" :class="{ selected: visibleIds.includes(item.id) }">
              <img :src="item.orthophotoUrl ?? item.src" :alt="item.name" />
              <div class="library-item-info">
                <strong>{{ item.name }}</strong>
                <span>{{ item.detail }}</span>
                <small>{{ item.latitude === null ? '无 GPS' : 'GPS 已提取' }} · {{ item.orthophotoStatus === 'ready' ? '地面反投影就绪' : '无反投影预览' }}</small>
              </div>
              <div class="library-item-actions">
                <button
                  type="button"
                  :class="{ active: visibleIds.includes(item.id) }"
                  :title="visibleIds.includes(item.id) ? '移出当前对比' : '加入当前对比'"
                  :aria-label="visibleIds.includes(item.id) ? '移出当前对比' : '加入当前对比'"
                  @click="toggleLibraryItem(item.id)"
                >
                  <Check v-if="visibleIds.includes(item.id)" :size="16" />
                  <Images v-else :size="16" />
                </button>
                <button type="button" title="下载原图" aria-label="下载原图" @click="downloadOriginal(item)">
                  <Download :size="16" />
                </button>
                <button type="button" class="danger" title="永久删除" aria-label="永久删除" @click="permanentlyDelete(item)">
                  <Trash2 :size="16" />
                </button>
              </div>
            </article>
          </div>
        </aside>
      </Transition>
    </main>

    <footer class="app-footer">
      <div class="active-view-label">
        <span>{{ workspaceMode === 'panorama' ? '活动画面' : '当前覆盖层' }}</span>
        <strong>{{ activePanorama ? String(activeIndex + 1).padStart(2, '0') : '--' }}</strong>
      </div>

      <div v-if="workspaceMode === 'panorama'" class="view-readout" aria-label="活动画面视角">
        <span>方位 <strong>{{ headingText }}°</strong></span>
        <span>俯仰 <strong>{{ pitchText }}</strong></span>
        <span>视场 <strong>{{ Math.round(activeView.fov) }}°</strong></span>
      </div>
      <div v-else class="map-readout">
        <span>覆盖类型</span>
        <strong>500 m × 500 m</strong>
        <small>非测绘正射成果</small>
      </div>

      <div class="footer-actions">
        <button v-if="workspaceMode === 'panorama'" type="button" :class="{ active: syncEnabled }" @click="toggleSync">
          <Link2 v-if="syncEnabled" :size="17" />
          <Unlink v-else :size="17" />
          <span>视角同步</span>
        </button>
        <button type="button" @click="toggleFullscreen">
          <Minimize2 v-if="isFullscreen" :size="17" />
          <Maximize2 v-else :size="17" />
          <span>{{ isFullscreen ? '退出全屏' : '全屏' }}</span>
        </button>
        <button type="button" class="export-button" :disabled="panoramas.length === 0" @click="exportComparison">
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
