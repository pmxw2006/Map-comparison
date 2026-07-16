<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowLeft,
  Check,
  CheckCircle2,
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
import OrthophotoMap from './components/OrthophotoMap.vue'
import PanoramaViewer from './components/PanoramaViewer.vue'
import type { MapRegion, PanoramaItem, PanoramaViewerExpose, StoredImageDto, ViewState } from './types/panorama'

const DEFAULT_VIEW: ViewState = { yaw: 0, pitch: -2, fov: 70 }
const MAX_PANORAMAS = 4
const REGION_STORAGE_KEY = 'duibi.mapRegions'

const library = ref<PanoramaItem[]>([])
const visibleIds = ref<string[]>([])
const orthophotoVisibleIds = ref<string[]>([])
const regions = ref<MapRegion[]>(loadStoredRegions())
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
          .map((point: [number, number]) => [Number(point[0]), Number(point[1])] as [number, number])
          .filter((point: [number, number]) => Number.isFinite(point[0]) && Number.isFinite(point[1])),
      }))
      .filter((item) => item.points.length >= 3)
  } catch {
    return []
  }
}

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
    orthophotoDownloadUrl: item.orthophoto_download_url,
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

function sameLocation(first: PanoramaItem, second: PanoramaItem) {
  if (first.id === second.id) return true
  if (first.latitude === null || first.longitude === null || second.latitude === null || second.longitude === null) {
    return false
  }
  return first.nearbyIds.includes(second.id) || second.nearbyIds.includes(first.id)
}

function comparableGroup(anchorId: string | null) {
  const anchor = library.value.find((item) => item.id === anchorId) ?? library.value[0]
  if (!anchor) return []
  const group = [anchor]
  for (const item of library.value) {
    if (item.id === anchor.id || group.length >= MAX_PANORAMAS) continue
    if (group.every((selected) => sameLocation(selected, item))) group.push(item)
  }
  return group.map((item) => item.id)
}

function sanitizeVisibleIds(ids: string[]) {
  const existing = ids.map((id) => library.value.find((item) => item.id === id)).filter(Boolean) as PanoramaItem[]
  if (!existing.length) return []
  const group: PanoramaItem[] = []
  for (const item of existing) {
    if (group.length >= MAX_PANORAMAS) break
    if (group.length === 0 || group.every((selected) => sameLocation(selected, item))) group.push(item)
  }
  return group.map((item) => item.id)
}

function canJoinComparison(item: PanoramaItem) {
  if (visibleIds.value.includes(item.id) || visibleIds.value.length === 0) return true
  if (visibleIds.value.length >= MAX_PANORAMAS) return false
  const selected = panoramas.value
  return selected.every((current) => sameLocation(current, item))
}

function canReplaceActivePanorama(item: PanoramaItem) {
  if (visibleIds.value.includes(item.id)) return true
  if (visibleIds.value.length === 0) return true
  const activeId = visibleIds.value[activeIndex.value] ?? visibleIds.value[0]
  const remaining = visibleIds.value
    .filter((id) => id !== activeId)
    .map((id) => library.value.find((entry) => entry.id === id))
    .filter(Boolean) as PanoramaItem[]
  return remaining.every((current) => sameLocation(current, item))
}

function canUseLibraryItem(item: PanoramaItem) {
  if (visibleIds.value.includes(item.id) || visibleIds.value.length < MAX_PANORAMAS) return canJoinComparison(item)
  return canReplaceActivePanorama(item)
}

function libraryPanoramaActionLabel(item: PanoramaItem) {
  if (visibleIds.value.includes(item.id)) return '移出当前对比'
  if (visibleIds.value.length >= MAX_PANORAMAS) return '替换当前活动影像'
  return '加入当前对比'
}

function isOrthophotoReady(item: PanoramaItem) {
  return Boolean(item.orthophotoUrl && item.overlayBounds)
}

function sanitizeOrthophotoVisibleIds(ids: string[]) {
  const ready = new Set(library.value.filter(isOrthophotoReady).map((item) => item.id))
  const unique = [...new Set(ids)].filter((id) => ready.has(id))
  if (unique.length) return unique
  const fallback = library.value.find((item) => item.id === selectedMapId.value && isOrthophotoReady(item))
    ?? library.value.find(isOrthophotoReady)
  return fallback ? [fallback.id] : []
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
    if (initial) visibleIds.value = comparableGroup(library.value[0]?.id ?? null)
    else visibleIds.value = sanitizeVisibleIds(visibleIds.value)
    rebuildViews()
    orthophotoVisibleIds.value = sanitizeOrthophotoVisibleIds(orthophotoVisibleIds.value)
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
    visibleIds.value = comparableGroup(uploadedIds[0] ?? null)
    selectedMapId.value = uploadedIds[0] ?? selectedMapId.value
    orthophotoVisibleIds.value = sanitizeOrthophotoVisibleIds([...uploadedIds, ...orthophotoVisibleIds.value])
    rebuildViews()
    notify(`已永久保存 ${uploaded.length} 幅影像${selected.length > MAX_PANORAMAS ? '，其余可在影像库中选择' : ''}`)
  } catch (error) {
    notify(error instanceof Error ? error.message : '上传失败')
  } finally {
    uploading.value = false
  }
}

function toggleLibraryItem(id: string) {
  const item = library.value.find((entry) => entry.id === id)
  if (!item) return
  if (visibleIds.value.includes(id)) {
    visibleIds.value = visibleIds.value.filter((visibleId) => visibleId !== id)
  } else if (visibleIds.value.length >= MAX_PANORAMAS) {
    if (!canReplaceActivePanorama(item)) {
      notify('只能切换为 20 米内同一坐标位置的全景')
      return
    }
    const replaceIndex = Math.min(activeIndex.value, visibleIds.value.length - 1)
    visibleIds.value = visibleIds.value.map((visibleId, index) => (index === replaceIndex ? id : visibleId))
    activeIndex.value = replaceIndex
    selectedMapId.value = id
    notify(`已替换当前活动影像`)
  } else if (!canJoinComparison(item)) {
    notify('只能加入 20 米内同一坐标位置的全景进行对比')
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

function downloadOrthophoto(item: PanoramaItem) {
  if (!item.orthophotoDownloadUrl) {
    notify('该影像没有可下载的正射图')
    return
  }
  const anchor = document.createElement('a')
  anchor.href = item.orthophotoDownloadUrl
  anchor.download = `${item.name}-orthophoto.jpg`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  notify(`正在下载 ${item.name} 正射图`)
}

function toggleOrthophotoLayer(id: string) {
  if (orthophotoVisibleIds.value.includes(id)) {
    orthophotoVisibleIds.value = orthophotoVisibleIds.value.filter((visibleId) => visibleId !== id)
  } else {
    orthophotoVisibleIds.value = sanitizeOrthophotoVisibleIds([...orthophotoVisibleIds.value, id])
  }
}

function regionCenter(region: MapRegion): [number, number] | null {
  if (!region.points.length) return null
  const sum = region.points.reduce(
    (total, point) => [total[0] + point[0], total[1] + point[1]] as [number, number],
    [0, 0] as [number, number],
  )
  return [sum[0] / region.points.length, sum[1] / region.points.length]
}

function viewTowardPoint(image: PanoramaItem, point: [number, number], fallback: ViewState): ViewState {
  if (image.latitude === null || image.longitude === null) return fallback
  const latitudeScale = 111_320
  const longitudeScale = 111_320 * Math.max(0.1, Math.cos((image.latitude * Math.PI) / 180))
  const north = (point[0] - image.latitude) * latitudeScale
  const east = (point[1] - image.longitude) * longitudeScale
  const groundDistance = Math.hypot(east, north)
  const bearing = normalizeAngle((Math.atan2(east, north) * 180) / Math.PI)
  return {
    yaw: normalizeAngle(bearing - image.northOffset),
    pitch: Math.max(-82, Math.min(12, -(Math.atan2(image.projectionAltitude, Math.max(groundDistance, 0.5)) * 180) / Math.PI)),
    fov: Math.min(78, Math.max(58, fallback.fov)),
  }
}

function focusRegionOnPanoramas(region: MapRegion) {
  const center = regionCenter(region)
  if (!center || panoramas.value.length === 0) return
  views.value = panoramas.value.map((image, index) => viewTowardPoint(image, center, views.value[index] ?? DEFAULT_VIEW))
  notify('区域已保存，全景视角已对准该区域')
}

function updateRegions(nextRegions: MapRegion[]) {
  const addedRegion = nextRegions.length > regions.value.length ? nextRegions[nextRegions.length - 1] : null
  regions.value = nextRegions
  if (addedRegion) focusRegionOnPanoramas(addedRegion)
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

function regionToKml(region: MapRegion) {
  const closedPoints = [...region.points, region.points[0]]
  const coordinates = closedPoints.map(([lat, lng]) => `${lng},${lat},0`).join(' ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(region.name)}</name>
    <Style id="region-style">
      <LineStyle><color>ff${kmlColor(region.color, 1).slice(2)}</color><width>2</width></LineStyle>
      <PolyStyle><color>${kmlColor(region.color, region.opacity)}</color></PolyStyle>
    </Style>
    <Placemark>
      <name>${escapeXml(region.name)}</name>
      <styleUrl>#region-style</styleUrl>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordinates}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`
}

function downloadText(filename: string, content: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function exportRegion(region: MapRegion) {
  downloadText(`${region.name}.kml`, regionToKml(region), 'application/vnd.google-earth.kml+xml')
}

function exportVisibleRegions() {
  const visibleRegions = regions.value.filter((region) => region.visible && region.points.length >= 3)
  if (!visibleRegions.length) {
    notify('当前没有可导出的可见区域')
    return
  }
  const placemarks = visibleRegions
    .map((region) => {
      const closedPoints = [...region.points, region.points[0]]
      const coordinates = closedPoints.map(([lat, lng]) => `${lng},${lat},0`).join(' ')
      return `
    <Placemark>
      <name>${escapeXml(region.name)}</name>
      <Style>
        <LineStyle><color>ff${kmlColor(region.color, 1).slice(2)}</color><width>2</width></LineStyle>
        <PolyStyle><color>${kmlColor(region.color, region.opacity)}</color></PolyStyle>
      </Style>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>${coordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>`
    })
    .join('')
  downloadText(
    '区域图层.kml',
    `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${placemarks}</Document></kml>`,
    'application/vnd.google-earth.kml+xml',
  )
}

function normalizeAngle(value: number) {
  return ((value % 360) + 360) % 360
}

function signedAngle(value: number) {
  return ((value + 540) % 360) - 180
}

function hexToRgba(color: string, opacity: number) {
  const value = color.replace('#', '')
  const normalized = value.length === 3 ? value.split('').map((char) => char + char).join('') : value
  const numeric = Number.parseInt(normalized, 16)
  if (!Number.isFinite(numeric)) return `rgba(255, 77, 79, ${opacity})`
  return `rgba(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${numeric & 255}, ${opacity})`
}

function projectRegionPoint(
  image: PanoramaItem,
  view: ViewState,
  point: [number, number],
  width: number,
  height: number,
) {
  if (image.latitude === null || image.longitude === null) return null
  const latitudeScale = 111_320
  const longitudeScale = 111_320 * Math.max(0.1, Math.cos((image.latitude * Math.PI) / 180))
  const north = (point[0] - image.latitude) * latitudeScale
  const east = (point[1] - image.longitude) * longitudeScale
  const groundDistance = Math.hypot(east, north)
  const bearing = normalizeAngle((Math.atan2(east, north) * 180) / Math.PI)
  const targetYaw = normalizeAngle(bearing - image.northOffset)
  const targetPitch = -(Math.atan2(image.projectionAltitude, groundDistance) * 180) / Math.PI
  const deltaYaw = signedAngle(targetYaw - view.yaw)
  if (Math.abs(deltaYaw) > 88) return null

  const verticalFov = (view.fov * Math.PI) / 180
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * (width / height))
  const x = width / 2 + (Math.tan((deltaYaw * Math.PI) / 180) / Math.tan(horizontalFov / 2)) * (width / 2)
  const y =
    height / 2 -
    (Math.tan(((targetPitch - view.pitch) * Math.PI) / 180) / Math.tan(verticalFov / 2)) * (height / 2)
  return { x, y }
}

function drawRegionsOnExport(
  context: CanvasRenderingContext2D,
  image: PanoramaItem,
  view: ViewState,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  for (const region of regions.value.filter((item) => item.visible && item.points.length >= 3)) {
    const points = region.points
      .map((point) => projectRegionPoint(image, view, point, width, height))
      .filter(Boolean) as Array<{ x: number; y: number }>
    if (points.length < 3) continue
    context.save()
    context.translate(x, y)
    context.beginPath()
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y)
      else context.lineTo(point.x, point.y)
    })
    context.closePath()
    context.fillStyle = hexToRgba(region.color, region.opacity)
    context.strokeStyle = region.color
    context.lineWidth = 4
    context.fill()
    context.stroke()
    points.forEach((point) => {
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
    const image = panoramas.value[index]
    const view = views.value[index] ?? activeView.value
    if (image) drawRegionsOnExport(context, image, view, x, y, cellWidth, cellHeight)
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
  const item = library.value.find((entry) => entry.id === id)
  if (item && isOrthophotoReady(item) && !orthophotoVisibleIds.value.includes(id)) {
    orthophotoVisibleIds.value = sanitizeOrthophotoVisibleIds([...orthophotoVisibleIds.value, id])
  }
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
            :regions="regions"
            @activate="activeIndex = index; selectedMapId = panorama.id"
            @view-change="(view) => handleViewChange(index, view)"
            @region-create="addRegion"
            @notice="notify"
            @remove="removePanorama(index)"
          />
        </section>
      </template>

      <OrthophotoMap
        v-else
        :images="library"
        :selected-id="selectedMapId ?? library[0]?.id ?? null"
        :visible-orthophoto-ids="orthophotoVisibleIds"
        :regions="regions"
        @select="selectMapImage"
        @toggle-orthophoto="toggleOrthophotoLayer"
        @regions-change="updateRegions"
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
                  <span>{{ item.latitude === null ? '无 GPS' : 'GPS 已提取' }} · {{ item.orthophotoStatus === 'ready' ? '地面反投影就绪' : '无反投影预览' }}</span>
                </div>
                <button type="button" class="danger" title="永久删除" aria-label="永久删除" @click="permanentlyDelete(item)">
                  <Trash2 :size="16" />
                </button>
              </header>

              <section class="library-type-group">
                <div class="library-type-label">全景原图</div>
                <div class="library-child-card">
                  <img :src="item.src" :alt="`${item.name}全景原图`" />
                  <div class="library-item-info">
                    <strong>360 全景</strong>
                    <span>{{ item.detail }}</span>
                    <small>{{ item.fileName }}</small>
                  </div>
                  <div class="library-item-actions">
                    <button
                      type="button"
                      :class="{ active: visibleIds.includes(item.id) }"
                      :disabled="!canUseLibraryItem(item)"
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
                <div v-if="item.orthophotoUrl" class="library-child-card">
                  <img :src="item.orthophotoUrl" :alt="`${item.name}转换正射图`" />
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
                      :disabled="!item.orthophotoDownloadUrl"
                      title="下载正射图"
                      aria-label="下载正射图"
                      @click="downloadOrthophoto(item)"
                    >
                      <Download :size="16" />
                    </button>
                  </div>
                </div>
                <div v-else class="library-child-card is-empty">
                  <div class="library-empty-preview"><Map :size="18" /></div>
                  <div class="library-item-info">
                    <strong>未生成</strong>
                    <span>非 2:1 全景或缺少可处理内容</span>
                    <small>无可下载正射图</small>
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
      <div v-if="toast" class="toast-message" role="status">
        <CheckCircle2 :size="17" />
        <span>{{ toast }}</span>
      </div>
    </Transition>
  </div>
</template>
