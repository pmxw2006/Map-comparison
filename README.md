# 全景影像对比

基于 Vue 3、TypeScript 和 Three.js 的桌面端多画面全景对比工具。默认展示两幅 2:1 等距柱状全景，任一画面的拖拽、俯仰和缩放都会同步到其他画面。

## 功能

- 1 至 4 幅全景自适应布局；两幅时左右分栏
- 鼠标、滚轮和键盘控制视角
- 方位、俯仰角和视场角实时显示
- 放大、缩小、归正及同步/独立视角切换
- 本地图片多选上传、单图原文件下载
- 当前视角合成为 JPG 对比图下载
- 桌面端固定工作台界面

## 本地运行

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

浏览器自动验证（默认需要 `/usr/bin/google-chrome`）：

```bash
npm run verify:ui
```

可通过 `APP_URL`、`CHROME_PATH` 和 `ARTIFACT_DIR` 覆盖验证脚本的默认参数。

## 替换全景素材

运行时可直接点击“上传全景”。固定项目素材可放入 `public/panoramas/`，再修改 `src/App.vue` 中的 `createDemoPanoramas()` 配置。

建议素材满足：

- JPEG、PNG 或 WebP
- 2:1 等距柱状投影（equirectangular）
- 推荐至少 4096 × 2048
- 需要准确方位时，为每幅图片设置对应的 `northOffset`

查看器核心逻辑位于 `src/components/PanoramaViewer.vue`，页面编排位于 `src/App.vue`，共享数据类型位于 `src/types/panorama.ts`。
