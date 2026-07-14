<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ImageOff, Layers3, MapPin, Navigation } from '@lucide/vue'
import L, { type ImageOverlay, type LayerGroup, type Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { PanoramaItem } from '../types/panorama'

const props = defineProps<{
  images: PanoramaItem[]
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

const mapElement = ref<HTMLDivElement | null>(null)
let map: LeafletMap | null = null
let markerLayer: LayerGroup | null = null
let imageOverlay: ImageOverlay | null = null

const selected = computed(() => props.images.find((image) => image.id === props.selectedId) ?? null)
const nearbyImages = computed(() => {
  if (!selected.value) return []
  const ids = new Set([selected.value.id, ...selected.value.nearbyIds])
  return props.images.filter((image) => ids.has(image.id) && image.latitude !== null && image.longitude !== null)
})

function coordinateText(image: PanoramaItem) {
  if (image.latitude === null || image.longitude === null) return '未提取到 GPS'
  return `${image.latitude.toFixed(6)}, ${image.longitude.toFixed(6)}`
}

function projectionHeightText(image: PanoramaItem) {
  const height = `${Math.round(image.projectionAltitude)} m`
  return image.relativeAltitude === null ? `${height}（默认）` : height
}

function rebuildMarkers() {
  if (!map || !markerLayer) return
  const markers = markerLayer
  markers.clearLayers()

  props.images.forEach((image, index) => {
    if (image.latitude === null || image.longitude === null) return
    const marker = L.marker([image.latitude, image.longitude], {
      icon: L.divIcon({
        className: 'image-map-marker-host',
        html: `<span class="image-map-marker${image.id === props.selectedId ? ' is-selected' : ''}"><b>${index + 1}</b></span>`,
        iconSize: [30, 36],
        iconAnchor: [15, 34],
      }),
      title: image.name,
    })
    marker.on('click', () => emit('select', image.id))
    marker.bindTooltip(image.name, { direction: 'top', offset: [0, -30] })
    marker.addTo(markers)
  })
}

function showSelectedOverlay(fit = false) {
  if (!map) return
  if (imageOverlay) {
    imageOverlay.removeFrom(map)
    imageOverlay = null
  }

  const image = selected.value
  if (!image?.orthophotoUrl || !image.overlayBounds) return
  imageOverlay = L.imageOverlay(image.orthophotoUrl, image.overlayBounds, {
    opacity: 0.86,
    interactive: true,
    zIndex: 5,
  }).addTo(map)
  imageOverlay.bindTooltip(`${image.name} · 500 m × 500 m 地面反投影`)
  if (fit) map.fitBounds(image.overlayBounds, { padding: [70, 70], maxZoom: 19 })
}

onMounted(async () => {
  await nextTick()
  if (!mapElement.value) return

  map = L.map(mapElement.value, {
    center: [35.5, 105],
    zoom: 4,
    minZoom: 2,
    maxZoom: 20,
    zoomControl: true,
    attributionControl: false,
  })

  const token = import.meta.env.VITE_TIANDITU_TOKEN ?? ''
  const subdomains = ['0', '1', '2', '3', '4', '5', '6', '7']
  L.tileLayer(
    `https://t{s}.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=${token}`,
    { subdomains, maxZoom: 18 },
  ).addTo(map)
  L.tileLayer(
    `https://t{s}.tianditu.gov.cn/DataServer?T=cia_w&x={x}&y={y}&l={z}&tk=${token}`,
    { subdomains, maxZoom: 18, pane: 'overlayPane' },
  ).addTo(map)

  markerLayer = L.layerGroup().addTo(map)
  rebuildMarkers()
  showSelectedOverlay(true)
})

watch(
  () => props.images,
  () => {
    rebuildMarkers()
    showSelectedOverlay(false)
  },
  { deep: true },
)

watch(
  () => props.selectedId,
  () => {
    rebuildMarkers()
    showSelectedOverlay(true)
  },
)

onBeforeUnmount(() => {
  map?.remove()
  map = null
})
</script>

<template>
  <section class="orthophoto-workspace" aria-label="正射地图查看区">
    <div ref="mapElement" class="orthophoto-map" />

    <div class="map-status-panel">
      <div class="map-status-heading">
        <span><Layers3 :size="17" /></span>
        <div>
          <strong>{{ selected?.name ?? '尚未选择影像' }}</strong>
          <small>{{ selected ? coordinateText(selected) : '从影像库添加影像' }}</small>
        </div>
      </div>

      <template v-if="selected">
        <div class="map-metadata">
          <span><MapPin :size="14" /> GPS</span>
          <strong>{{ selected.latitude === null ? '无' : '已提取' }}</strong>
          <span><Navigation :size="14" /> 航向</span>
          <strong>{{ selected.heading === null ? '无' : `${Math.round(selected.heading)}°` }}</strong>
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

    <div
      v-if="selected && (selected.latitude === null || selected.longitude === null)"
      class="unlocated-preview"
    >
      <img v-if="selected.orthophotoUrl" :src="selected.orthophotoUrl" :alt="`${selected.name}地面反投影预览`" />
      <ImageOff v-else :size="34" />
      <div>
        <strong>{{ selected.orthophotoUrl ? '500 m × 500 m 地面反投影已生成' : '无法生成地面反投影' }}</strong>
        <span>原图没有可用 GPS，暂时不能覆盖到天地图</span>
      </div>
    </div>

    <div class="map-legend">
      <span><i class="legend-overlay" /> 当前正射预览</span>
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

.map-status-panel,
.map-legend,
.unlocated-preview {
  position: absolute;
  z-index: 500;
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

.nearby-selector > span {
  color: #7a858c;
  font-size: 10px;
}

.nearby-selector div {
  display: flex;
  gap: 5px;
  margin-top: 8px;
}

.nearby-selector button {
  height: 28px;
  padding: 0 10px;
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

.unlocated-preview {
  top: 50%;
  left: 50%;
  display: grid;
  grid-template-columns: 220px 1fr;
  align-items: center;
  width: 500px;
  min-height: 190px;
  overflow: hidden;
  transform: translate(-50%, -50%);
}

.unlocated-preview img {
  width: 220px;
  height: 190px;
  object-fit: cover;
}

.unlocated-preview > svg {
  justify-self: center;
  color: #929da3;
}

.unlocated-preview div {
  display: grid;
  gap: 6px;
  padding: 20px;
}

.unlocated-preview strong { font-size: 13px; }
.unlocated-preview span { color: #71808a; font-size: 11px; line-height: 1.6; }

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
.legend-point { border-radius: 50%; background: #26353e; border: 2px solid #fff; }

:global(.image-map-marker-host) { background: transparent; border: 0; }
:global(.image-map-marker) {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: #fff;
  background: #26353e;
  border: 2px solid #fff;
  border-radius: 50% 50% 50% 3px;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.32);
  transform: rotate(-45deg);
  font: 700 10px/1 var(--font-mono);
}
:global(.image-map-marker b) { transform: rotate(45deg); }
:global(.image-map-marker.is-selected) { color: #171c1f; background: #ffb02e; }
</style>
