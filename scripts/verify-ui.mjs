import { mkdir, readFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const baseUrl = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const apiUrl = new URL('/api/images', baseUrl).href
const artifactDir = process.env.ARTIFACT_DIR ?? '/tmp/duibi-ui-check'
const uploadedIds = []
const runId = Date.now().toString(36)
const groupANames = [`verify-${runId}-a1.png`, `verify-${runId}-a2.png`, `verify-${runId}-a3.png`]
const groupBNames = [`verify-${runId}-b1.png`, `verify-${runId}-b2.png`]
const uploadNames = [...groupANames, ...groupBNames]

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type)
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  name.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return chunk
}

function makeVerifyPanorama(
  width = 1600,
  height = 800,
  latitude = 31.2304,
  longitude = 121.4737,
  heading = 18,
) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3
      const ratio = x / width
      // 源图中心为北、右侧为东；四个宽色带让正射图方向可通过像素直接验证。
      const base = ratio < 0.125 || ratio >= 0.875
        ? [40, 90, 220]
        : ratio < 0.375
          ? [240, 200, 40]
          : ratio < 0.625
            ? [230, 40, 40]
            : [40, 190, 80]
      raw[offset] = Math.max(0, Math.min(255, base[0] + ((x * 7 + y * 3) % 31) - 15))
      raw[offset + 1] = Math.max(0, Math.min(255, base[1] + ((x * 5 + y * 11) % 31) - 15))
      raw[offset + 2] = Math.max(0, Math.min(255, base[2] + ((x * 13 + y * 2) % 31) - 15))
    }
  }

  // 直接生成 2:1 PNG，避免验证流程依赖 public 目录中的旧示例图片。
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const xmp = Buffer.from(
    `<x:xmpmeta drone-dji:GPSLatitude="${latitude.toFixed(6)}" drone-dji:GPSLongitude="${longitude.toFixed(6)}" drone-dji:RelativeAltitude="120.0" drone-dji:AbsoluteAltitude="132.5" drone-dji:GimbalYawDegree="${heading.toFixed(1)}"></x:xmpmeta>`,
  )
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND'),
    xmp,
  ])
}

const sampleBuffer = makeVerifyPanorama()
// A 位于中点，B/C 分居南北约 15 米；B/C 相距约 30 米，用来区分锚点分组与传递聚类。
const alternateHeadingBuffer = makeVerifyPanorama(1600, 800, 31.230265, 121.4737, -72)
const starThirdBuffer = makeVerifyPanorama(1600, 800, 31.230535, 121.4737)
const secondLocationBuffer = makeVerifyPanorama(1600, 800, 31.2324, 121.4737)
const invalidRatioBuffer = makeVerifyPanorama(800, 800)

function assertCatalog(payload, label) {
  if (!payload || !Array.isArray(payload.images) || !Array.isArray(payload.changedIds)) {
    throw new Error(`${label} did not return a camelCase CatalogResponse: ${JSON.stringify(payload)}`)
  }
  return payload
}

async function fetchCatalog() {
  const response = await fetch(apiUrl)
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`Catalog request failed (${response.status}): ${JSON.stringify(payload)}`)
  return assertCatalog(payload, 'GET /api/images')
}

async function verifyAtomicInvalidBatch() {
  const before = await fetchCatalog()
  const form = new FormData()
  form.append('files', new Blob([sampleBuffer], { type: 'image/png' }), `atomic-${runId}-valid.png`)
  form.append('files', new Blob([invalidRatioBuffer], { type: 'image/png' }), `atomic-${runId}-invalid.png`)
  const response = await fetch(apiUrl, { method: 'POST', body: form })
  const errorPayload = await response.json().catch(() => null)
  if (response.status !== 422) {
    throw new Error(`Invalid batch should return 422, received ${response.status}: ${JSON.stringify(errorPayload)}`)
  }

  const after = await fetchCatalog()
  const previousIds = new Set(before.images.map((image) => image.id))
  const leaked = after.images.filter((image) => !previousIds.has(image.id))
  uploadedIds.push(...leaked.map((image) => image.id))
  if (leaked.length) throw new Error(`Invalid batch was not atomic: ${JSON.stringify(leaked)}`)
  return response.status
}

async function sampleOrthophotoDirections(page, record) {
  const url = new URL(record.orthophotoUrl, baseUrl).href
  return page.evaluate(async (source) => {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`Orthophoto fetch failed: ${response.status}`)
    const bitmap = await createImageBitmap(await response.blob())
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas is unavailable')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const pixel = (x, y) => [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)]
    return {
      width: canvas.width,
      height: canvas.height,
      north: pixel(canvas.width * 0.5, canvas.height * 0.2),
      east: pixel(canvas.width * 0.8, canvas.height * 0.5),
      south: pixel(canvas.width * 0.5, canvas.height * 0.8),
      west: pixel(canvas.width * 0.2, canvas.height * 0.5),
    }
  }, url)
}

function assertDirectionPixels(samples) {
  const [nr, ng, nb] = samples.north
  const [er, eg, eb] = samples.east
  const [sr, sg, sb] = samples.south
  const [wr, wg, wb] = samples.west
  const valid = nr > 160 && nr - ng > 70 && nr - nb > 70
    && eg > 140 && eg - er > 60 && eg - eb > 60
    && sb > 160 && sb - sr > 80 && sb - sg > 60
    && wr > 160 && wg > 130 && wb < 100
  if (!valid) throw new Error(`Orthophoto direction pixel check failed: ${JSON.stringify(samples)}`)
}

async function panoramaScreenshotMetrics(page) {
  const canvases = page.locator('.panorama-stage canvas')
  const metrics = []
  for (let index = 0; index < 2; index += 1) {
    const png = await canvases.nth(index).screenshot({ path: `${artifactDir}/panorama-canvas-${index + 1}.png` })
    metrics.push(await page.evaluate(async (dataUrl) => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) return { colors: 0, range: 0 }
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let min = 255
      let max = 0
      const colors = new Set()
      for (let offset = 0; offset < pixels.length; offset += 388) {
        const lightness = (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3
        min = Math.min(min, lightness)
        max = Math.max(max, lightness)
        colors.add(`${pixels[offset] >> 4}-${pixels[offset + 1] >> 4}-${pixels[offset + 2] >> 4}`)
      }
      return { colors: colors.size, range: Math.round(max - min) }
    }, `data:image/png;base64,${png.toString('base64')}`))
  }
  return metrics
}

async function inspectImageDownload(page, download) {
  const path = await download.path()
  if (!path) throw new Error(`Download has no local path: ${download.suggestedFilename()}`)
  const bytes = await readFile(path)
  if (bytes.length < 10_000) throw new Error(`Downloaded comparison is too small: ${bytes.length} bytes`)
  const mimeType = /\.jpe?g$/i.test(download.suggestedFilename()) ? 'image/jpeg' : 'image/png'
  const metrics = await page.evaluate(async (dataUrl) => {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) return { width: 0, height: 0, colors: 0, range: 0 }
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let min = 255
    let max = 0
    const colors = new Set()
    for (let offset = 0; offset < pixels.length; offset += 388) {
      const lightness = (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3
      min = Math.min(min, lightness)
      max = Math.max(max, lightness)
      colors.add(`${pixels[offset] >> 4}-${pixels[offset + 1] >> 4}-${pixels[offset + 2] >> 4}`)
    }
    return { width: canvas.width, height: canvas.height, colors: colors.size, range: Math.round(max - min) }
  }, `data:${mimeType};base64,${bytes.toString('base64')}`)
  if (metrics.width < 800 || metrics.height < 300 || metrics.colors < 12 || metrics.range < 15) {
    throw new Error(`Downloaded comparison image check failed: ${JSON.stringify({ bytes: bytes.length, ...metrics })}`)
  }
  return { bytes: bytes.length, ...metrics }
}

async function assertViewportLayout(page, label, selectors, pairs) {
  const issues = await page.evaluate(({ elementSelectors, overlapPairs }) => {
    const bounds = (selector) => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) return null
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
        ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        : null
    }
    const result = []
    for (const selector of elementSelectors) {
      const rect = bounds(selector)
      if (!rect) result.push(`${selector} is missing or hidden`)
      else if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) {
        result.push(`${selector} exceeds viewport: ${JSON.stringify(rect)}`)
      }
    }
    for (const [leftSelector, rightSelector] of overlapPairs) {
      const left = bounds(leftSelector)
      const right = bounds(rightSelector)
      if (!left || !right) continue
      const width = Math.min(left.right, right.right) - Math.max(left.left, right.left)
      const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)
      if (width > 1 && height > 1) result.push(`${leftSelector} overlaps ${rightSelector}`)
    }
    return result
  }, { elementSelectors: selectors, overlapPairs: pairs })
  if (issues.length) throw new Error(`${label} layout check failed: ${issues.join('; ')}`)
  return { label, viewport: page.viewportSize(), checkedPairs: pairs.length }
}

async function waitForSelectedOrthophotoOnTop(page, records) {
  await page.waitForFunction((items) => {
    const selectedName = document.querySelector('.map-status-heading strong')?.textContent?.trim()
    const selected = items.find((item) => item.name === selectedName)
    if (!selected?.orthophotoUrl) return false

    const overlays = [...document.querySelectorAll('.leaflet-image-layer')]
      .filter((element) => element instanceof HTMLImageElement)
      .map((element) => ({
        src: element.src,
        zIndex: Number(element.style.zIndex || window.getComputedStyle(element).zIndex || 0),
      }))
      .filter((overlay) => Number.isFinite(overlay.zIndex))
      .sort((left, right) => right.zIndex - left.zIndex)

    return overlays[0]?.src.includes(selected.orthophotoUrl)
  }, records)
}

await mkdir(artifactDir, { recursive: true })

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'],
})

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
await page.addInitScript(() => window.localStorage.removeItem('duibi.mapRegions'))
const browserErrors = []
const failedResponses = []
page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`)
})
page.on('response', (response) => {
  if (response.status() >= 400 && response.url().startsWith(new URL(baseUrl).origin)) {
    failedResponses.push(`${response.status()} ${response.url()}`)
  }
})

let verificationResult = null
let verificationFailure = null
try {
  const atomicBatchStatus = await verifyAtomicInvalidBatch()
  const recordsBefore = await fetchCatalog()
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  if (recordsBefore.images.length === 0) {
    await page.getByText('影像库为空', { exact: true }).waitFor()
    await page.screenshot({ path: `${artifactDir}/empty-library.png` })
  }

  const uploadResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/images')
  await page.locator('input[type="file"]').setInputFiles([
    { name: uploadNames[0], mimeType: 'image/png', buffer: sampleBuffer },
    { name: uploadNames[1], mimeType: 'image/png', buffer: alternateHeadingBuffer },
    { name: uploadNames[2], mimeType: 'image/png', buffer: starThirdBuffer },
    { name: uploadNames[3], mimeType: 'image/png', buffer: secondLocationBuffer },
    { name: uploadNames[4], mimeType: 'image/png', buffer: secondLocationBuffer },
  ])
  const uploadResponse = await uploadResponsePromise
  const uploadPayload = assertCatalog(await uploadResponse.json(), 'POST /api/images')
  if (uploadResponse.status() !== 201) {
    throw new Error(`Persistent upload returned ${uploadResponse.status()}: ${JSON.stringify(uploadPayload)}`)
  }
  uploadedIds.push(...uploadPayload.changedIds)
  await page.getByText(/已永久保存 5 幅影像/).waitFor({ timeout: 90_000 })

  const createdIds = new Set(uploadPayload.changedIds)
  const created = uploadPayload.images.filter((record) => createdIds.has(record.id))
  if (created.length !== 5 || uploadPayload.changedIds.length !== 5) {
    throw new Error(`Persistent upload failed: ${JSON.stringify(created)}`)
  }
  if (created.some((record) => !record.orthophotoUrl || !record.overlayBounds || record.projectionAltitude !== 120)) {
    throw new Error(`GPS/XMP extraction failed: ${JSON.stringify(created)}`)
  }
  if (created.some((record) => {
    const heading = record.fileName === groupANames[1] ? -72 : 18
    const northOffset = ((heading + 180) % 360 + 360) % 360
    return record.heading !== heading || record.northOffset !== northOffset
  })) {
    throw new Error(`Direction metadata failed: ${JSON.stringify(created)}`)
  }
  const primaryRecord = created.find((record) => record.fileName === uploadNames[0])
  if (!primaryRecord) throw new Error(`Uploaded record is missing: ${uploadNames[0]}`)
  const groupARecords = groupANames.map((name) => created.find((record) => record.fileName === name))
  if (groupARecords.some((record) => !record)) {
    throw new Error(`Anchor group is incomplete: ${JSON.stringify(groupARecords)}`)
  }
  const [anchorRecord, anchorNeighbor, oppositeNeighbor] = groupARecords
  const validAnchorGraph = anchorRecord.nearbyIds.includes(anchorNeighbor.id)
    && anchorRecord.nearbyIds.includes(oppositeNeighbor.id)
    && anchorNeighbor.nearbyIds.includes(anchorRecord.id)
    && !anchorNeighbor.nearbyIds.includes(oppositeNeighbor.id)
    && oppositeNeighbor.nearbyIds.includes(anchorRecord.id)
    && !oppositeNeighbor.nearbyIds.includes(anchorNeighbor.id)
  if (!validAnchorGraph) throw new Error(`20 m anchor graph failed: ${JSON.stringify(groupARecords)}`)
  const groupBRecords = created.filter((record) => groupBNames.includes(record.fileName))
  if (groupBRecords.length !== 2) throw new Error(`Second location group is incomplete: ${JSON.stringify(groupBRecords)}`)

  await page.waitForFunction(() => {
    const canvases = [...document.querySelectorAll('.panorama-stage canvas')]
    return canvases.length === 3 && canvases.every((canvas) => canvas.width > 100 && canvas.height > 100)
  })
  await page.waitForFunction(() => document.querySelectorAll('.load-state').length === 0, null, {
    timeout: 30_000,
  })

  // preserveDrawingBuffer 关闭后帧缓冲不保证可读，截图能验证浏览器实际合成出的 canvas。
  const pixelMetrics = await panoramaScreenshotMetrics(page)
  if (pixelMetrics.some((metric) => metric.colors < 12 || metric.range < 15)) {
    throw new Error(`Panorama screenshot pixel check failed: ${JSON.stringify(pixelMetrics)}`)
  }
  const directionPixels = await sampleOrthophotoDirections(page, primaryRecord)
  assertDirectionPixels(directionPixels)

  const orientation = page.locator('.orientation-values strong')
  const beforeDrag = await orientation.allTextContents()
  if (beforeDrag.length !== 3 || beforeDrag.some((value) => value.trim() !== 'S 198°')) {
    throw new Error(`Panorama heading correction failed: ${JSON.stringify(beforeDrag)}`)
  }
  const stageBox = await page.locator('.panorama-stage').first().boundingBox()
  if (!stageBox) throw new Error('The first panorama stage has no layout box')
  await page.mouse.move(stageBox.x + stageBox.width * 0.55, stageBox.y + stageBox.height * 0.55)
  await page.mouse.down()
  await page.mouse.move(stageBox.x + stageBox.width * 0.35, stageBox.y + stageBox.height * 0.48, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  const afterDrag = await orientation.allTextContents()
  if (afterDrag[0] === beforeDrag[0] || afterDrag.some((value) => value !== afterDrag[0])) {
    throw new Error(`Panorama synchronization failed: ${JSON.stringify({ beforeDrag, afterDrag })}`)
  }

  const syncButton = page.getByRole('button', { name: '视角同步', exact: true })
  await syncButton.click()
  await page.getByText('独立视角', { exact: true }).waitFor()
  const independentBefore = await orientation.allTextContents()
  await page.locator('.panorama-stage').first().press('ArrowRight')
  await page.waitForTimeout(120)
  const independentAfter = await orientation.allTextContents()
  if (independentAfter[0] === independentBefore[0]
    || independentAfter[1] !== independentBefore[1]
    || independentAfter[0] === independentAfter[1]) {
    throw new Error(`Independent panorama view failed: ${JSON.stringify({ independentBefore, independentAfter })}`)
  }
  await syncButton.click()
  await page.getByText('视角同步中', { exact: true }).waitFor()
  await page.waitForFunction(() => {
    const values = [...document.querySelectorAll('.orientation-values strong')].map((node) => node.textContent)
    return values.length === 3 && values.every((value) => value === values[0])
  })

  await page.screenshot({ path: `${artifactDir}/panorama-comparison.png` })

  await page.locator('.panorama-panel').first().getByRole('button', { name: '归正' }).click()
  await page.locator('.panorama-panel').first().getByRole('button', { name: '全景描绘' }).click()
  const drawStageBox = await page.locator('.panorama-stage').first().boundingBox()
  if (!drawStageBox) throw new Error('The panorama drawing stage has no layout box')
  const regionCountBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('duibi.mapRegions') || '[]').length)
  await page.mouse.click(drawStageBox.x + drawStageBox.width * 0.44, drawStageBox.y + drawStageBox.height * 0.72)
  await page.mouse.click(drawStageBox.x + drawStageBox.width * 0.56, drawStageBox.y + drawStageBox.height * 0.72)
  await page.mouse.click(drawStageBox.x + drawStageBox.width * 0.56, drawStageBox.y + drawStageBox.height * 0.8)
  await page.mouse.click(drawStageBox.x + drawStageBox.width * 0.44, drawStageBox.y + drawStageBox.height * 0.8)
  const saveRegionButton = page.locator('.panorama-panel').first().getByRole('button', { name: '保存区域' })
  const draftMarkerCount = await page.locator('.panorama-panel').first().locator('.draft-point-marker').count()
  if (await saveRegionButton.isDisabled()) {
    throw new Error(`Panorama region save button stayed disabled; projected draft markers: ${draftMarkerCount}`)
  }
  await saveRegionButton.click()
  await page.waitForFunction((previousCount) => {
    const saved = JSON.parse(localStorage.getItem('duibi.mapRegions') || '[]')
    return saved.length === previousCount + 1
  }, regionCountBefore)
  await page.waitForTimeout(150)
  const savedProjection = await page.locator('.panorama-panel').first().evaluate((panel) => ({
    polygon: panel.querySelector('.region-screen-layer polygon:not(.draft-region)')?.getAttribute('points') ?? '',
    markers: panel.querySelectorAll('.region-point-marker:not(.draft-point-marker)').length,
  }))
  if (!savedProjection.polygon || savedProjection.markers < 3) {
    throw new Error(`Saved panorama region is not projected: ${JSON.stringify({ draftMarkerCount, savedProjection })}`)
  }
  const regionBeforeTurn = savedProjection.polygon
  await page.locator('.panorama-stage').first().press('ArrowRight')
  await page.waitForTimeout(120)
  const regionAfterTurn = await page.locator('.region-screen-layer polygon').first().getAttribute('points')
  if (!regionBeforeTurn || !regionAfterTurn || regionBeforeTurn === regionAfterTurn) {
    throw new Error('Panorama region is not locked to the camera/world projection')
  }

  // B 已在 A 的三图对比中；重新选择 B 后必须按 B 锚定，排除距 B 约 30 米的 C。
  await page.getByRole('application', { name: `${anchorNeighbor.name}全景查看器` }).click()
  await page.waitForFunction((expected) => {
    const files = [...document.querySelectorAll('.panorama-panel .panel-heading span:not(.panel-index)')]
      .map((node) => node.textContent?.trim())
    return files.length === expected.length && files.every((file) => expected.includes(file))
  }, [anchorRecord.fileName, anchorNeighbor.fileName])

  await page.getByRole('button', { name: /影像库/ }).click()
  const switchTarget = groupBRecords[0]
  await page.locator('.library-record').filter({ hasText: switchTarget.name }).first()
    .getByRole('button', { name: '切换到该位置' }).click()
  await page.waitForFunction((expected) => {
    const files = [...document.querySelectorAll('.panorama-panel .panel-heading span:not(.panel-index)')]
      .map((node) => node.textContent?.trim())
    return files.length === expected.length && files.every((file) => expected.includes(file))
  }, groupBNames)
  await page.waitForFunction(() => document.querySelectorAll('.load-state').length === 0, null, { timeout: 30_000 })
  const switchedPanelFiles = await page.locator('.panorama-panel .panel-heading span:not(.panel-index)').allTextContents()

  const originalDownload = page.waitForEvent('download')
  await page.locator('.library-record').filter({ hasText: primaryRecord.name }).first().getByRole('button', { name: '下载原图' }).click()
  const original = await originalDownload

  const comparisonDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前对比图' }).click()
  const comparison = await comparisonDownload
  const comparisonMetrics = await inspectImageDownload(page, comparison)

  const orthophotoDownload = page.waitForEvent('download')
  await page.locator('.library-record').filter({ hasText: primaryRecord.name }).first().getByRole('button', { name: '下载正射图' }).click()
  const orthophoto = await orthophotoDownload

  await page.getByRole('button', { name: '关闭影像库' }).click()

  await page.getByRole('button', { name: '正射地图' }).click()
  await page.locator('.orthophoto-map').waitFor()
  await page.locator('.leaflet-image-layer').first().waitFor()
  await waitForSelectedOrthophotoOnTop(page, created)

  const markerText = await page.locator('.image-map-marker').evaluateAll((nodes) =>
    nodes.map((node) => node.textContent?.trim()).filter(Boolean),
  )
  if (markerText.length) throw new Error(`Map point markers should not render numeric labels: ${markerText.join(',')}`)

  const inactiveNearbyButton = page.locator('.nearby-selector button:not(.active)').first()
  if (await inactiveNearbyButton.count()) {
    await inactiveNearbyButton.click()
    await waitForSelectedOrthophotoOnTop(page, created)
  }

  await page.getByRole('button', { name: '开始描绘' }).click()
  const mapBox = await page.locator('.orthophoto-map').boundingBox()
  if (!mapBox) throw new Error('The orthophoto map has no layout box')
  await page.mouse.click(mapBox.x + mapBox.width * 0.44, mapBox.y + mapBox.height * 0.48)
  await page.mouse.click(mapBox.x + mapBox.width * 0.53, mapBox.y + mapBox.height * 0.46)
  await page.mouse.click(mapBox.x + mapBox.width * 0.56, mapBox.y + mapBox.height * 0.56)
  await page.mouse.click(mapBox.x + mapBox.width * 0.45, mapBox.y + mapBox.height * 0.58)
  await page.locator('.region-panel').getByRole('button', { name: '保存当前' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.region-list article').length >= 2)

  await page.getByRole('button', { name: '全景视图' }).click()
  await page.waitForFunction(() => {
    const regions = JSON.parse(window.localStorage.getItem('duibi.mapRegions') || '[]')
    return regions.length >= 2
      && document.querySelectorAll('.panorama-panel').length > 0
      && document.querySelectorAll('.region-point-marker').length >= 3
  })
  await page.screenshot({ path: `${artifactDir}/orthophoto-region-in-panorama.png` })
  await page.getByRole('button', { name: '正射地图' }).click()
  await page.locator('.orthophoto-map').waitFor()

  await page.getByRole('button', { name: /影像库/ }).click()
  const kmlDownload = page.waitForEvent('download')
  await page.locator('.library-region-row').first().getByRole('button', { name: '导出 KML' }).click()
  const kml = await kmlDownload
  await page.getByRole('button', { name: '关闭影像库' }).click()

  await page.screenshot({ path: `${artifactDir}/orthophoto-map.png` })
  await page.setViewportSize({ width: 960, height: 720 })
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${artifactDir}/orthophoto-map-960x720.png` })
  const mapLayout = await assertViewportLayout(
    page,
    '960x720 orthophoto',
    ['.header-brand', '.workspace-switch', '.header-actions', '.map-status-panel', '.layer-panel', '.region-panel', '.map-legend', '.active-view-label', '.map-readout', '.footer-actions'],
    [
      ['.header-brand', '.workspace-switch'],
      ['.workspace-switch', '.header-actions'],
      ['.map-status-panel', '.layer-panel'],
      ['.map-status-panel', '.region-panel'],
      ['.layer-panel', '.region-panel'],
      ['.region-panel', '.map-legend'],
      ['.active-view-label', '.map-readout'],
      ['.map-readout', '.footer-actions'],
    ],
  )

  await page.getByRole('button', { name: '全景视图' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.panorama-panel').length === 2)
  await page.waitForFunction(() => document.querySelectorAll('.load-state').length === 0, null, { timeout: 30_000 })
  await page.screenshot({ path: `${artifactDir}/panorama-960x720.png` })
  const panoramaLayout = await assertViewportLayout(
    page,
    '960x720 panorama',
    ['.header-brand', '.workspace-switch', '.header-actions', '.panorama-grid', '.active-view-label', '.view-readout', '.footer-actions'],
    [
      ['.header-brand', '.workspace-switch'],
      ['.workspace-switch', '.header-actions'],
      ['.active-view-label', '.view-readout'],
      ['.view-readout', '.footer-actions'],
    ],
  )

  // 刷新后仍能读到刚上传的影像，证明页面不再依赖临时 blob URL。
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelectorAll('.panorama-panel').length >= 2)

  if (browserErrors.length || failedResponses.length) {
    throw new Error(JSON.stringify({ browserErrors, failedResponses }))
  }

  verificationResult = {
    atomicBatchStatus,
    pixelMetrics,
    directionPixels,
    beforeDrag,
    afterDrag,
    independentBefore,
    independentAfter,
    switchedPanelFiles,
    comparisonMetrics,
    responsiveLayouts: [mapLayout, panoramaLayout],
    persistedUploads: created.map((record) => record.fileName),
    downloads: [
      original.suggestedFilename(),
      comparison.suggestedFilename(),
      orthophoto.suggestedFilename(),
      kml.suggestedFilename(),
    ],
    browserErrors,
    failedResponses,
    artifacts: artifactDir,
  }
} catch (error) {
  verificationFailure = error
}

const cleanupFailures = []
const cleanupIds = [...new Set(uploadedIds)]
for (const id of cleanupIds) {
  try {
    const response = await fetch(new URL(`/api/images/${id}`, baseUrl), { method: 'DELETE' })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`DELETE returned ${response.status}: ${JSON.stringify(payload)}`)
    const catalog = assertCatalog(payload, `DELETE /api/images/${id}`)
    if (catalog.changedIds.length !== 1 || catalog.changedIds[0] !== id || catalog.images.some((image) => image.id === id)) {
      throw new Error(`Unexpected DELETE catalog: ${JSON.stringify(catalog)}`)
    }
  } catch (error) {
    cleanupFailures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (cleanupIds.length) {
  try {
    const remaining = await fetchCatalog()
    const leftovers = remaining.images.filter((image) => cleanupIds.includes(image.id))
    if (leftovers.length) cleanupFailures.push(`Records still present after cleanup: ${JSON.stringify(leftovers)}`)
  } catch (error) {
    cleanupFailures.push(`Cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  await browser.close()
} catch (error) {
  cleanupFailures.push(`Browser close failed: ${error instanceof Error ? error.message : String(error)}`)
}

if (verificationFailure && cleanupFailures.length) {
  throw new AggregateError(
    [verificationFailure, new Error(`Cleanup failed: ${cleanupFailures.join('; ')}`)],
    'UI verification and cleanup failed',
  )
}
if (verificationFailure) throw verificationFailure
if (cleanupFailures.length) throw new Error(`Cleanup failed: ${cleanupFailures.join('; ')}`)

console.log(JSON.stringify({ ...verificationResult, cleanedIds: cleanupIds }, null, 2))
