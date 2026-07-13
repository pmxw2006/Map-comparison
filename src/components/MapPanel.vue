<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LocateFixed, X } from '@lucide/vue'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { GeoCoordinate } from '../types/panorama'

const props = defineProps<{
  token: string
  coordinate: GeoCoordinate
}>()

const emit = defineEmits<{
  close: []
  'update:coordinate': [coordinate: GeoCoordinate]
}>()

const mapElement = ref<HTMLDivElement | null>(null)
const latitude = ref(props.coordinate.lat)
const longitude = ref(props.coordinate.lng)
let map: L.Map | null = null
let marker: L.CircleMarker | null = null

function setMarker(coordinate: GeoCoordinate, center = false) {
  latitude.value = Number(coordinate.lat.toFixed(6))
  longitude.value = Number(coordinate.lng.toFixed(6))
  marker?.setLatLng([coordinate.lat, coordinate.lng])
  if (center) map?.panTo([coordinate.lat, coordinate.lng])
}

function applyCoordinate() {
  const lat = Math.min(90, Math.max(-90, Number(latitude.value)))
  const lng = Math.min(180, Math.max(-180, Number(longitude.value)))
  const coordinate = { lat, lng }
  setMarker(coordinate, true)
  emit('update:coordinate', coordinate)
}

onMounted(async () => {
  await nextTick()
  if (!mapElement.value || !props.token) return

  map = L.map(mapElement.value, {
    attributionControl: false,
    zoomControl: false,
    minZoom: 2,
  }).setView([props.coordinate.lat, props.coordinate.lng], 14)

  // 天地图的底图和中文注记是独立 WMTS 图层，每种底图都用图层组配对。
  const createTdtLayer = (layer: 'img' | 'cia' | 'vec' | 'cva') =>
    L.tileLayer(
      `https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk=${encodeURIComponent(props.token)}`,
      {
        subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
        maxZoom: 18,
        crossOrigin: true,
      },
    )

  const vectorGroup = L.layerGroup([createTdtLayer('vec'), createTdtLayer('cva')]).addTo(map)
  const imageryGroup = L.layerGroup([createTdtLayer('img'), createTdtLayer('cia')])
  L.control.layers({ 矢量: vectorGroup, 影像: imageryGroup }, undefined, {
    position: 'topright',
    collapsed: true,
  }).addTo(map)
  L.control.zoom({ position: 'bottomright' }).addTo(map)
  L.control.attribution({ position: 'bottomleft', prefix: false }).addAttribution('天地图').addTo(map)

  marker = L.circleMarker([props.coordinate.lat, props.coordinate.lng], {
    radius: 8,
    color: '#ffffff',
    weight: 3,
    fillColor: '#ff9f1a',
    fillOpacity: 1,
  }).addTo(map)

  map.on('click', (event: L.LeafletMouseEvent) => {
    const coordinate = { lat: event.latlng.lat, lng: event.latlng.lng }
    setMarker(coordinate)
    emit('update:coordinate', coordinate)
  })
})

watch(
  () => props.coordinate,
  (coordinate) => setMarker(coordinate),
  { deep: true },
)

onBeforeUnmount(() => map?.remove())
</script>

<template>
  <aside class="map-panel" aria-label="天地图点位定位">
    <header>
      <div>
        <strong>点位定位</strong>
        <span>天地图底图</span>
      </div>
      <button type="button" title="关闭地图" aria-label="关闭地图" @click="emit('close')">
        <X :size="19" />
      </button>
    </header>

    <div class="coordinate-editor">
      <label>
        <span>纬度</span>
        <input v-model.number="latitude" type="number" min="-90" max="90" step="0.000001" />
      </label>
      <label>
        <span>经度</span>
        <input v-model.number="longitude" type="number" min="-180" max="180" step="0.000001" />
      </label>
      <button type="button" title="定位到坐标" aria-label="定位到坐标" @click="applyCoordinate">
        <LocateFixed :size="18" />
      </button>
    </div>

    <div v-if="!token" class="map-token-warning">未配置天地图令牌</div>
    <div ref="mapElement" class="map-canvas" />
  </aside>
</template>

<style scoped>
.map-panel {
  position: absolute;
  z-index: 10;
  top: 12px;
  right: 12px;
  bottom: 12px;
  display: grid;
  grid-template-rows: 58px auto 1fr;
  width: min(390px, calc(100% - 24px));
  overflow: hidden;
  color: #172027;
  background: #fff;
  border: 1px solid #cbd3d8;
  box-shadow: 0 18px 48px rgba(8, 15, 20, 0.28);
}

.map-panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px 0 16px;
  border-bottom: 1px solid #e3e8eb;
}

.map-panel header div {
  display: grid;
  gap: 1px;
}

.map-panel header strong {
  font-size: 14px;
}

.map-panel header span {
  color: #7a8790;
  font-size: 10px;
}

.map-panel button {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  color: #41505a;
  background: transparent;
  border: 1px solid #d7dde1;
  cursor: pointer;
}

.map-panel button:hover {
  color: #11181d;
  background: #f2f5f6;
}

.coordinate-editor {
  display: grid;
  grid-template-columns: 1fr 1fr 36px;
  gap: 8px;
  align-items: end;
  padding: 12px;
  background: #f7f9fa;
  border-bottom: 1px solid #dfe5e8;
}

.coordinate-editor label {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.coordinate-editor label span {
  color: #728089;
  font-size: 10px;
}

.coordinate-editor input {
  min-width: 0;
  width: 100%;
  height: 36px;
  padding: 0 9px;
  color: #1b252b;
  background: #fff;
  border: 1px solid #ced6da;
  border-radius: 0;
  font: 500 11px/1 var(--font-mono);
  box-sizing: border-box;
}

.map-canvas {
  min-height: 0;
  background: #e5ebee;
}

.map-token-warning {
  display: grid;
  place-items: center;
  color: #9a3412;
  background: #fff7ed;
  font-size: 12px;
}

:deep(.leaflet-control-zoom a) {
  color: #26343c;
}

:deep(.leaflet-control-attribution) {
  font-size: 9px;
}

:deep(.leaflet-control-layers) {
  border: 1px solid #cfd7db;
  border-radius: 0;
  box-shadow: none;
}

@media (max-width: 720px) {
  .map-panel { top: 8px; right: 8px; bottom: 8px; width: calc(100% - 16px); }
}
</style>
