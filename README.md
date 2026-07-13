# 全景影像对比

基于 Vue 3、TypeScript、Three.js 和 Leaflet 的多画面全景对比工具。默认展示两幅 2:1 等距柱状全景，任一画面的拖拽、俯仰和缩放都会同步到其他画面。

## 功能

- 1 至 4 幅全景自适应布局；两幅时左右分栏
- 鼠标、触摸、滚轮和键盘控制视角
- 方位、俯仰角和视场角实时显示
- 放大、缩小、归正及同步/独立视角切换
- 本地图片多选上传、单图原文件下载
- 当前视角合成为 JPG 对比图下载
- 天地图矢量/影像底图、点位选择和坐标输入
- 桌面与移动端响应式界面

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

## 天地图配置

复制 `.env.example` 为 `.env.local`，填写浏览器端类型的天地图令牌：

```dotenv
VITE_TIANDITU_TOKEN=your_tianditu_token
```

`.env.local` 已由 `*.local` 规则排除在版本控制之外。Vite 环境变量在启动或构建时注入，修改后需要重启开发服务器。

## 替换全景素材

运行时可直接点击“上传全景”。固定项目素材可放入 `public/panoramas/`，再修改 `src/App.vue` 中的 `createDemoPanoramas()` 配置。

建议素材满足：

- JPEG、PNG 或 WebP
- 2:1 等距柱状投影（equirectangular）
- 推荐至少 4096 × 2048
- 需要准确方位时，为每幅图片设置对应的 `northOffset`

查看器核心逻辑位于 `src/components/PanoramaViewer.vue`，天地图逻辑位于 `src/components/MapPanel.vue`，共享数据类型位于 `src/types/panorama.ts`。
