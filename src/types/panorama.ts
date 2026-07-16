export type LatLng = [latitude: number, longitude: number]

export type Bounds = [southWest: LatLng, northEast: LatLng]

export interface ViewState {
  yaw: number
  pitch: number
  fov: number
}

export interface ImageRecord {
  id: string
  name: string
  fileName: string
  fileSize: number
  width: number
  height: number
  latitude: number
  longitude: number
  absoluteAltitude: number | null
  relativeAltitude: number | null
  projectionAltitude: number
  heading: number
  // 全景球体正面与相机零度相差 180 度，northOffset 是已经校正后的查看器方位偏移。
  northOffset: number
  imageUrl: string
  downloadUrl: string
  orthophotoUrl: string
  orthophotoDownloadUrl: string
  overlayBounds: Bounds
  nearbyIds: string[]
}

export interface CatalogResponse {
  images: ImageRecord[]
  changedIds: string[]
}

export interface MapRegion {
  id: string
  name: string
  color: string
  opacity: number
  visible: boolean
  // 固定使用 [纬度, 经度]，与 Leaflet 的坐标顺序一致。
  points: LatLng[]
}

export interface PanoramaViewerExpose {
  getCanvas: () => HTMLCanvasElement | null
  renderNow: () => void
}
