<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Check, LoaderCircle, Navigation, PenTool, RotateCcw, Trash2, Undo2, X, ZoomIn, ZoomOut } from '@lucide/vue'
import {
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three'
import { formatHeading, groundPointToView, normalizeDegrees, viewToGroundPoint } from '../geometry'
import type { ImageRecord, LatLng, MapRegion, ViewState } from '../types/panorama'

const props = defineProps<{
  image: ImageRecord
  view: ViewState
  index: number
  active: boolean
  regions: MapRegion[]
}>()

const emit = defineEmits<{
  activate: []
  'focus-comparison': []
  'view-change': [view: ViewState]
  'region-create': [region: MapRegion]
  notice: [message: string]
  remove: []
}>()

const stage = ref<HTMLDivElement | null>(null)
const loading = ref(true)
const loadError = ref(false)
const dragging = ref(false)
const drawing = ref(false)
const draftPoints = ref<LatLng[]>([])
const regionColor = ref('#ff4d4f')
const regionOpacity = ref(0.35)
const regionName = ref('')
const localView = reactive<ViewState>({ ...props.view })
const stageSize = reactive({ width: 0, height: 0 })

let scene: Scene | null = null
let camera: PerspectiveCamera | null = null
let renderer: WebGLRenderer | null = null
let sphere: Mesh<SphereGeometry, MeshBasicMaterial> | null = null
let texture: Texture | null = null
let resizeObserver: ResizeObserver | null = null
let renderFrame = 0
let textureRequest = 0
let pointerId: number | null = null
let dragStartX = 0
let dragStartY = 0
let dragStartYaw = 0
let dragStartPitch = 0
let movedDuringPointer = false

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const heading = computed(() => normalizeDegrees(Math.round(localView.yaw + props.image.northOffset)))
const pitchText = computed(() => {
  const pitch = Math.round(localView.pitch)
  return `${pitch > 0 ? '+' : ''}${pitch}`
})
const headingText = computed(() => formatHeading(localView.yaw + props.image.northOffset))
const imageDetail = computed(() => {
  const megabytes = props.image.fileSize / (1024 * 1024)
  return `${props.image.width} × ${props.image.height} · ${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`
})
const cardinal = computed(() => {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return points[Math.round(heading.value / 45) % points.length]
})

type ScreenPoint = { x: number; y: number }

const screenOverlays = computed(() => {
  const empty = {
    regions: [] as Array<{ region: MapRegion; points: string }>,
    markers: [] as Array<ScreenPoint & { id: string; region: MapRegion }>,
    draft: [] as ScreenPoint[],
  }
  const cameraForward = prepareProjection()
  if (!cameraForward) return empty

  // 每个地理点只投影一次，生成的坐标同时供多边形和顶点标记使用。
  const regions = props.regions
    .filter((region) => region.visible)
    .map((region) => {
      const markers = region.points
        .map((point) => projectRegionPoint(point, cameraForward))
        .filter((point): point is ScreenPoint => point !== null)
      return {
        region,
        points: markers.length >= 3 ? serializePoints(markers) : '',
        markers: markers.map((point, index) => ({ ...point, id: `${region.id}-${index}`, region })),
      }
    })

  const draft = draftPoints.value
    .map((point) => projectRegionPoint(point, cameraForward))
    .filter((point): point is ScreenPoint => point !== null)
  return {
    regions: regions.map(({ region, points }) => ({ region, points })),
    markers: regions.flatMap((region) => region.markers),
    draft,
  }
})

function serializePoints(points: ScreenPoint[]) {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
}

function yawPitchToWorld(yaw: number, pitch: number, distance = 500) {
  const phi = MathUtils.degToRad(90 - pitch)
  const theta = MathUtils.degToRad(yaw)
  return new Vector3(
    distance * Math.sin(phi) * Math.cos(theta),
    distance * Math.cos(phi),
    distance * Math.sin(phi) * Math.sin(theta),
  )
}

function prepareProjection() {
  // 先读取响应式尺寸，确保相机尚未挂载时 computed 仍会在首次 resize 后重新计算。
  if (!stageSize.width || !stageSize.height || !camera) return null
  updateCamera()
  camera.updateMatrixWorld(true)
  const cameraForward = new Vector3()
  camera.getWorldDirection(cameraForward)
  return cameraForward
}

function projectRegionPoint(point: LatLng, cameraForward: Vector3): ScreenPoint | null {
  if (!camera) return null
  const target = groundPointToView(props.image, point)
  const worldPoint = yawPitchToWorld(target.yaw, target.pitch)
  if (worldPoint.clone().normalize().dot(cameraForward) <= 0.02) return null

  const projected = worldPoint.project(camera)
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null
  if (Math.abs(projected.x) > 8 || Math.abs(projected.y) > 8) return null

  return {
    x: ((projected.x + 1) / 2) * stageSize.width,
    y: ((1 - projected.y) / 2) * stageSize.height,
  }
}

function screenToGroundPoint(clientX: number, clientY: number): LatLng | null {
  if (!stage.value || !camera) return null
  const bounds = stage.value.getBoundingClientRect()
  if (bounds.width < 1 || bounds.height < 1) return null

  const x = clientX - bounds.left
  const y = clientY - bounds.top
  updateCamera()
  camera.updateMatrixWorld(true)

  // 屏幕点先反投影为相机射线，再由共享几何函数与相机下方的水平地面求交。
  const rayPoint = new Vector3((x / bounds.width) * 2 - 1, -(y / bounds.height) * 2 + 1, 0.5).unproject(camera)
  const direction = rayPoint.sub(camera.position).normalize()
  const targetPitch = MathUtils.radToDeg(Math.asin(direction.y))
  const targetYaw = MathUtils.radToDeg(Math.atan2(direction.z, direction.x))
  return viewToGroundPoint(props.image, targetYaw, targetPitch)
}

function startDrawing() {
  drawing.value = true
  dragging.value = false
  pointerId = null
  draftPoints.value = []
  emit('activate')
  stage.value?.focus({ preventScroll: true })
}

function stopDrawing() {
  drawing.value = false
  draftPoints.value = []
}

function undoDraftPoint() {
  draftPoints.value = draftPoints.value.slice(0, -1)
}

function trimDuplicateDraftEnd() {
  const points = draftPoints.value
  if (points.length < 2) return
  const previous = points[points.length - 2]
  const last = points[points.length - 1]
  // 双击确认前会先触发两次落点；若最后两个点几乎重合，只移除第二次落点。
  if (Math.abs(previous[0] - last[0]) < 1e-9 && Math.abs(previous[1] - last[1]) < 1e-9) {
    draftPoints.value = points.slice(0, -1)
  }
}

function addDraftPoint(event: PointerEvent) {
  const point = screenToGroundPoint(event.clientX, event.clientY)
  if (!point) {
    emit('notice', '请在全景中的地面方向描绘，天空或远处地平线无法稳定贴合')
    return
  }
  draftPoints.value = [...draftPoints.value, point]
}

function finishDrawing() {
  if (draftPoints.value.length < 3) {
    emit('notice', '至少需要 3 个点才能保存区域')
    return
  }
  const nextRegion: MapRegion = {
    id: crypto.randomUUID(),
    name: regionName.value.trim() || `全景区域 ${Date.now().toString().slice(-4)}`,
    color: regionColor.value,
    opacity: regionOpacity.value,
    visible: true,
    points: [...draftPoints.value],
  }
  emit('region-create', nextRegion)
  regionName.value = ''
  stopDrawing()
}

function finishDrawingByDoubleClick(event: MouseEvent) {
  if (!drawing.value) return
  event.preventDefault()
  event.stopPropagation()
  trimDuplicateDraftEnd()
  finishDrawing()
}

// 将经纬式的 yaw / pitch 转换成球心向外的观察向量。
function updateCamera() {
  if (!camera) return

  camera.fov = localView.fov
  camera.updateProjectionMatrix()

  camera.lookAt(yawPitchToWorld(localView.yaw, localView.pitch))
}

function renderNow() {
  updateCamera()
  // 导出方必须在本函数返回后立即复制画布；无需长期保留绘制缓冲，可减少显存占用。
  if (renderer && scene && camera) renderer.render(scene, camera)
}

// 高频拖拽只在下一帧渲染一次，避免两个 WebGL 画面重复抢占主线程。
function scheduleRender() {
  if (renderFrame) return
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0
    renderNow()
  })
}

function publishView(next: Partial<ViewState>) {
  if (next.yaw !== undefined) localView.yaw = normalizeDegrees(next.yaw)
  if (next.pitch !== undefined) localView.pitch = clamp(next.pitch, -85, 85)
  if (next.fov !== undefined) localView.fov = clamp(next.fov, 32, 96)

  scheduleRender()
  emit('view-change', { ...localView })
}

function resizeRenderer() {
  if (!stage.value || !renderer || !camera) return
  const { width, height } = stage.value.getBoundingClientRect()
  if (width < 1 || height < 1) return
  stageSize.width = width
  stageSize.height = height

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  scheduleRender()
}

function loadTexture(source: string) {
  if (!sphere || !renderer) return

  const requestId = ++textureRequest
  loading.value = true
  loadError.value = false

  new TextureLoader().load(
    source,
    (loadedTexture) => {
      // 图片快速切换时丢弃已经过期的异步结果，防止旧图覆盖新图。
      if (requestId !== textureRequest || !sphere || !renderer) {
        loadedTexture.dispose()
        return
      }

      texture?.dispose()
      texture = loadedTexture
      texture.colorSpace = SRGBColorSpace
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
      sphere.material.map = texture
      sphere.material.needsUpdate = true
      loading.value = false
      scheduleRender()
    },
    undefined,
    () => {
      if (requestId !== textureRequest) return
      loading.value = false
      loadError.value = true
    },
  )
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  if (drawing.value) {
    event.preventDefault()
    emit('activate')
    addDraftPoint(event)
    return
  }
  pointerId = event.pointerId
  dragging.value = true
  dragStartX = event.clientX
  dragStartY = event.clientY
  dragStartYaw = localView.yaw
  dragStartPitch = localView.pitch
  movedDuringPointer = false
  stage.value?.setPointerCapture(event.pointerId)
  stage.value?.focus({ preventScroll: true })
  emit('activate')
}

function onPointerMove(event: PointerEvent) {
  if (drawing.value) return
  if (!dragging.value || pointerId !== event.pointerId) return
  const deltaX = event.clientX - dragStartX
  const deltaY = event.clientY - dragStartY
  if (Math.abs(deltaX) + Math.abs(deltaY) > 3) movedDuringPointer = true
  // 拖拽只更新当前查看器的视角；父组件根据“视角同步”开关决定是否广播给其他全景。
  publishView({
    yaw: dragStartYaw - deltaX * 0.16,
    pitch: dragStartPitch + deltaY * 0.13,
  })
}

function finishPointer(event: PointerEvent) {
  if (drawing.value) return
  if (pointerId !== event.pointerId) return
  const shouldFocusComparison = event.type === 'pointerup' && !movedDuringPointer
  if (stage.value?.hasPointerCapture(event.pointerId)) stage.value.releasePointerCapture(event.pointerId)
  pointerId = null
  dragging.value = false
  movedDuringPointer = false
  if (shouldFocusComparison) emit('focus-comparison')
}

function onWheel(event: WheelEvent) {
  event.preventDefault()
  if (drawing.value) return
  emit('activate')
  publishView({ fov: localView.fov + Math.sign(event.deltaY) * 4 })
}

function zoomIn() {
  emit('activate')
  publishView({ fov: localView.fov - 8 })
}

function zoomOut() {
  emit('activate')
  publishView({ fov: localView.fov + 8 })
}

function resetView() {
  emit('activate')
  publishView({ yaw: 0, pitch: 0, fov: 70 })
}

function onKeydown(event: KeyboardEvent) {
  if (drawing.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      stopDrawing()
    } else if (event.key === 'Backspace') {
      event.preventDefault()
      undoDraftPoint()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      finishDrawing()
    }
    return
  }
  const controls: Record<string, () => void> = {
    ArrowLeft: () => publishView({ yaw: localView.yaw - 4 }),
    ArrowRight: () => publishView({ yaw: localView.yaw + 4 }),
    ArrowUp: () => publishView({ pitch: localView.pitch + 3 }),
    ArrowDown: () => publishView({ pitch: localView.pitch - 3 }),
    '+': zoomIn,
    '=': zoomIn,
    '-': zoomOut,
    Home: resetView,
  }

  const action = controls[event.key]
  if (!action) return
  event.preventDefault()
  emit('activate')
  action()
}

onMounted(async () => {
  await nextTick()
  if (!stage.value) return

  try {
    scene = new Scene()
    camera = new PerspectiveCamera(localView.fov, 1, 0.1, 1100)
    renderer = new WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    renderer.outputColorSpace = SRGBColorSpace
    renderer.setClearColor(0x101418)
    renderer.domElement.setAttribute('aria-hidden', 'true')
    stage.value.prepend(renderer.domElement)

    // 360 全景贴在球体内侧，相机位于球心；缩放和转向都通过相机完成。
    const geometry = new SphereGeometry(500, 72, 48)
    geometry.scale(-1, 1, 1)
    sphere = new Mesh(geometry, new MeshBasicMaterial({ color: 0xffffff }))
    scene.add(sphere)

    resizeObserver = new ResizeObserver(resizeRenderer)
    resizeObserver.observe(stage.value)
    resizeRenderer()
    loadTexture(props.image.imageUrl)
  } catch {
    loading.value = false
    loadError.value = true
  }
})

watch(
  () => props.view,
  (view) => {
    localView.yaw = view.yaw
    localView.pitch = view.pitch
    localView.fov = view.fov
    scheduleRender()
  },
  { deep: true },
)

watch(
  () => props.image.imageUrl,
  (source) => {
    stopDrawing()
    loadTexture(source)
  },
)

onBeforeUnmount(() => {
  textureRequest += 1
  resizeObserver?.disconnect()
  if (renderFrame) cancelAnimationFrame(renderFrame)
  texture?.dispose()
  sphere?.geometry.dispose()
  sphere?.material.dispose()
  renderer?.dispose()
  // 浏览器对并存 WebGL 上下文有限制；切换整组影像时主动归还已销毁查看器的上下文。
  renderer?.forceContextLoss()
  renderer?.domElement.remove()
})

defineExpose({
  getCanvas: () => renderer?.domElement ?? null,
  renderNow,
})
</script>

<template>
  <article class="panorama-panel" :class="{ 'is-active': active, 'is-dragging': dragging, 'is-drawing': drawing }">
    <div
      ref="stage"
      class="panorama-stage"
      role="application"
      :aria-label="`${image.name}全景查看器`"
      tabindex="0"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="finishPointer"
      @pointercancel="finishPointer"
      @dblclick="finishDrawingByDoubleClick"
      @wheel="onWheel"
      @keydown="onKeydown"
    >
      <div class="image-shade image-shade-top" aria-hidden="true" />
      <div class="image-shade image-shade-bottom" aria-hidden="true" />

      <div class="panel-heading">
        <span class="panel-index">{{ String(index + 1).padStart(2, '0') }}</span>
        <div>
          <strong>{{ image.name }}</strong>
          <span>{{ image.fileName }}</span>
        </div>
      </div>

      <div class="orientation-hud" aria-label="当前方位信息">
        <div class="compass-dial">
          <span>N</span>
          <Navigation
            :size="17"
            :stroke-width="2"
            :style="{ transform: `rotate(${-heading - 45}deg)` }"
          />
        </div>
        <div class="orientation-values">
          <strong>{{ cardinal }} {{ headingText }}°</strong>
          <span>俯仰 {{ pitchText }}° · 视场 {{ Math.round(localView.fov) }}°</span>
        </div>
      </div>

      <div class="view-tools" @pointerdown.stop>
        <button type="button" title="放大" aria-label="放大" @click="zoomIn">
          <ZoomIn :size="18" />
        </button>
        <button type="button" title="缩小" aria-label="缩小" @click="zoomOut">
          <ZoomOut :size="18" />
        </button>
        <button type="button" title="归正" aria-label="归正" @click="resetView">
          <RotateCcw :size="18" />
        </button>
      </div>

      <div class="draw-tools" @pointerdown.stop>
        <template v-if="!drawing">
          <button type="button" title="全景描绘" aria-label="全景描绘" @click="startDrawing">
            <PenTool :size="16" />
            <span>描绘</span>
          </button>
        </template>
        <template v-else>
          <input v-model="regionName" type="text" placeholder="区域名称" aria-label="区域名称" />
          <input v-model="regionColor" type="color" title="区域颜色" aria-label="区域颜色" />
          <label title="区域透明度">
            {{ Math.round(regionOpacity * 100) }}%
            <input v-model.number="regionOpacity" type="range" min="0.05" max="0.9" step="0.05" />
          </label>
          <button type="button" :disabled="draftPoints.length === 0" title="撤销上一点" aria-label="撤销上一点" @click="undoDraftPoint">
            <Undo2 :size="15" />
          </button>
          <button type="button" :disabled="draftPoints.length < 3" title="保存确认" aria-label="保存区域" @click="finishDrawing">
            <Check :size="15" />
            <span>保存确认</span>
          </button>
          <button type="button" title="取消描绘" aria-label="取消描绘" @click="stopDrawing">
            <X :size="15" />
          </button>
          <small>左键加点，双击或保存确认</small>
        </template>
      </div>

      <div class="view-reticle" aria-hidden="true"><span /></div>

      <svg
        v-if="screenOverlays.regions.length || screenOverlays.draft.length"
        class="region-screen-layer"
        :viewBox="`0 0 ${stageSize.width} ${stageSize.height}`"
        aria-hidden="true"
      >
        <polygon
          v-for="item in screenOverlays.regions.filter((overlay) => overlay.points)"
          :key="item.region.id"
          :points="item.points"
          :fill="item.region.color"
          :fill-opacity="item.region.opacity"
          :stroke="item.region.color"
        />
        <g
          v-for="marker in screenOverlays.markers"
          :key="marker.id"
          class="region-point-marker"
          :style="{ color: marker.region.color }"
        >
          <circle :cx="marker.x" :cy="marker.y" r="5" />
        </g>
        <polygon
          v-if="draftPoints.length >= 3 && screenOverlays.draft.length >= 3"
          :points="serializePoints(screenOverlays.draft)"
          :fill="regionColor"
          :fill-opacity="regionOpacity"
          :stroke="regionColor"
          class="draft-region"
        />
        <polyline
          v-else-if="draftPoints.length >= 2 && screenOverlays.draft.length >= 2"
          :points="serializePoints(screenOverlays.draft)"
          :stroke="regionColor"
          class="draft-line"
        />
        <g
          v-for="(marker, markerIndex) in screenOverlays.draft"
          :key="`draft-${markerIndex}`"
          class="region-point-marker draft-point-marker"
          :style="{ color: regionColor }"
        >
          <circle :cx="marker.x" :cy="marker.y" r="5" />
        </g>
      </svg>

      <div class="panel-footer-overlay">
        <span>{{ imageDetail }}</span>
        <div @pointerdown.stop>
          <button
            type="button"
            title="移除影像"
            aria-label="移除影像"
            @click="emit('remove')"
          >
            <Trash2 :size="17" />
          </button>
        </div>
      </div>

      <div v-if="loading" class="load-state">
        <LoaderCircle class="spinner" :size="25" />
        <span>正在载入全景</span>
      </div>
      <div v-else-if="loadError" class="load-state load-error">
        <span>全景图片载入失败</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.panorama-panel {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #101418;
  box-shadow: inset 0 0 0 1px transparent;
  transition: box-shadow 160ms ease;
}

.panorama-panel.is-active {
  box-shadow: inset 0 0 0 2px #ffb02e;
  z-index: 1;
}

.panorama-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  outline: none;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.is-dragging .panorama-stage {
  cursor: grabbing;
}

.is-drawing .panorama-stage {
  cursor: crosshair;
}

.panorama-stage:focus-visible {
  box-shadow: inset 0 0 0 3px rgba(255, 176, 46, 0.9);
}

.panorama-stage :deep(canvas) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.image-shade {
  position: absolute;
  z-index: 1;
  left: 0;
  right: 0;
  height: 150px;
  pointer-events: none;
}

.image-shade-top {
  top: 0;
  background: linear-gradient(to bottom, rgba(8, 12, 15, 0.68), transparent);
}

.image-shade-bottom {
  bottom: 0;
  background: linear-gradient(to top, rgba(8, 12, 15, 0.72), transparent);
}

.panel-heading,
.orientation-hud,
.view-tools,
.draw-tools,
.view-reticle,
.region-screen-layer,
.panel-footer-overlay,
.load-state {
  position: absolute;
  z-index: 2;
}

.region-screen-layer {
  z-index: 3;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.region-screen-layer polygon {
  stroke-width: 3px;
  vector-effect: non-scaling-stroke;
  paint-order: stroke fill;
}

.region-screen-layer .draft-region,
.region-screen-layer .draft-line {
  stroke-width: 3px;
  stroke-dasharray: 7 5;
  vector-effect: non-scaling-stroke;
}

.region-screen-layer .draft-line {
  fill: none;
}

.region-point-marker {
  color: #ff4d4f;
}

.region-point-marker circle {
  fill: currentColor;
  stroke: #fff;
  stroke-width: 2px;
  vector-effect: non-scaling-stroke;
  paint-order: stroke fill;
}

.draft-point-marker circle {
  stroke-dasharray: 3 2;
}

.panel-heading {
  top: 18px;
  left: 18px;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100% - 220px);
  color: #fff;
  pointer-events: none;
}

.panel-index {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.45);
  background: rgba(10, 14, 17, 0.52);
  font: 700 11px/1 var(--font-mono);
}

.panel-heading div {
  display: grid;
  min-width: 0;
  gap: 1px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.65);
}

.panel-heading strong,
.panel-heading div span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-heading strong {
  font-size: 14px;
  line-height: 1.25;
}

.panel-heading div span {
  color: rgba(255, 255, 255, 0.7);
  font-size: 11px;
}

.orientation-hud {
  top: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  min-width: 164px;
  height: 52px;
  padding: 0 11px 0 8px;
  color: #fff;
  background: rgba(11, 17, 20, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.22);
  backdrop-filter: blur(8px);
  box-sizing: border-box;
  pointer-events: none;
}

.compass-dial {
  position: relative;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  margin-right: 9px;
  border: 1px solid rgba(255, 255, 255, 0.38);
  border-radius: 50%;
}

.compass-dial span {
  position: absolute;
  top: 2px;
  color: #ffb02e;
  font: 700 8px/1 var(--font-mono);
}

.compass-dial svg {
  color: #f8fafc;
  transition: transform 80ms linear;
}

.orientation-values {
  display: grid;
  gap: 3px;
}

.orientation-values strong {
  font: 700 13px/1 var(--font-mono);
}

.orientation-values span {
  color: rgba(255, 255, 255, 0.65);
  font: 500 9px/1.2 var(--font-mono);
  white-space: nowrap;
}

.view-tools {
  top: 82px;
  right: 16px;
  display: grid;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(11, 17, 20, 0.72);
  backdrop-filter: blur(8px);
}

.view-tools button,
.draw-tools button,
.panel-footer-overlay button {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 0;
  color: rgba(255, 255, 255, 0.86);
  background: transparent;
  border: 0;
  cursor: pointer;
}

.view-tools button + button {
  border-top: 1px solid rgba(255, 255, 255, 0.17);
}

.view-tools button:hover,
.draw-tools button:hover,
.panel-footer-overlay button:hover {
  color: #101418;
  background: #ffb02e;
}

.view-tools button:focus-visible,
.draw-tools button:focus-visible,
.panel-footer-overlay button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: -3px;
}

.draw-tools {
  top: 82px;
  left: 18px;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: min(560px, calc(100% - 106px));
  min-height: 38px;
  padding: 6px;
  color: #fff;
  background: rgba(11, 17, 20, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.22);
  backdrop-filter: blur(8px);
}

.draw-tools button {
  display: inline-flex;
  width: auto;
  min-width: 34px;
  height: 30px;
  padding: 0 8px;
  gap: 5px;
  font-size: 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.draw-tools button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.draw-tools input[type='text'] {
  width: 96px;
  height: 30px;
  min-width: 0;
  padding: 0 8px;
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  font-size: 10px;
  outline: none;
}

.draw-tools input[type='color'] {
  width: 30px;
  height: 30px;
  padding: 0;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.24);
}

.draw-tools label {
  display: flex;
  align-items: center;
  gap: 5px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 9px;
}

.draw-tools input[type='range'] {
  width: 76px;
}

.draw-tools small {
  color: #ffcf7b;
  font-size: 9px;
  white-space: nowrap;
}

.view-reticle {
  top: 50%;
  left: 50%;
  width: 26px;
  height: 26px;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(255, 255, 255, 0.62);
  border-radius: 50%;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.55);
  pointer-events: none;
}

.view-reticle::before,
.view-reticle::after,
.view-reticle span::before,
.view-reticle span::after {
  content: '';
  position: absolute;
  background: rgba(255, 255, 255, 0.74);
}

.view-reticle::before,
.view-reticle::after {
  top: 12px;
  width: 7px;
  height: 1px;
}

.view-reticle::before { left: -4px; }
.view-reticle::after { right: -4px; }
.view-reticle span::before,
.view-reticle span::after {
  left: 12px;
  width: 1px;
  height: 7px;
}
.view-reticle span::before { top: -4px; }
.view-reticle span::after { bottom: -4px; }

.panel-footer-overlay {
  right: 16px;
  bottom: 15px;
  left: 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: rgba(255, 255, 255, 0.68);
  font-size: 11px;
  pointer-events: none;
}

.panel-footer-overlay > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-footer-overlay > div {
  display: flex;
  pointer-events: auto;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(11, 17, 20, 0.64);
}

.panel-footer-overlay button + button {
  border-left: 1px solid rgba(255, 255, 255, 0.17);
}

.load-state {
  inset: 0;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.78);
  background: #101418;
  font-size: 12px;
}

.spinner {
  color: #ffb02e;
  animation: spin 900ms linear infinite;
}

.load-error {
  color: #fecaca;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

</style>
