<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Download, LoaderCircle, Navigation, RotateCcw, Trash2, ZoomIn, ZoomOut } from '@lucide/vue'
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
import type { PanoramaItem, ViewState } from '../types/panorama'

const props = defineProps<{
  image: PanoramaItem
  view: ViewState
  index: number
  active: boolean
  removable: boolean
}>()

const emit = defineEmits<{
  activate: []
  'view-change': [view: ViewState]
  download: []
  remove: []
}>()

const stage = ref<HTMLDivElement | null>(null)
const loading = ref(true)
const loadError = ref(false)
const dragging = ref(false)
const localView = reactive<ViewState>({ ...props.view })

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
const cardinal = computed(() => {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return points[Math.round(heading.value / 45) % points.length]
})

// 将经纬式的 yaw / pitch 转换成球心向外的观察向量。
function updateCamera() {
  if (!camera) return

  camera.fov = localView.fov
  camera.updateProjectionMatrix()

  const phi = MathUtils.degToRad(90 - localView.pitch)
  const theta = MathUtils.degToRad(localView.yaw)
  const target = new Vector3(
    500 * Math.sin(phi) * Math.cos(theta),
    500 * Math.cos(phi),
    500 * Math.sin(phi) * Math.sin(theta),
  )
  camera.lookAt(target)
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
  if (!dragging.value || pointerId !== event.pointerId) return
  publishView({
    yaw: dragStartYaw - (event.clientX - dragStartX) * 0.16,
    pitch: dragStartPitch + (event.clientY - dragStartY) * 0.13,
  })
}

function finishPointer(event: PointerEvent) {
  if (pointerId !== event.pointerId) return
  if (stage.value?.hasPointerCapture(event.pointerId)) stage.value.releasePointerCapture(event.pointerId)
  pointerId = null
  dragging.value = false
}

function onWheel(event: WheelEvent) {
  event.preventDefault()
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
      // 导出当前视角时需要保留 WebGL 缓冲区中的像素。
      preserveDrawingBuffer: true,
    })
    renderer.outputColorSpace = SRGBColorSpace
    renderer.setClearColor(0x101418)
    renderer.domElement.setAttribute('aria-hidden', 'true')
    stage.value.prepend(renderer.domElement)

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
  (source) => loadTexture(source),
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
  <article class="panorama-panel" :class="{ 'is-active': active, 'is-dragging': dragging }">
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

      <div class="view-reticle" aria-hidden="true"><span /></div>

      <div class="panel-footer-overlay">
        <span>{{ image.detail }}</span>
        <div @pointerdown.stop>
          <button type="button" title="下载原图" aria-label="下载原图" @click="emit('download')">
            <Download :size="17" />
          </button>
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
.view-reticle,
.panel-footer-overlay,
.load-state {
  position: absolute;
  z-index: 2;
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
.panel-footer-overlay button:hover {
  color: #101418;
  background: #ffb02e;
}

.view-tools button:focus-visible,
.panel-footer-overlay button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: -3px;
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
