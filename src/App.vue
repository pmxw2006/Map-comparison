<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  CircleAlert,
  Database,
  Download,
  Eye,
  EyeOff,
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
import PanoramaViewer from './components/PanoramaViewer.vue'
import { formatHeading, groundPointToView, normalizeDegrees, signedDegrees } from './geometry'
import type {
  CatalogResponse,
  ImageRecord,
  LatLng,
  MapRegion,
  PanoramaViewerExpose,
  ViewState,
} from './types/panorama'

const OrthophotoMap = defineAsyncComponent(() => import('./components/OrthophotoMap.vue'))

const DEFAULT_VIEW: ViewState = { yaw: 0, pitch: -2, fov: 70 }
const MAX_PANORAMAS = 4
const REGION_STORAGE_KEY = 'duibi.mapRegions'

const library = ref<ImageRecord[]>([])
const visibleIds = ref<string[]>([])
const orthophotoVisibleIds = ref<string[]>([])
const regions = ref<MapRegion[]>(loadStoredRegions())
const viewsById = ref<Record<string, ViewState>>({})
const activeImageId = ref<string | null>(null)
const syncEnabled = ref(true)
const workspaceMode = ref<'panorama' | 'orthophoto'>('panorama')
const libraryOpen = ref(false)
const loadingCatalog = ref(true)
const catalogError = ref('')
const uploading = ref(false)
const isFullscreen = ref(false)
const filePicker = ref<HTMLInputElement | null>(null)
const viewerRefs = ref<Record<string, PanoramaViewerExpose | null>>({})
const toast = ref<{ message: string; kind: 'success' | 'error' } | null>(null)
let toastTimer = 0

const panoramas = computed(() =>
  visibleIds.value.map((id) => library.value.find((item) => item.id === id)).filter(Boolean) as ImageRecord[],
)
const activeIndex = computed(() => Math.max(0, visibleIds.value.indexOf(activeImageId.value ?? '')))
const activePanorama = computed(() => library.value.find((item) => item.id === activeImageId.value) ?? null)
const activeView = computed(() => viewFor(activeImageId.value))
const mapSelectedId = computed(() => activeImageId.value ?? library.value[0]?.id ?? null)
const pitchText = computed(() => {
  const pitch = Math.round(activeView.value.pitch)
  return `${pitch > 0 ? '+' : ''}${pitch}°`
})
const headingText = computed(() => formatHeading(activeView.value.yaw + (activePanorama.value?.northOffset ?? 0)))
const gridClass = computed(() => `count-${Math.min(panoramas.value.length, MAX_PANORAMAS)}`)
const visibleRegionCount = computed(() => regions.value.filter((region) => region.visible).length)

function loadStoredRegions(): MapRegion[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REGION_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => Array.isArray(item?.points) && item.points.length >= 3)
      .map((item, index) => ({
        id: String(item.id ?? `region-${index + 1}`),
        name: String(item.name ?? `区域 ${index + 1}`),
        color: typeof item.color === 'string' ? item.color : '#ff4d4f',
        opacity: Number.isFinite(item.opacity) ? Math.min(0.9, Math.max(0.05, Number(item.opacity))) : 0.35,
        visible: item.visible !== false,
        points: item.points
          .filter((point: unknown) => Array.isArray(point) && point.length >= 2)
          .map((point: [number, number]) => [Number(point[0]), Number(point[1])] as LatLng)
          .filter((point: LatLng) => Number.isFinite(point[0]) && Number.isFinite(point[1])),
      }))
      .filter((item) => item.points.length >= 3)
  } catch {
    return []
  }
}

function imageDetail(item: ImageRecord) {
  return `${item.width} × ${item.height} · ${(item.fileSize / 1024 / 1024).toFixed(1)} MB`
}

function setViewerRef(id: string, element: unknown) {
  viewerRefs.value[id] = (element as PanoramaViewerExpose | null) ?? null
}

function notify(message: string, kind: 'success' | 'error' = 'success') {
  toast.value = { message, kind }
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = null), kind === 'error' ? 5000 : 2800)
}

async function responseJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  const payload = await response.json().catch(() => null)
  throw new Error(payload?.detail ?? `请求失败（${response.status}）`)
}

function viewFor(id: string | null): ViewState {
  return id ? viewsById.value[id] ?? DEFAULT_VIEW : DEFAULT_VIEW
}

function viewAtSameBearing(sourceId: string | null, targetId: string, view: ViewState): ViewState {
  const source = library.value.find((item) => item.id === sourceId)
  const target = library.value.find((item) => item.id === targetId)
  if (!source || !target) return { ...view }

  // yaw 属于单张影像；同步时先还原真实罗盘方位，再换算为目标影像的局部 yaw。
  return { ...view, yaw: normalizeDegrees(view.yaw + source.northOffset - target.northOffset) }
}

function sameLocation(first: ImageRecord, second: ImageRecord) {
  if (first.id === second.id) return true
  return first.nearbyIds.includes(second.id) || second.nearbyIds.includes(first.id)
}

// 同位置组以用户选中的影像为锚点，与地图展示的 nearbyIds 规则保持一致。
function comparableGroup(anchorId: string | null) {
  const anchor = library.value.find((item) => item.id === anchorId) ?? library.value[0]
  if (!anchor) return []
  return [anchor, ...library.value.filter((item) => item.id !== anchor.id && sameLocation(anchor, item))]
    .slice(0, MAX_PANORAMAS)
    .map((item) => item.id)
}

function sanitizeVisibleIds(ids: string[]) {
  const existing = ids.map((id) => library.value.find((item) => item.id === id)).filter(Boolean) as ImageRecord[]
  if (!existing.length) return []
  return existing.filter((item) => sameLocation(existing[0], item)).slice(0, MAX_PANORAMAS).map((item) => item.id)
}

function libraryPanoramaActionLabel(item: ImageRecord) {
  if (visibleIds.value.includes(item.id)) return '移出当前对比'
  if (panoramas.value[0] && !sameLocation(panoramas.value[0], item)) return '切换到该位置'
  if (visibleIds.value.length >= MAX_PANORAMAS) return '替换当前影像'
  return '加入当前对比'
}

function sanitizeOrthophotoVisibleIds(ids: string[]) {
  const existing = new Set(library.value.map((item) => item.id))
  const unique = [...new Set(ids)].filter((id) => existing.has(id))
  if (unique.length) return unique
  const fallback = library.value.find((item) => item.id === activeImageId.value) ?? library.value[0]
  return fallback ? [fallback.id] : []
}

// 影像 ID 是状态主键；增删或重新排序不会再把视角错配到另一幅影像。
function setComparison(ids: string[], focusId: string | null = null) {
  const nextIds = sanitizeVisibleIds(ids)
  const nextActiveId = focusId && nextIds.includes(focusId) ? focusId : nextIds[0] ?? null
  const sourceId = library.value.some((item) => item.id === activeImageId.value) ? activeImageId.value : nextActiveId
  const source = { ...viewFor(sourceId) }
  const nextViews = { ...viewsById.value }
  for (const id of nextIds) {
    if (syncEnabled.value) nextViews[id] = viewAtSameBearing(sourceId, id, source)
    else if (!nextViews[id]) nextViews[id] = { ...source }
  }
  visibleIds.value = nextIds
  viewsById.value = nextViews
  activeImageId.value = nextActiveId
  if (nextActiveId) bringOrthophotoLayerToTop(nextActiveId)
}

function selectForComparison(id: string) {
  if (!library.value.some((item) => item.id === id)) return
  setComparison(comparableGroup(id), id)
}

function activatePanorama(id: string) {
  if (!visibleIds.value.includes(id)) {
    selectForComparison(id)
    return
  }
  activeImageId.value = id
  if (syncEnabled.value) {
    const source = { ...viewFor(id) }
    viewsById.value = {
      ...viewsById.value,
      ...Object.fromEntries(visibleIds.value.map((visibleId) => [visibleId, viewAtSameBearing(id, visibleId, source)])),
    }
  }
  bringOrthophotoLayerToTop(id)
}

function removeFromComparison(id: string) {
  const nextIds = visibleIds.value.filter((current) => current !== id)
  const nextFocus = activeImageId.value === id ? nextIds[0] ?? null : activeImageId.value
  setComparison(nextIds, nextFocus)
}

function applyCatalog(payload: CatalogResponse, focusId: string | null = null) {
  library.value = payload.images
  const existing = new Set(payload.images.map((item) => item.id))
  const retained = sanitizeVisibleIds(visibleIds.value)
  if (retained.length) setComparison(retained, activeImageId.value)
  else if (library.value.length) setComparison(comparableGroup(focusId ?? library.value[0].id), focusId)
  else setComparison([])

  // 先用旧活动视角安置剩余画面，再清除已删除 ID，避免删除活动影像时视角跳回默认值。
  viewsById.value = Object.fromEntries(Object.entries(viewsById.value).filter(([id]) => existing.has(id)))
  if (focusId) {
    activeImageId.value = focusId
    selectForComparison(focusId)
  }
  orthophotoVisibleIds.value = sanitizeOrthophotoVisibleIds(orthophotoVisibleIds.value)
}

async function loadCatalog() {
  loadingCatalog.value = true
  catalogError.value = ''
  try {
    applyCatalog(await responseJson<CatalogResponse>(await fetch('/api/images')))
  } catch (error) {
    catalogError.value = error instanceof Error ? error.message : '无法连接影像服务'
    notify(catalogError.value, 'error')
  } finally {
    loadingCatalog.value = false
  }
}

// 同步开启时，任一画面的变化都会按真实罗盘方位广播给全部查看器。
function handleViewChange(id: string, view: ViewState) {
  activeImageId.value = id
  if (syncEnabled.value) {
    viewsById.value = {
      ...viewsById.value,
      ...Object.fromEntries(
        visibleIds.value.map((visibleId) => [visibleId, viewAtSameBearing(id, visibleId, view)]),
      ),
    }
  } else viewsById.value = { ...viewsById.value, [id]: { ...view } }
}

function toggleSync() {
  syncEnabled.value = !syncEnabled.value
  if (syncEnabled.value) {
    const sourceId = activeImageId.value
    const source = { ...activeView.value }
    viewsById.value = {
      ...viewsById.value,
      ...Object.fromEntries(visibleIds.value.map((id) => [id, viewAtSameBearing(sourceId, id, source)])),
    }
    notify('已同步到当前活动视角')
  } else notify('已切换为独立视角')
}

function openFilePicker() {
  filePicker.value?.click()
}

async function handleUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const selected = Array.from(input.files ?? [])
  input.value = ''
  if (!selected.length) {
    notify('未选择可用的图片文件')
    return
  }

  uploading.value = true
  const form = new FormData()
  selected.forEach((file) => form.append('files', file))
  try {
    const payload = await responseJson<CatalogResponse>(
      await fetch('/api/images', { method: 'POST', body: form }),
    )
    const focusId = payload.changedIds[0] ?? null
    applyCatalog(payload, focusId)
    orthophotoVisibleIds.value = sanitizeOrthophotoVisibleIds([
      ...orthophotoVisibleIds.value,
      ...payload.changedIds,
    ])
    if (focusId) bringOrthophotoLayerToTop(focusId)
    notify(`已永久保存 ${payload.changedIds.length} 幅影像${selected.length > MAX_PANORAMAS ? '，其余可在影像库中选择' : ''}`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '上传失败', 'error')
  } finally {
    uploading.value = false
  }
}

function toggleLibraryItem(id: string) {
  if (visibleIds.value.includes(id)) removeFromComparison(id)
  else selectForComparison(id)
}

function removePanorama(index: number) {
  const item = panoramas.value[index]
  if (!item) return
  removeFromComparison(item.id)
  notify('已移出当前对比，原文件仍保留在影像库')
}

async function permanentlyDelete(item: ImageRecord) {
  if (!window.confirm(`永久删除“${item.name}”及其生成结果？`)) return
  try {
    applyCatalog(await responseJson<CatalogResponse>(await fetch(`/api/images/${item.id}`, { method: 'DELETE' })))
    notify('影像文件已永久删除')
  } catch (error) {
    notify(error instanceof Error ? error.message : '删除失败', 'error')
  }
}

function triggerDownload(url: string, filename: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
}

function downloadOriginal(item: ImageRecord) {
  triggerDownload(item.downloadUrl, item.fileName)
  notify(`正在下载 ${item.fileName}`)
}

function downloadOrthophoto(item: ImageRecord, format: 'jpg' | 'tif' | 'tiff' | 'mbtiles' = 'jpg') {
  const downloads = {
    jpg: item.orthophotoDownloadUrl,
    tif: item.orthophotoTifDownloadUrl,
    tiff: item.orthophotoTiffDownloadUrl,
    mbtiles: item.orthophotoMbtilesDownloadUrl,
  }
  triggerDownload(downloads[format], `${item.name}-orthophoto.${format}`)
  notify(`正在下载 ${item.name} 正射图（.${format}）`)
}

function toggleOrthophotoLayer(id: string) {
  if (orthophotoVisibleIds.value.includes(id)) {
    orthophotoVisibleIds.value = orthophotoVisibleIds.value.filter((visibleId) => visibleId !== id)
  } else {
    orthophotoVisibleIds.value = sanitizeOrthophotoVisibleIds([...orthophotoVisibleIds.value, id])
  }
}

function bringOrthophotoLayerToTop(id: string) {
  if (!library.value.some((entry) => entry.id === id)) return

  // Leaflet 按数组后面的图层给更高 z-index；重新放到末尾即可置顶。
  orthophotoVisibleIds.value = sanitizeOrthophotoVisibleIds([
    ...orthophotoVisibleIds.value.filter((visibleId) => visibleId !== id),
    id,
  ])
}

function regionCenter(region: MapRegion): LatLng | null {
  if (!region.points.length) return null
  const sum = region.points.reduce(
    (total, point) => [total[0] + point[0], total[1] + point[1]] as LatLng,
    [0, 0] as LatLng,
  )
  return [sum[0] / region.points.length, sum[1] / region.points.length]
}

function viewTowardPoint(image: ImageRecord, point: LatLng, fallback: ViewState): ViewState {
  const target = groundPointToView(image, point)
  return {
    yaw: target.yaw,
    pitch: Math.max(-82, Math.min(12, target.pitch)),
    fov: Math.min(78, Math.max(58, fallback.fov)),
  }
}

function focusRegionOnPanoramas(region: MapRegion) {
  const center = regionCenter(region)
  const anchorId = mapSelectedId.value
  if (anchorId) selectForComparison(anchorId)
  if (!center || panoramas.value.length === 0) return
  viewsById.value = {
    ...viewsById.value,
    ...Object.fromEntries(panoramas.value.map((image) => [image.id, viewTowardPoint(image, center, viewFor(image.id))])),
  }
  notify('区域已保存，全景视角已对准该区域')
}

function addRegion(region: MapRegion) {
  regions.value = [...regions.value, region]
  focusRegionOnPanoramas(region)
}

function updateRegion(id: string, patch: Partial<MapRegion>) {
  regions.value = regions.value.map((region) => (region.id === id ? { ...region, ...patch } : region))
}

function deleteRegion(id: string) {
  regions.value = regions.value.filter((region) => region.id !== id)
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function kmlColor(color: string, opacity: number) {
  const value = color.replace('#', '')
  const normalized = value.length === 3 ? value.split('').map((char) => char + char).join('') : value
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0')
  const red = normalized.slice(0, 2)
  const green = normalized.slice(2, 4)
  const blue = normalized.slice(4, 6)
  return `${alpha}${blue}${green}${red}`
}

function regionsToKml(items: MapRegion[]) {
  const placemarks = items.map((region) => {
    const points = [...region.points, region.points[0]]
    const coordinates = points.map(([lat, lng]) => `${lng},${lat},0`).join(' ')
    return `<Placemark><name>${escapeXml(region.name)}</name><Style><LineStyle><color>ff${kmlColor(region.color, 1).slice(2)}</color><width>2</width></LineStyle><PolyStyle><color>${kmlColor(region.color, region.opacity)}</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>${coordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`
  }).join('')
  const name = items.length === 1 ? escapeXml(items[0].name) : '区域图层'
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name>${placemarks}</Document></kml>`
}

function downloadText(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/vnd.google-earth.kml+xml' }))
  triggerDownload(url, filename)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function exportRegion(region: MapRegion) {
  downloadText(`${region.name}.kml`, regionsToKml([region]))
}

function exportVisibleRegions() {
  const visibleRegions = regions.value.filter((region) => region.visible && region.points.length >= 3)
  if (!visibleRegions.length) {
    notify('当前没有可导出的可见区域')
    return
  }
  downloadText('区域图层.kml', regionsToKml(visibleRegions))
}

function hexToRgba(color: string, opacity: number) {
  const value = color.replace('#', '')
  const normalized = value.length === 3 ? value.split('').map((char) => char + char).join('') : value
  const numeric = Number.parseInt(normalized, 16)
  if (!Number.isFinite(numeric)) return `rgba(255, 77, 79, ${opacity})`
  return `rgba(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${numeric & 255}, ${opacity})`
}

function projectRegionPoint(
  image: ImageRecord,
  view: ViewState,
  point: LatLng,
  width: number,
  height: number,
) {
  const target = groundPointToView(image, point)
  const deltaYaw = signedDegrees(target.yaw - view.yaw)
  if (Math.abs(deltaYaw) > 88) return null

  const verticalFov = (view.fov * Math.PI) / 180
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * (width / height))
  const x = width / 2 + (Math.tan((deltaYaw * Math.PI) / 180) / Math.tan(horizontalFov / 2)) * (width / 2)
  const y =
    height / 2 -
    (Math.tan(((target.pitch - view.pitch) * Math.PI) / 180) / Math.tan(verticalFov / 2)) * (height / 2)
  return { x, y }
}

function drawRegionsOnExport(
  context: CanvasRenderingContext2D,
  image: ImageRecord,
  view: ViewState,
  cover: ReturnType<typeof drawCover>,
) {
  for (const region of regions.value.filter((item) => item.visible && item.points.length >= 3)) {
    const points = region.points
      .map((point) => projectRegionPoint(image, view, point, cover.sourceWidth, cover.sourceHeight))
      .filter(Boolean) as Array<{ x: number; y: number }>
    if (points.length < 3) continue
    const transformed = points.map((point) => ({
      x: ((point.x - cover.sx) * cover.width) / cover.sw,
      y: ((point.y - cover.sy) * cover.height) / cover.sh,
    }))
    context.save()
    context.translate(cover.x, cover.y)
    context.beginPath()
    context.rect(0, 0, cover.width, cover.height)
    context.clip()
    context.beginPath()
    transformed.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y)
      else context.lineTo(point.x, point.y)
    })
    context.closePath()
    context.fillStyle = hexToRgba(region.color, region.opacity)
    context.strokeStyle = region.color
    context.lineWidth = 4
    context.fill()
    context.stroke()
    transformed.forEach((point) => {
      context.beginPath()
      context.arc(point.x, point.y, 9, 0, Math.PI * 2)
      context.fillStyle = region.color
      context.strokeStyle = '#fff'
      context.lineWidth = 3
      context.fill()
      context.stroke()
    })
    context.restore()
  }
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
  return { sourceWidth: source.width, sourceHeight: source.height, sx, sy, sw, sh, x, y, width, height }
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
}

async function exportComparison() {
  if (workspaceMode.value !== 'panorama') {
    notify('请在全景视图中保存当前对比画面')
    return
  }
  const entries = panoramas.value
    .map((image) => ({ image, viewer: viewerRefs.value[image.id] }))
    .filter((entry) => entry.viewer?.getCanvas())
  if (!entries.length) {
    notify('当前没有可导出的全景画面')
    return
  }

  const columns = entries.length === 1 ? 1 : 2
  const rows = Math.ceil(entries.length / columns)
  const cellWidth = 1200
  const cellHeight = 675
  const canvas = document.createElement('canvas')
  canvas.width = cellWidth * columns
  canvas.height = cellHeight * rows
  const context = canvas.getContext('2d')
  if (!context) return
  context.fillStyle = '#0e1418'
  context.fillRect(0, 0, canvas.width, canvas.height)
  entries.forEach(({ image, viewer }, index) => {
    // 默认 WebGL 缓冲区只保证当前调用栈可读，因此渲染后立即复制到导出画布。
    viewer?.renderNow()
    const source = viewer?.getCanvas()
    if (!source) return
    const x = (index % columns) * cellWidth
    const y = Math.floor(index / columns) * cellHeight
    const cover = drawCover(context, source, x, y, cellWidth, cellHeight)
    drawRegionsOnExport(context, image, viewFor(image.id), cover)
    context.fillStyle = 'rgba(7, 12, 15, 0.74)'
    context.fillRect(x, y + cellHeight - 58, cellWidth, 58)
    context.fillStyle = '#fff'
    context.font = '600 22px system-ui, sans-serif'
    context.fillText(image.name, x + 22, y + cellHeight - 23)
  })

  const blob = await canvasToBlob(canvas)
  if (!blob) return notify('对比图生成失败')
  const url = URL.createObjectURL(blob)
  triggerDownload(url, `全景对比-${new Date().toISOString().slice(0, 10)}.jpg`)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  notify('对比图已生成')
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    notify('浏览器拒绝了全屏请求', 'error')
  }
}

function goBack() {
  if (window.history.length > 1) window.history.back()
  else notify('当前已是起始页面')
}

function selectMapImage(id: string) {
  selectForComparison(id)
}

function handleFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement)
}

onMounted(() => {
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  void loadCatalog()
})

onBeforeUnmount(() => {
  window.clearTimeout(toastTimer)
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
})

watch(
  regions,
  (value) => window.localStorage.setItem(REGION_STORAGE_KEY, JSON.stringify(value)),
  { deep: true },
)
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
      <div>
        {{
          workspaceMode === 'orthophoto'
            ? `正射图层 ${orthophotoVisibleIds.length} 个 · 区域 ${visibleRegionCount} 个`
            : `仅支持 20 米内同位置对比，最多 ${MAX_PANORAMAS} 幅`
        }}
      </div>
    </div>

    <main class="workspace">
      <div v-if="loadingCatalog" class="workspace-state">
        <LoaderCircle class="spinner" :size="28" />
        <strong>正在读取影像库</strong>
      </div>

      <div v-else-if="catalogError" class="workspace-state empty-state error-state">
        <div><CircleAlert :size="30" /></div>
        <strong>无法读取影像库</strong>
        <span>{{ catalogError }}</span>
        <button type="button" @click="loadCatalog">重新连接</button>
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
            :ref="(element) => setViewerRef(panorama.id, element)"
            :image="panorama"
            :view="viewFor(panorama.id)"
            :index="index"
            :active="activeIndex === index"
            :regions="regions"
            @activate="activatePanorama(panorama.id)"
            @focus-comparison="selectForComparison(panorama.id)"
            @view-change="(view) => handleViewChange(panorama.id, view)"
            @region-create="addRegion"
            @notice="notify"
            @remove="removePanorama(index)"
          />
        </section>
      </template>

      <OrthophotoMap
        v-else
        :images="library"
        :selected-id="mapSelectedId"
        :visible-orthophoto-ids="orthophotoVisibleIds"
        :regions="regions"
        @select="selectMapImage"
        @toggle-orthophoto="toggleOrthophotoLayer"
        @region-create="addRegion"
        @region-update="updateRegion"
        @region-delete="deleteRegion"
      />

      <Transition name="drawer">
        <aside v-if="libraryOpen" class="library-drawer" aria-label="永久影像库">
          <div class="library-heading">
            <div>
              <strong>永久影像库</strong>
              <span>{{ library.length }} 幅已保存影像 · 下载与缩略图集中在这里</span>
            </div>
            <div class="library-heading-actions">
              <button
                type="button"
                title="导出当前对比图"
                aria-label="导出当前对比图"
                :disabled="panoramas.length === 0"
                @click="exportComparison"
              >
                <Download :size="16" />
              </button>
              <button type="button" title="关闭影像库" aria-label="关闭影像库" @click="libraryOpen = false">
                <X :size="18" />
              </button>
            </div>
          </div>
          <div class="library-list">
            <article v-for="item in library" :key="item.id" class="library-record" :class="{ selected: visibleIds.includes(item.id) }">
              <header class="library-record-heading">
                <div>
                  <strong>{{ item.name }}</strong>
                  <span>GPS 与航向已提取 · 地面反投影就绪</span>
                </div>
                <button type="button" class="danger" title="永久删除" aria-label="永久删除" @click="permanentlyDelete(item)">
                  <Trash2 :size="16" />
                </button>
              </header>

              <section class="library-type-group">
                <div class="library-type-label">全景原图</div>
                <div class="library-child-card">
                  <img :src="item.imageUrl" :alt="`${item.name}全景原图`" loading="lazy" decoding="async" />
                  <div class="library-item-info">
                    <strong>360 全景</strong>
                    <span>{{ imageDetail(item) }}</span>
                    <small>{{ item.fileName }}</small>
                  </div>
                  <div class="library-item-actions">
                    <button
                      type="button"
                      :class="{ active: visibleIds.includes(item.id) }"
                      :title="libraryPanoramaActionLabel(item)"
                      :aria-label="libraryPanoramaActionLabel(item)"
                      @click="toggleLibraryItem(item.id)"
                    >
                      <Check v-if="visibleIds.includes(item.id)" :size="16" />
                      <Images v-else :size="16" />
                    </button>
                    <button type="button" title="下载原图" aria-label="下载原图" @click="downloadOriginal(item)">
                      <Download :size="16" />
                    </button>
                  </div>
                </div>
              </section>

              <section class="library-type-group">
                <div class="library-type-label">转换正射图</div>
                <div class="library-child-card">
                  <img :src="item.orthophotoUrl" :alt="`${item.name}转换正射图`" loading="lazy" decoding="async" />
                  <div class="library-item-info">
                    <strong>500 m × 500 m</strong>
                    <span>平坦地面反投影预览</span>
                    <small>{{ orthophotoVisibleIds.includes(item.id) ? '已显示在天地图' : '未显示' }}</small>
                  </div>
                  <div class="library-item-actions">
                    <button
                      type="button"
                      :class="{ active: orthophotoVisibleIds.includes(item.id) }"
                      :title="orthophotoVisibleIds.includes(item.id) ? '隐藏正射图层' : '显示正射图层'"
                      :aria-label="orthophotoVisibleIds.includes(item.id) ? '隐藏正射图层' : '显示正射图层'"
                      @click="toggleOrthophotoLayer(item.id)"
                    >
                      <Check v-if="orthophotoVisibleIds.includes(item.id)" :size="16" />
                      <Map v-else :size="16" />
                    </button>
                    <button
                      type="button"
                      title="下载 JPG 预览"
                      aria-label="下载正射图"
                      @click="downloadOrthophoto(item)"
                    >
                      <Download :size="16" />
                    </button>
                    <button
                      type="button"
                      title="下载 GeoTIFF（.tif，含定位）"
                      aria-label="下载 GeoTIFF"
                      @click="downloadOrthophoto(item, 'tif')"
                    >
                      TIF
                    </button>
                    <button
                      type="button"
                      title="下载 MBTiles（.mbtiles，含定位）"
                      aria-label="下载 MBTiles"
                      @click="downloadOrthophoto(item, 'mbtiles')"
                    >
                      MB
                    </button>
                  </div>
                </div>
              </section>
            </article>

            <section class="library-region-downloads">
              <div class="library-type-label">区域图层 KML</div>
              <div class="library-region-toolbar">
                <span>{{ regions.length ? `${regions.length} 个区域` : '暂无区域' }}</span>
                <button type="button" :disabled="visibleRegionCount === 0" @click="exportVisibleRegions">
                  <Download :size="15" /> 导出可见区域
                </button>
              </div>
              <article v-for="region in regions" :key="region.id" class="library-region-row">
                <button
                  type="button"
                  :title="region.visible ? '隐藏区域' : '显示区域'"
                  :aria-label="region.visible ? '隐藏区域' : '显示区域'"
                  @click="updateRegion(region.id, { visible: !region.visible })"
                >
                  <Eye v-if="region.visible" :size="14" />
                  <EyeOff v-else :size="14" />
                </button>
                <i :style="{ background: region.color, opacity: region.opacity }" />
                <span>{{ region.name }}</span>
                <button type="button" title="导出 KML" aria-label="导出 KML" @click="exportRegion(region)">
                  <Download :size="14" />
                </button>
                <button type="button" class="danger" title="删除区域" aria-label="删除区域" @click="deleteRegion(region.id)">
                  <Trash2 :size="14" />
                </button>
              </article>
            </section>
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
      </div>
    </footer>

    <Transition name="toast">
      <div v-if="toast" class="toast-message" :class="{ error: toast.kind === 'error' }" role="status">
        <CircleAlert v-if="toast.kind === 'error'" :size="17" />
        <CheckCircle2 v-else :size="17" />
        <span>{{ toast.message }}</span>
      </div>
    </Transition>
  </div>
</template>
