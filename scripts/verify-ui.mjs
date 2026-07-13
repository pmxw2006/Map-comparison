import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const baseUrl = process.env.APP_URL ?? 'http://localhost:5173/'
const artifactDir = process.env.ARTIFACT_DIR ?? '/tmp/duibi-ui-check'
const chromePath = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const samplePanorama = fileURLToPath(new URL('../public/panoramas/key-biscayne-1.jpg', import.meta.url))

await mkdir(artifactDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'],
})

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
const browserErrors = []
const failedResponses = []
page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`)
})
page.on('response', (response) => {
  if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
})

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => {
    const canvases = [...document.querySelectorAll('.panorama-stage canvas')]
    return canvases.length === 2 && canvases.every((canvas) => canvas.width > 100 && canvas.height > 100)
  })
  await page.waitForFunction(() => document.querySelectorAll('.load-state').length === 0, null, {
    timeout: 30_000,
  })

  // 直接读取 WebGL 帧缓冲，确认画面含有真实纹理而非纯色或透明画布。
  const pixelMetrics = await page.evaluate(() =>
    [...document.querySelectorAll('.panorama-stage canvas')].map((canvas) => {
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      if (!gl) return { width: canvas.width, height: canvas.height, samples: 0, colors: 0, range: 0 }

      const pixels = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      let min = 255
      let max = 0
      let samples = 0
      let nonDark = 0
      const colors = new Set()
      for (let index = 0; index < pixels.length; index += 388) {
        const lightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3
        min = Math.min(min, lightness)
        max = Math.max(max, lightness)
        if (lightness > 12) nonDark += 1
        colors.add(`${pixels[index] >> 4}-${pixels[index + 1] >> 4}-${pixels[index + 2] >> 4}`)
        samples += 1
      }
      return {
        width: canvas.width,
        height: canvas.height,
        samples,
        colors: colors.size,
        range: Math.round(max - min),
        nonDarkRatio: Number((nonDark / samples).toFixed(3)),
      }
    }),
  )

  if (pixelMetrics.some((metric) => metric.colors < 20 || metric.range < 40 || metric.nonDarkRatio < 0.25)) {
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

  await page.locator('.panorama-panel').first().getByRole('button', { name: '放大' }).click()
  await page.waitForTimeout(100)
  const fovTexts = await page.locator('.orientation-values span').allTextContents()
  if (fovTexts[0] !== fovTexts[1]) throw new Error(`Zoom synchronization failed: ${fovTexts.join(' | ')}`)

  await page.locator('.panorama-panel').first().getByRole('button', { name: '归正' }).click()
  await page.waitForTimeout(100)
  const afterReset = await orientation.allTextContents()
  if (!afterReset.every((text) => text.includes('000°'))) {
    throw new Error(`Reset synchronization failed: ${afterReset.join(' | ')}`)
  }

  await page.screenshot({ path: `${artifactDir}/desktop.png` })

  await page.getByRole('button', { name: '地图定位' }).click()
  await page.waitForSelector('.map-panel')
  const mapTilesLoaded = await page
    .waitForFunction(
      () => [...document.querySelectorAll('.leaflet-tile')].some((tile) => tile.complete && tile.naturalWidth > 0),
      null,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  // Leaflet 会对新瓦片做淡入，等待动画结束后再留存视觉证据。
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${artifactDir}/map.png` })
  await page.getByRole('button', { name: '关闭地图' }).click()

  await page
    .locator('input[type="file"]')
    .setInputFiles(samplePanorama)
  await page.waitForFunction(() => document.querySelectorAll('.panorama-panel').length === 1)
  await page.waitForFunction(() => document.querySelectorAll('.load-state').length === 0, null, {
    timeout: 30_000,
  })

  const originalDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载原图' }).click()
  const original = await originalDownload

  const comparisonDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存对比图' }).click()
  const comparison = await comparisonDownload

  await page.getByRole('button', { name: '恢复示例' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.panorama-panel').length === 2)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)

  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    panelCount: document.querySelectorAll('.panorama-panel').length,
    panelHeights: [...document.querySelectorAll('.panorama-panel')].map((panel) =>
      Math.round(panel.getBoundingClientRect().height),
    ),
  }))
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth || mobileLayout.panelHeights.some((height) => height < 240)) {
    throw new Error(`Mobile layout check failed: ${JSON.stringify(mobileLayout)}`)
  }
  await page.screenshot({ path: `${artifactDir}/mobile.png` })

  console.log(
    JSON.stringify(
      {
        pixelMetrics,
        beforeDrag,
        afterDrag,
        afterReset,
        mapTilesLoaded,
        downloads: [original.suggestedFilename(), comparison.suggestedFilename()],
        mobileLayout,
        browserErrors,
        failedResponses,
        artifacts: artifactDir,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
