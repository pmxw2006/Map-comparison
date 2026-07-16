import type { ImageRecord, LatLng } from './types/panorama'

const METERS_PER_LATITUDE_DEGREE = 111_320
const MIN_LONGITUDE_SCALE = 0.1

type ProjectionImage = Pick<
  ImageRecord,
  'latitude' | 'longitude' | 'projectionAltitude' | 'northOffset'
>

export function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360
}

export function signedDegrees(value: number): number {
  return ((value + 540) % 360) - 180
}

export function formatHeading(value: number): string {
  return String(normalizeDegrees(Math.round(value))).padStart(3, '0')
}

function longitudeScale(latitude: number): number {
  return METERS_PER_LATITUDE_DEGREE * Math.max(MIN_LONGITUDE_SCALE, Math.cos((latitude * Math.PI) / 180))
}

export function groundPointToView(
  image: ProjectionImage,
  point: LatLng,
): { yaw: number; pitch: number; distance: number } {
  // 局部平面以北为 +Y、东为 +X；bearing 从正北顺时针增加，再减去全景方位偏移得到 yaw。
  const north = (point[0] - image.latitude) * METERS_PER_LATITUDE_DEGREE
  const east = (point[1] - image.longitude) * longitudeScale(image.latitude)
  const distance = Math.hypot(east, north)
  const bearing = normalizeDegrees((Math.atan2(east, north) * 180) / Math.PI)

  return {
    yaw: normalizeDegrees(bearing - image.northOffset),
    pitch: -(Math.atan2(image.projectionAltitude, distance) * 180) / Math.PI,
    distance,
  }
}

export function viewToGroundPoint(
  image: ProjectionImage,
  yaw: number,
  pitch: number,
): LatLng | null {
  // 只有向下的视线能与假定的水平地面相交；近地平线时误差会快速放大，因此留出 0.5 度余量。
  if (pitch >= -0.5) return null

  const distance = image.projectionAltitude / Math.tan((-pitch * Math.PI) / 180)
  if (!Number.isFinite(distance) || distance <= 0) return null

  const bearing = normalizeDegrees(yaw + image.northOffset)
  const bearingRadians = (bearing * Math.PI) / 180
  const east = distance * Math.sin(bearingRadians)
  const north = distance * Math.cos(bearingRadians)

  return [
    image.latitude + north / METERS_PER_LATITUDE_DEGREE,
    image.longitude + east / longitudeScale(image.latitude),
  ]
}
