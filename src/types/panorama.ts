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
  isObjectUrl?: boolean
}

export interface PanoramaViewerExpose {
  getCanvas: () => HTMLCanvasElement | null
  renderNow: () => void
}
