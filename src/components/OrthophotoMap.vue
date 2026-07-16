<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Eye, EyeOff, Layers3, MapPin, Navigation, PenTool, Trash2, Undo2, X } from '@lucide/vue'
import L, {
  type ImageOverlay,
  type LayerGroup,
  type LeafletMouseEvent,
  type Map as LeafletMap,
} from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { formatHeading } from '../geometry'
import type { ImageRecord, LatLng, MapRegion } from '../types/panorama'

const props = defineProps<{
  images: ImageRecord[]
  selectedId: string | null
  visibleOrthophotoIds: string[]
  regions: MapRegion[]
}>()

const emit = defineEmits<{
  select: [id: string]
  'toggle-orthophoto': [id: string]
  'region-create': [region: MapRegion]
  'region-update': [id: string, patch: Partial<MapRegion>]
  'region-delete': [id: string]
}>()

const mapElement = ref<HTMLDivElement | null>(null)
const drawing = ref(false)
const draftPoints = ref<LatLng[]>([])
const regionColor = ref('#ff4d4f')
const regionOpacity = ref(0.35)
const regionName = ref('')
const placeNames = ref<Record<string, string>>({})
const resolvingPlaceIds = new Set<string>()

let map: LeafletMap | null = null
let markerLayer: LayerGroup | null = null
let regionLayer: LayerGroup | null = null
let draftLayer: LayerGroup | null = null
const orthophotoLayers = new Map<string, ImageOverlay>()

const selected = computed(() => props.images.find((image) => image.id === props.selectedId) ?? null)
const nearbyImages = computed(() => {
  if (!selected.value) return []
  // 后端已按 20 米阈值计算 nearbyIds；这里仅负责把候选列表呈现给用户选择。
  const ids = new Set([selected.value.id, ...selected.value.nearbyIds])
  return props.images.filter((image) => ids.has(image.id))
})

function coordinateText(image: ImageRecord) {
  return `${image.latitude.toFixed(6)}, ${image.longitude.toFixed(6)}`
}

function placeText(image: ImageRecord) {
  const name = placeNames.value[image.id]
  return name ? `靠近 ${name}` : '正在推算地点...'
}

async function resolvePlaceName(image: ImageRecord | null) {
  if (!image) return
  if (placeNames.value[image.id] || resolvingPlaceIds.has(image.id)) return
  resolvingPlaceIds.add(image.id)
  try {
    const query = new URLSearchParams({
      lat: String(image.latitude),
      lng: String(image.longitude),
    })
    const response = await fetch(`/api/geocode/reverse?${query}`)
    if (!response.ok) throw new Error('逆地理编码失败')
    const payload = await response.json().catch(() => null)
    const name = typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim() : coordinateText(image)
    placeNames.value = { ...placeNames.value, [image.id]: name }
  } catch {
    placeNames.value = { ...placeNames.value, [image.id]: coordinateText(image) }
  } finally {
    resolvingPlaceIds.delete(image.id)
  }
}

function projectionHeightText(image: ImageRecord) {
  const height = `${Math.round(image.projectionAltitude)} m`
  return image.relativeAltitude === null || Math.abs(image.relativeAltitude) < 1 ? `${height}（默认）` : height
}

function isOrthophotoVisible(id: string) {
  return props.visibleOrthophotoIds.includes(id)
}

function rebuildMarkers() {
  if (!map || !markerLayer) return
  const markers = markerLayer
  markers.clearLayers()

  props.images.forEach((image) => {
    const marker = L.marker([image.latitude, image.longitude], {
      icon: L.divIcon({
        className: 'image-map-marker-host',
        html: `<span class="image-map-marker${image.id === props.selectedId ? ' is-selected' : ''}"></span>`,
        iconSize: [30, 36],
        iconAnchor: [15, 34],
      }),
      title: image.name,
    })
    marker.on('click', () => emit('select', image.id))
    // 文件名来自上传内容，仅作为文本节点展示，不能进入 Leaflet 的 HTML 字符串。
    const tooltip = document.createElement('span')
    tooltip.textContent = image.name
    marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -30] })
    markers.addLayer(marker)
  })
}

function fitSelectedOverlay() {
  if (!map) return
  const image = selected.value
  if (image) map.fitBounds(image.overlayBounds, { padding: [70, 70], maxZoom: 19 })
}

function syncOrthophotoLayerStack() {
  props.visibleOrthophotoIds.forEach((id, index) => {
    orthophotoLayers.get(id)?.setZIndex(20 + index)
  })
}

function rebuildOrthophotoOverlays(fit = false) {
  if (!map) return
  const activeMap = map
  const ready = new Map(props.images.map((image) => [image.id, image]))

  for (const [id, layer] of orthophotoLayers) {
    if (!props.visibleOrthophotoIds.includes(id) || !ready.has(id)) {
      layer.removeFrom(activeMap)
      orthophotoLayers.delete(id)
    }
  }

  props.visibleOrthophotoIds.forEach((id, index) => {
    const image = ready.get(id)
    if (!image || orthophotoLayers.has(id)) return
    const overlay = L.imageOverlay(image.orthophotoUrl, image.overlayBounds, {
      opacity: 0.82,
      interactive: true,
      pane: 'orthophotoPane',
      zIndex: 20 + index,
    }).addTo(activeMap)
    const element = overlay.getElement()
    element?.classList.add('orthophoto-overlay-image')
    overlay.on('mouseover', () => overlay.getElement()?.classList.add('orthophoto-overlay-hover'))
    overlay.on('mouseout', () => overlay.getElement()?.classList.remove('orthophoto-overlay-hover'))
    orthophotoLayers.set(id, overlay)
  })

  // 已存在的 ImageOverlay 不会因为 props 顺序变化自动更新层级，必须手动同步 z-index。
  syncOrthophotoLayerStack()
  if (fit) fitSelectedOverlay()
}

function rebuildRegionLayer() {
  if (!regionLayer) return
  const layer = regionLayer
  layer.clearLayers()
  props.regions
    .filter((region) => region.visible && region.points.length >= 3)
    .forEach((region) => {
      layer.addLayer(L.polygon(region.points, {
        pane: 'regionPane',
        color: region.color,
        fillColor: region.color,
        fillOpacity: region.opacity,
        opacity: 0.95,
        weight: 2,
        interactive: false,
      }))
      region.points.forEach((point) => {
        layer.addLayer(L.circleMarker(point, {
          pane: 'regionPane',
          radius: 4,
          color: '#fff',
          fillColor: region.color,
          fillOpacity: 1,
          opacity: 1,
          weight: 2,
          interactive: false,
        }))
      })
    })
}

function redrawDraft() {
  if (!draftLayer) return
  const layer = draftLayer
  layer.clearLayers()

  if (draftPoints.value.length >= 2) {
    layer.addLayer(L.polyline(draftPoints.value, {
      pane: 'regionPane',
      color: regionColor.value,
      weight: 2,
      dashArray: '6 5',
      interactive: false,
    }))
  }
  if (draftPoints.value.length >= 3) {
    layer.addLayer(L.polygon(draftPoints.value, {
      pane: 'regionPane',
      color: regionColor.value,
      fillColor: regionColor.value,
      fillOpacity: regionOpacity.value,
      weight: 2,
      interactive: false,
    }))
  }
  draftPoints.value.forEach((point) => {
    layer.addLayer(L.circleMarker(point, {
      pane: 'regionPane',
      radius: 4,
      color: '#fff',
      fillColor: regionColor.value,
      fillOpacity: 1,
      weight: 2,
      interactive: false,
    }))
  })
}

function startDrawing() {
  drawing.value = true
  draftPoints.value = []
  map?.doubleClickZoom.disable()
  redrawDraft()
}

function stopDrawing() {
  drawing.value = false
  draftPoints.value = []
  map?.doubleClickZoom.enable()
  redrawDraft()
}

function handleMapClick(event: LeafletMouseEvent) {
  if (!drawing.value) return
  // Leaflet 与 LatLng 均固定使用 [纬度, 经度]，不要与 GeoJSON 顺序混用。
  draftPoints.value = [...draftPoints.value, [event.latlng.lat, event.latlng.lng]]
  redrawDraft()
}

function undoDraftPoint() {
  draftPoints.value = draftPoints.value.slice(0, -1)
  redrawDraft()
}

function trimDuplicateDraftEnd() {
  const points = draftPoints.value
  if (points.length < 2) return
  const previous = points[points.length - 2]
  const last = points[points.length - 1]
  // 双击确认前 Leaflet 会先触发两次 click；若最后两个点重合，只保留第一次落点。
  if (Math.abs(previous[0] - last[0]) < 1e-9 && Math.abs(previous[1] - last[1]) < 1e-9) {
    draftPoints.value = points.slice(0, -1)
    redrawDraft()
  }
}

function finishDrawing() {
  if (draftPoints.value.length < 3) return
  const nextRegion: MapRegion = {
    id: crypto.randomUUID(),
    name: regionName.value.trim() || `区域 ${props.regions.length + 1}`,
    color: regionColor.value,
    opacity: regionOpacity.value,
    visible: true,
    points: draftPoints.value,
  }
  emit('region-create', nextRegion)
  regionName.value = ''
  stopDrawing()
}

function handleMapDoubleClick(event: LeafletMouseEvent) {
  if (!drawing.value) return
  event.originalEvent.preventDefault()
  trimDuplicateDraftEnd()
  finishDrawing()
}

function updateRegion(id: string, patch: Partial<MapRegion>) {
  emit('region-update', id, patch)
}

function deleteRegion(id: string) {
  emit('region-delete', id)
}

onMounted(() => {
  if (!mapElement.value) return

  map = L.map(mapElement.value, {
    center: [35.5, 105],
    zoom: 4,
    minZoom: 2,
    maxZoom: 20,
    zoomControl: true,
    attributionControl: false,
  })
  map.createPane('orthophotoPane').style.zIndex = '420'
  map.createPane('regionPane').style.zIndex = '680'

  const token = import.meta.env.VITE_TIANDITU_TOKEN ?? ''
  const subdomains = ['0', '1', '2', '3', '4', '5', '6', '7']
  // 天地图影像底图和中文标注是两个瓦片层，叠加后保持原地图语义不变。
  L.tileLayer(
    `https://t{s}.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=${token}`,
    { subdomains, maxZoom: 18 },
  ).addTo(map)
  L.tileLayer(
    `https://t{s}.tianditu.gov.cn/DataServer?T=cia_w&x={x}&y={y}&l={z}&tk=${token}`,
    { subdomains, maxZoom: 18, pane: 'overlayPane' },
  ).addTo(map)

  markerLayer = L.layerGroup().addTo(map)
  regionLayer = L.layerGroup().addTo(map)
  draftLayer = L.layerGroup().addTo(map)
  map.on('click', handleMapClick)
  map.on('dblclick', handleMapDoubleClick)
  rebuildMarkers()
  rebuildOrthophotoOverlays(true)
  rebuildRegionLayer()
  void resolvePlaceName(selected.value)
})

watch([() => props.images, () => props.selectedId], ([, id], [, previousId]) => {
  rebuildMarkers()
  rebuildOrthophotoOverlays(id !== previousId)
  void resolvePlaceName(selected.value)
})

watch(() => props.visibleOrthophotoIds, () => rebuildOrthophotoOverlays(false))
watch(() => props.regions, rebuildRegionLayer)

watch([regionColor, regionOpacity], () => redrawDraft())

onBeforeUnmount(() => {
  map?.off('click', handleMapClick)
  map?.off('dblclick', handleMapDoubleClick)
  map?.remove()
  map = null
})
</script>

<template>
  <section class="orthophoto-workspace" aria-label="正射地图查看区">
    <div ref="mapElement" class="orthophoto-map" :class="{ drawing }" />

    <div class="map-status-panel">
      <div class="map-status-heading">
        <span><Layers3 :size="17" /></span>
        <div>
          <strong>{{ selected?.name ?? '尚未选择影像' }}</strong>
          <template v-if="selected">
            <small class="coordinate-line">{{ coordinateText(selected) }}</small>
            <small>{{ placeText(selected) }}</small>
          </template>
          <small v-else>从影像库添加影像</small>
        </div>
      </div>

      <template v-if="selected">
        <div class="map-metadata">
          <span><MapPin :size="14" /> GPS</span>
          <strong>已提取</strong>
          <span><Navigation :size="14" /> 航向</span>
          <strong>{{ formatHeading(selected.heading) }}°</strong>
          <span>投影高度</span>
          <strong>{{ projectionHeightText(selected) }}</strong>
        </div>

        <div v-if="nearbyImages.length > 1" class="nearby-selector">
          <span>20 米内有 {{ nearbyImages.length }} 幅影像</span>
          <div>
            <button
              v-for="(image, index) in nearbyImages"
              :key="image.id"
              type="button"
              :class="{ active: image.id === selected.id }"
              @click="emit('select', image.id)"
            >
              影像 {{ index + 1 }}
            </button>
          </div>
        </div>
      </template>
    </div>

    <div class="layer-panel">
      <div class="tool-heading">
        <strong>正射图层</strong>
        <span>{{ visibleOrthophotoIds.length }} / {{ images.length }}</span>
      </div>
      <div class="orthophoto-layer-list">
        <label v-for="image in images" :key="image.id" :class="{ active: isOrthophotoVisible(image.id) }">
          <input
            type="checkbox"
            :checked="isOrthophotoVisible(image.id)"
            @change="emit('toggle-orthophoto', image.id)"
          />
          <span>{{ image.name }}</span>
        </label>
      </div>
    </div>

    <div class="region-panel">
      <div class="tool-heading">
        <strong>区域图层</strong>
        <span>下载在影像库内</span>
      </div>

      <div class="draw-controls">
        <input v-model="regionName" type="text" placeholder="区域名称" />
        <div class="region-style-row">
          <input v-model="regionColor" type="color" title="区域颜色" aria-label="区域颜色" />
          <label>
            <span>透明度 {{ Math.round(regionOpacity * 100) }}%</span>
            <input v-model.number="regionOpacity" type="range" min="0.05" max="0.9" step="0.05" />
          </label>
        </div>
        <div class="draw-buttons">
          <button v-if="!drawing" type="button" @click="startDrawing"><PenTool :size="14" /> 开始描绘</button>
          <template v-else>
            <button type="button" :disabled="draftPoints.length < 3" aria-label="保存当前" @click="finishDrawing">保存确认</button>
            <button type="button" :disabled="draftPoints.length === 0" title="撤销上一点" aria-label="撤销上一点" @click="undoDraftPoint">
              <Undo2 :size="14" />
            </button>
            <button type="button" title="取消描绘" aria-label="取消描绘" @click="stopDrawing">
              <X :size="14" />
            </button>
          </template>
        </div>
      </div>

      <div class="region-list">
        <article v-for="region in regions" :key="region.id">
          <button
            type="button"
            :title="region.visible ? '隐藏区域' : '显示区域'"
            :aria-label="region.visible ? '隐藏区域' : '显示区域'"
            @click="updateRegion(region.id, { visible: !region.visible })"
          >
            <Eye v-if="region.visible" :size="14" />
            <EyeOff v-else :size="14" />
          </button>
          <input type="text" :value="region.name" @change="updateRegion(region.id, { name: ($event.target as HTMLInputElement).value })" />
          <input :value="region.color" type="color" @input="updateRegion(region.id, { color: ($event.target as HTMLInputElement).value })" />
          <input
            :value="region.opacity"
            type="range"
            min="0.05"
            max="0.9"
            step="0.05"
            title="透明度"
            aria-label="透明度"
            @input="updateRegion(region.id, { opacity: Number(($event.target as HTMLInputElement).value) })"
          />
          <button type="button" class="danger" title="删除区域" aria-label="删除区域" @click="deleteRegion(region.id)">
            <Trash2 :size="14" />
          </button>
        </article>
      </div>
    </div>

    <div class="map-legend">
      <span><i class="legend-overlay" /> 正射图层</span>
      <span><i class="legend-region" /> 区域图层</span>
      <span><i class="legend-point" /> 全景拍摄点</span>
    </div>
  </section>
</template>

<style scoped>
.orthophoto-workspace,
.orthophoto-map {
  position: absolute;
  inset: 0;
}

.orthophoto-workspace {
  overflow: hidden;
  background: #d7dcde;
}

.orthophoto-map {
  z-index: 0;
}

.orthophoto-map.drawing {
  cursor: crosshair;
}

.map-status-panel,
.layer-panel,
.region-panel,
.map-legend {
  position: absolute;
  z-index: 700;
  color: #172027;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid #cbd3d7;
  box-shadow: 0 10px 30px rgba(20, 31, 38, 0.16);
}

.map-status-panel {
  top: 18px;
  left: 58px;
  width: 286px;
  padding: 14px;
}

.map-status-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}

.map-status-heading > span {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: #171c1f;
  background: #ffb02e;
}

.map-status-heading div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.map-status-heading strong,
.map-status-heading small {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.map-status-heading strong { font-size: 13px; }
.map-status-heading small { color: #75828a; font: 10px/1.2 var(--font-mono); }
.map-status-heading .coordinate-line { color: #45525a; }

.map-metadata {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 7px 12px;
  margin-top: 13px;
  padding-top: 11px;
  border-top: 1px solid #e0e5e7;
  font-size: 10px;
}

.map-metadata span {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #71808a;
}

.map-metadata strong { font-size: 10px; }

.nearby-selector {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px solid #e0e5e7;
}

.nearby-selector > span,
.tool-heading span {
  color: #7a858c;
  font-size: 10px;
}

.nearby-selector div {
  display: flex;
  gap: 5px;
  margin-top: 8px;
}

.nearby-selector button,
.draw-buttons button,
.region-list button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  padding: 0 9px;
  color: #46545d;
  background: #f4f6f7;
  border: 1px solid #d8dee1;
  font-size: 10px;
  cursor: pointer;
}

.nearby-selector button.active {
  color: #211a0d;
  background: #ffb02e;
  border-color: #e99b1f;
}

.layer-panel {
  top: 18px;
  right: 18px;
  width: 300px;
  padding: 12px;
}

.region-panel {
  top: 210px;
  right: 18px;
  display: grid;
  gap: 10px;
  width: 300px;
  max-height: calc(100% - 286px);
  padding: 12px;
}

.tool-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.tool-heading strong {
  font-size: 12px;
}

.orthophoto-layer-list,
.region-list {
  display: grid;
  gap: 6px;
  max-height: 180px;
  margin-top: 9px;
  overflow: auto;
}

.orthophoto-layer-list label {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  min-height: 32px;
  padding: 4px 5px 4px 8px;
  background: #f7f9fa;
  border: 1px solid #dde4e7;
  font-size: 10px;
}

.orthophoto-layer-list label.active {
  border-color: #e5a13a;
  box-shadow: inset 3px 0 #ffb02e;
}

.orthophoto-layer-list span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.draw-controls {
  display: grid;
  gap: 8px;
  padding-top: 9px;
  border-top: 1px solid #e0e5e7;
}

.draw-controls input[type='text'],
.region-list input[type='text'] {
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid #d7dee2;
  font-size: 10px;
}

.region-style-row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.region-style-row input[type='color'],
.region-list input[type='color'] {
  width: 30px;
  height: 28px;
  padding: 0;
  border: 1px solid #d7dee2;
}

.region-style-row label {
  display: grid;
  gap: 3px;
  color: #70808a;
  font-size: 9px;
}

.draw-buttons {
  display: flex;
  gap: 6px;
}

.draw-buttons button:first-child {
  flex: 1;
}

.draw-buttons button:disabled {
  opacity: 0.52;
  cursor: not-allowed;
}

.region-list {
  max-height: 260px;
}

.region-list article {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 30px 56px 28px;
  align-items: center;
  gap: 5px;
}

.region-list input[type='range'] {
  min-width: 0;
}

.region-list .danger:hover {
  color: #b42318;
  background: #fff1f0;
  border-color: #f0c0bc;
}

.map-legend {
  right: 18px;
  bottom: 18px;
  display: flex;
  gap: 14px;
  padding: 9px 11px;
  color: #5e6b73;
  font-size: 9px;
}

.map-legend span { display: flex; align-items: center; gap: 6px; }
.map-legend i { display: inline-block; width: 10px; height: 10px; }
.legend-overlay { background: rgba(255, 176, 46, 0.82); border: 1px solid #c97807; }
.legend-region { background: rgba(255, 77, 79, 0.35); border: 1px solid #ff4d4f; }
.legend-point { border-radius: 50%; background: #26353e; border: 2px solid #fff; }

@media (max-height: 760px) {
  /* 矮视口内让图层列表自身滚动，避免与下方的区域面板重叠。 */
  .orthophoto-layer-list { max-height: 128px; }
}

:global(.image-map-marker-host) { background: transparent; border: 0; }
:global(.image-map-marker-host.leaflet-interactive),
:global(.image-map-marker-host.leaflet-interactive .image-map-marker) {
  cursor: default;
}
.orthophoto-map.drawing :global(.image-map-marker-host.leaflet-interactive),
.orthophoto-map.drawing :global(.image-map-marker-host.leaflet-interactive .image-map-marker) {
  cursor: crosshair;
}
:global(.image-map-marker) {
  display: block;
  width: 30px;
  height: 30px;
  color: #fff;
  background: #26353e;
  border: 2px solid #fff;
  border-radius: 50% 50% 50% 3px;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.32);
  transform: rotate(-45deg);
}
:global(.image-map-marker.is-selected) { color: #171c1f; background: #ffb02e; }
:global(.orthophoto-overlay-image) {
  outline: 0 solid transparent;
  outline-offset: -2px;
  transition: outline-color 120ms ease, outline-width 120ms ease, filter 120ms ease;
}
:global(.orthophoto-overlay-hover) {
  outline: 3px solid #ffb02e;
  filter: saturate(1.08) contrast(1.03);
}
</style>
