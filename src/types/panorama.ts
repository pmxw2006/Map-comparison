export interface ViewState {
  yaw: number
  pitch: number
  fov: number
}

export interface PanoramaItem {
  id: string
  name: string
  tag: string
  detail: string
  src: string
  fileName: string
  northOffset: number
  downloadUrl: string
  createdAt: string
  latitude: number | null
  longitude: number | null
  absoluteAltitude: number | null
  relativeAltitude: number | null
  projectionAltitude: number
  heading: number | null
  orthophotoStatus: 'ready' | 'unsupported' | 'processing' | 'failed'
  orthophotoKind: 'nadir_preview' | 'survey_orthophoto' | null
  orthophotoUrl: string | null
  orthophotoDownloadUrl: string | null
  overlayBounds: [[number, number], [number, number]] | null
  nearbyIds: string[]
}

export interface StoredImageDto {
  id: string
  name: string
  file_name: string
  mime_type: string
  file_size: number
  width: number
  height: number
  created_at: string
  latitude: number | null
  longitude: number | null
  absolute_altitude: number | null
  relative_altitude: number | null
  projection_altitude: number
  heading: number | null
  north_offset: number
  image_url: string
  download_url: string
  orthophoto_status: PanoramaItem['orthophotoStatus']
  orthophoto_kind: PanoramaItem['orthophotoKind']
  orthophoto_url: string | null
  orthophoto_download_url: string | null
  overlay_bounds: PanoramaItem['overlayBounds']
  nearby_ids: string[]
}

export interface MapRegion {
  id: string
  name: string
  color: string
  opacity: number
  visible: boolean
  points: Array<[number, number]>
}

export interface PanoramaViewerExpose {
  getCanvas: () => HTMLCanvasElement | null
  renderNow: () => void
}
