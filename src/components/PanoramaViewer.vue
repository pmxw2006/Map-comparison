<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { LoaderCircle, Navigation, PenTool, RotateCcw, Trash2, Undo2, X, ZoomIn, ZoomOut } from '@lucide/vue'
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
import type { MapRegion, PanoramaItem, ViewState } from '../types/panorama'

const props = defineProps<{
  image: PanoramaItem
  view: ViewState
  index: number
  active: boolean
  removable: boolean
  regions: MapRegion[]
}>()

const emit = defineEmits<{
  activate: []
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
const draftPoints = ref<Array<[number, number]>>([])
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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const normalizeAngle = (value: number) => ((value % 360) + 360) % 360

const heading = computed(() => Math.round(normalizeAngle(localView.yaw + props.image.northOffset)))
const pitchText = computed(() => {
  const pitch = Math.round(localView.pitch)
  return `${pitch > 0 ? '+' : ''}${pitch}`
})
const headingText = computed(() => String(heading.value).padStart(3, '0'))
const canDrawOnPanorama = computed(() => props.image.latitude !== null && props.image.longitude !== null)
const cardinal = computed(() => {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return points[Math.round(heading.value / 45) % points.length]
})

const visibleRegionPolygons = computed(() => {
  if (!stageSize.width || !stageSize.height) return []
  return props.regions
    .filter((region) => region.visible && region.points.length >= 3)
    .map((region) => {
      const points = region.points
        .map((point) => projectRegionPoint(point))
        .filter(Boolean) as Array<{ x: number; y: number }>
      return { region, count: points.length, points: points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ') }
    })
    .filter((item) => item.count >= 3)
})

const visibleRegionMarkers = computed(() => {
  if (!stageSize.width || !stageSize.height) return []
  return props.regions
    .filter((region) => region.visible)
    .flatMap((region) =>
      region.points
        .map((point, pointIndex) => {
          const projected = projectRegionPoint(point)
          if (!projected) return null
          return {
            id: `${region.id}-${pointIndex}`,
            region,
            x: projected.x,
            y: projected.y,
          }
        })
        .filter(Boolean),
    ) as Array<{ id: string; region: MapRegion; x: number; y: number }>
})

const draftScreenPoints = computed(() => {
  if (!stageSize.width || !stageSize.height) return ''
  const points = draftPoints.value
    .map((point) => projectRegionPoint(point))
    .filter(Boolean) as Array<{ x: number; y: number }>
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
})

const draftScreenMarkers = computed(() => {
  if (!stageSize.width || !stageSize.height) return []
  return draftPoints.value
    .map((point, pointIndex) => {
      const projected = projectRegionPoint(point)
      return projected ? { id: `draft-${pointIndex}`, x: projected.x, y: projected.y } : null
    })
    .filter(Boolean) as Array<{ id: string; x: number; y: number }>
})

function yawPitchToWorld(yaw: number, pitch: number, distance = 500) {
  const phi = MathUtils.degToRad(90 - pitch)
  const theta = MathUtils.degToRad(yaw)
  return new Vector3(
    distance * Math.sin(phi) * Math.cos(theta),
    distance * Math.cos(phi),
    distance * Math.sin(phi) * Math.sin(theta),
  )
}

function groundPointToWorld(point: [number, number]) {
  if (props.image.latitude === null || props.image.longitude === null) return null
  const latitudeScale = 111_320
  const longitudeScale = 111_320 * Math.max(0.1, Math.cos(MathUtils.degToRad(props.image.latitude)))
  const north = (point[0] - props.image.latitude) * latitudeScale
  const east = (point[1] - props.image.longitude) * longitudeScale
  const groundDistance = Math.hypot(east, north)
  const bearing = normalizeAngle(MathUtils.radToDeg(Math.atan2(east, north)))
  const targetYaw = normalizeAngle(bearing - props.image.northOffset)
  const targetPitch = -MathUtils.radToDeg(Math.atan2(props.image.projectionAltitude, groundDistance))
  return yawPitchToWorld(targetYaw, targetPitch)
}

function projectRegionPoint(point: [number, number]) {
  if (!camera) return null
  const worldPoint = groundPointToWorld(point)
  if (!worldPoint) return null

  // 区域贴附使用和 WebGL 全景相同的相机矩阵；旋转视角时，点会锁定在同一个真实方位上。
  updateCamera()
  camera.updateMatrixWorld(true)
  const cameraForward = new Vector3()
  camera.getWorldDirection(cameraForward)
  if (worldPoint.clone().normalize().dot(cameraForward) <= 0.02) return null

  const projected = worldPoint.clone().project(camera)
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null
  if (Math.abs(projected.x) > 8 || Math.abs(projected.y) > 8) return null

  return {
    x: ((projected.x + 1) / 2) * stageSize.width,
    y: ((1 - projected.y) / 2) * stageSize.height,
  }
}

function screenToGroundPoint(clientX: number, clientY: number): [number, number] | null {
  if (!stage.value || !camera || props.image.latitude === null || props.image.longitude === null) return null
  const bounds = stage.value.getBoundingClientRect()
  if (bounds.width < 1 || bounds.height < 1) return null

  const x = clientX - bounds.left
  const y = clientY - bounds.top
  updateCamera()
  camera.updateMatrixWorld(true)

  // 鼠标屏幕点先反投影为当前相机射线，再和“相机下方的平坦地面”求交。
  const rayPoint = new Vector3((x / bounds.width) * 2 - 1, -(y / bounds.height) * 2 + 1, 0.5).unproject(camera)
  const direction = rayPoint.sub(camera.position).normalize()
  const targetPitch = MathUtils.radToDeg(Math.asin(direction.y))

  // 单张全景只能把屏幕点反算到“平坦地面”上；视线接近天空/地平线时没有稳定的落地点。
  if (targetPitch >= -0.5) return null

  const groundDistance = props.image.projectionAltitude / Math.tan(MathUtils.degToRad(-targetPitch))
  if (!Number.isFinite(groundDistance) || groundDistance <= 0) return null

  const targetYaw = normalizeAngle(MathUtils.radToDeg(Math.atan2(direction.z, direction.x)))
  const bearing = normalizeAngle(targetYaw + props.image.northOffset)
  const east = groundDistance * Math.sin(MathUtils.degToRad(bearing))
  const north = groundDistance * Math.cos(MathUtils.degToRad(bearing))
  const latitudeScale = 111_320
  const longitudeScale = 111_320 * Math.max(0.1, Math.cos(MathUtils.degToRad(props.image.latitude)))
  return [props.image.latitude + north / latitudeScale, props.image.longitude + east / longitudeScale]
}

function startDrawing() {
  if (!canDrawOnPanorama.value) {
    emit('notice', '当前全景没有 GPS，无法描绘地理区域')
    return
  }
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

// 将经纬式的 yaw / pitch 转换成球心向外的观察向量。
function updateCamera() {
  if (!camera) return

  camera.fov = localView.fov
  camera.updateProjectionMatrix()

  camera.lookAt(yawPitchToWorld(localView.yaw, localView.pitch))
}

function renderNow() {
  updateCamera()
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
  if (next.yaw !== undefined) localView.yaw = normalizeAngle(next.yaw)
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
  stage.value?.setPointerCapture(event.pointerId)
  stage.value?.focus({ preventScroll: true })
  emit('activate')
}

function onPointerMove(event: PointerEvent) {
  if (drawing.value) return
  if (!dragging.value || pointerId !== event.pointerId) return
  // 拖拽只更新当前查看器的视角；父组件根据“视角同步”开关决定是否广播给其他全景。
  publishView({
    yaw: dragStartYaw - (event.clientX - dragStartX) * 0.16,
    pitch: dragStartPitch + (event.clientY - dragStartY) * 0.13,
  })
}

function finishPointer(event: PointerEvent) {
  if (drawing.value) return
  if (pointerId !== event.pointerId) return
  if (stage.value?.hasPointerCapture(event.pointerId)) stage.value.releasePointerCapture(event.pointerId)
  pointerId = null
  dragging.value = false
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

function onDoubleClick(event: MouseEvent) {
  if (!drawing.value) return
  event.preventDefault()
  event.stopPropagation()
  finishDrawing()
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
      // 导出当前视角时需要保留 WebGL 缓冲区中的像素。
      preserveDrawingBuffer: true,
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
    loadTexture(props.image.src)
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
  () => props.image.src,
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
      @wheel="onWheel"
      @keydown="onKeydown"
      @dblclick="onDoubleClick"
    >
      <div class="image-shade image-shade-top" aria-hidden="true" />
      <div class="image-shade image-shade-bottom" aria-hidden="true" />

      <div class="panel-heading">
        <span class="panel-index">{{ String(index + 1).padStart(2, '0') }}</span>
        <div>
          <strong>{{ image.name }}</strong>
          <span>{{ image.tag }}</span>
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

      <div class="draw-tools" @pointerdown.stop @dblclick.stop>
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
          <button type="button" title="取消描绘" aria-label="取消描绘" @click="stopDrawing">
            <X :size="15" />
          </button>
          <small>左键点选，双击结束</small>
        </template>
      </div>

      <div class="view-reticle" aria-hidden="true"><span /></div>

      <svg
        v-if="visibleRegionPolygons.length || visibleRegionMarkers.length || draftScreenPoints || draftScreenMarkers.length"
        class="region-screen-layer"
        :viewBox="`0 0 ${stageSize.width} ${stageSize.height}`"
        aria-hidden="true"
      >
        <polygon
          v-for="item in visibleRegionPolygons"
          :key="item.region.id"
          :points="item.points"
          :fill="item.region.color"
          :fill-opacity="item.region.opacity"
          :stroke="item.region.color"
        />
        <g
          v-for="marker in visibleRegionMarkers"
          :key="marker.id"
          class="region-point-marker"
          :style="{ color: marker.region.color }"
        >
          <circle :cx="marker.x" :cy="marker.y" r="5" />
        </g>
        <polygon
          v-if="draftPoints.length >= 3 && draftScreenPoints"
          :points="draftScreenPoints"
          :fill="regionColor"
          :fill-opacity="regionOpacity"
          :stroke="regionColor"
          class="draft-region"
        />
        <polyline
          v-else-if="draftPoints.length >= 2 && draftScreenPoints"
          :points="draftScreenPoints"
          :stroke="regionColor"
          class="draft-line"
        />
        <g
          v-for="marker in draftScreenMarkers"
          :key="marker.id"
          class="region-point-marker draft-point-marker"
          :style="{ color: regionColor }"
        >
          <circle :cx="marker.x" :cy="marker.y" r="5" />
        </g>
      </svg>

      <div class="panel-footer-overlay">
        <span>{{ image.detail }}</span>
        <div @pointerdown.stop>
          <button
            v-if="removable"
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
  gap: 1px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.65);
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
