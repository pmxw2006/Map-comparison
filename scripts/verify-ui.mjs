import { mkdir } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const baseUrl = process.env.APP_URL ?? 'http://localhost:5173/'
const apiUrl = new URL('/api/images', baseUrl).href
const artifactDir = process.env.ARTIFACT_DIR ?? '/tmp/duibi-ui-check'
const chromePath = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const uploadedIds = []

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

function makeVerifyPanorama() {
  const width = 1600
  const height = 800
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3
      raw[offset] = Math.round((x / width) * 255)
      raw[offset + 1] = Math.round((y / height) * 255)
      raw[offset + 2] = (x * 7 + y * 5) % 256
    }
  }

  // 直接生成 2:1 PNG，避免验证流程依赖 public 目录中的旧示例图片。
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const xmp = Buffer.from(
    '<x:xmpmeta drone-dji:GPSLatitude="31.230400" drone-dji:GPSLongitude="121.473700" drone-dji:RelativeAltitude="120.0" drone-dji:AbsoluteAltitude="132.5" drone-dji:GimbalYawDegree="18.0"></x:xmpmeta>',
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

async function waitForSelectedOrthophotoOnTop(page, records) {
  await page.waitForFunction((items) => {
    const selectedName = document.querySelector('.map-status-heading strong')?.textContent?.trim()
    const selected = items.find((item) => item.name === selectedName)
    if (!selected?.orthophoto_url) return false

    const overlays = [...document.querySelectorAll('.leaflet-image-layer')]
      .filter((element) => element instanceof HTMLImageElement)
      .map((element) => ({
        src: element.src,
        zIndex: Number(element.style.zIndex || window.getComputedStyle(element).zIndex || 0),
      }))
      .filter((overlay) => Number.isFinite(overlay.zIndex))
      .sort((left, right) => right.zIndex - left.zIndex)

    return overlays[0]?.src.includes(selected.orthophoto_url)
  }, records)
}

await mkdir(artifactDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: chromePath,
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

try {
  const recordsBefore = await fetch(apiUrl).then((response) => response.json())
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  if (recordsBefore.length === 0) {
    await page.getByText('影像库为空', { exact: true }).waitFor()
    await page.screenshot({ path: `${artifactDir}/empty-library.png` })
  }

  await page.locator('input[type="file"]').setInputFiles([
    { name: 'verify-panorama-a.png', mimeType: 'image/png', buffer: sampleBuffer },
    { name: 'verify-panorama-b.png', mimeType: 'image/png', buffer: sampleBuffer },
  ])
  await page.getByText('已永久保存 2 幅影像').waitFor({ timeout: 60_000 })

  const recordsAfter = await fetch(apiUrl).then((response) => response.json())
  const created = recordsAfter.filter((record) => !recordsBefore.some((before) => before.id === record.id))
  uploadedIds.push(...created.map((record) => record.id))
  if (created.length !== 2 || created.some((record) => record.orthophoto_status !== 'ready')) {
    throw new Error(`Persistent upload failed: ${JSON.stringify(created)}`)
  }
  if (created.some((record) => !record.overlay_bounds || record.projection_altitude !== 120)) {
    throw new Error(`GPS/XMP extraction failed: ${JSON.stringify(created)}`)
  }

  await page.waitForFunction(() => {
    const canvases = [...document.querySelectorAll('.panorama-stage canvas')]
    return canvases.length >= 2 && canvases.slice(0, 2).every((canvas) => canvas.width > 100 && canvas.height > 100)
  })
  await page.waitForFunction(() => document.querySelectorAll('.load-state').length === 0, null, {
    timeout: 30_000,
  })

  // 读取 WebGL 帧缓冲，确认球体查看器使用了真实纹理而不是纯色画布。
  const pixelMetrics = await page.evaluate(() =>
    [...document.querySelectorAll('.panorama-stage canvas')].slice(0, 2).map((canvas) => {
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      if (!gl) return { colors: 0, range: 0 }
      const pixels = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      let min = 255
      let max = 0
      const colors = new Set()
      for (let index = 0; index < pixels.length; index += 388) {
        const lightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3
        min = Math.min(min, lightness)
        max = Math.max(max, lightness)
        colors.add(`${pixels[index] >> 4}-${pixels[index + 1] >> 4}-${pixels[index + 2] >> 4}`)
      }
      return { colors: colors.size, range: Math.round(max - min) }
    }),
  )
  if (pixelMetrics.some((metric) => metric.colors < 20 || metric.range < 40)) {
    throw new Error(`WebGL pixel check failed: ${JSON.stringify(pixelMetrics)}`)
  }

  const orientation = page.locator('.orientation-values strong')
  const beforeDrag = await orientation.allTextContents()
  const stageBox = await page.locator('.panorama-stage').first().boundingBox()
  if (!stageBox) throw new Error('The first panorama stage has no layout box')
  await page.mouse.move(stageBox.x + stageBox.width * 0.55, stageBox.y + stageBox.height * 0.55)
  await page.mouse.down()
  await page.mouse.move(stageBox.x + stageBox.width * 0.35, stageBox.y + stageBox.height * 0.48, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  const afterDrag = await orientation.allTextContents()
  if (afterDrag[0] === beforeDrag[0] || afterDrag[0] !== afterDrag[1]) {
    throw new Error(`Panorama synchronization failed: ${JSON.stringify({ beforeDrag, afterDrag })}`)
  }

  await page.screenshot({ path: `${artifactDir}/panorama-comparison.png` })

  await page.locator('.panorama-panel').first().getByRole('button', { name: '全景描绘' }).click()
  const drawStageBox = await page.locator('.panorama-stage').first().boundingBox()
  if (!drawStageBox) throw new Error('The panorama drawing stage has no layout box')
  await page.mouse.click(drawStageBox.x + drawStageBox.width * 0.44, drawStageBox.y + drawStageBox.height * 0.58)
  await page.mouse.click(drawStageBox.x + drawStageBox.width * 0.55, drawStageBox.y + drawStageBox.height * 0.58)
  await page.mouse.click(drawStageBox.x + drawStageBox.width * 0.55, drawStageBox.y + drawStageBox.height * 0.68)
  await page.mouse.dblclick(drawStageBox.x + drawStageBox.width * 0.44, drawStageBox.y + drawStageBox.height * 0.68)
  await page.waitForFunction(() => document.querySelectorAll('.region-screen-layer polygon').length > 0)
  await page.waitForFunction(() => document.querySelectorAll('.region-point-marker').length >= 3)
  const regionBeforeTurn = await page.locator('.region-screen-layer polygon').first().getAttribute('points')
  await page.locator('.panorama-stage').first().press('ArrowRight')
  await page.waitForTimeout(120)
  const regionAfterTurn = await page.locator('.region-screen-layer polygon').first().getAttribute('points')
  if (!regionBeforeTurn || !regionAfterTurn || regionBeforeTurn === regionAfterTurn) {
    throw new Error('Panorama region is not locked to the camera/world projection')
  }

  await page.getByRole('button', { name: /影像库/ }).click()
  const originalDownload = page.waitForEvent('download')
  await page.locator('.library-record').filter({ hasText: 'verify-panorama-a' }).first().getByRole('button', { name: '下载原图' }).click()
  const original = await originalDownload

  const comparisonDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前对比图' }).click()
  const comparison = await comparisonDownload

  const orthophotoDownload = page.waitForEvent('download')
  await page.locator('.library-record').filter({ hasText: 'verify-panorama-a' }).first().getByRole('button', { name: '下载正射图' }).click()
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
  await page.mouse.dblclick(mapBox.x + mapBox.width * 0.45, mapBox.y + mapBox.height * 0.58)
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

  // 刷新后仍能读到刚上传的影像，证明页面不再依赖临时 blob URL。
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelectorAll('.panorama-panel').length >= 2)

  if (browserErrors.length || failedResponses.length) {
    throw new Error(JSON.stringify({ browserErrors, failedResponses }))
  }

  console.log(
    JSON.stringify(
      {
        pixelMetrics,
        beforeDrag,
        afterDrag,
        persistedUploads: created.map((record) => record.file_name),
        downloads: [
          original.suggestedFilename(),
          comparison.suggestedFilename(),
          orthophoto.suggestedFilename(),
          kml.suggestedFilename(),
        ],
        browserErrors,
        failedResponses,
        artifacts: artifactDir,
      },
      null,
      2,
    ),
  )
} finally {
  await Promise.all(
    uploadedIds.map((id) => fetch(new URL(`/api/images/${id}`, baseUrl), { method: 'DELETE' }).catch(() => null)),
  )
  await browser.close()
}
