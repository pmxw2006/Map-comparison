# 无人机全景影像工作台

本机单用户桌面工作台。Vue 3、Three.js 和 Leaflet 提供 1 至 4 幅全景对比、正射定位及区域描绘；FastAPI 保存原图、读取大疆元数据，并生成平坦地面反投影预览。

## 功能边界

- 仅接受带有效 GPS 和航向的 2:1 全景，上传后保存原图、目录记录和正射预览。
- 同一位置 20 米内的影像可组成 1 至 4 幅对比，支持同步或独立视角。
- 全景与地图共享区域数据，均采用“左键添加点、明确保存、撤销、取消”的描绘流程。
- 原图、正射图、当前对比图和区域 KML 均可下载。
- 当前正射结果是假定地面水平的 `500 m × 500 m` 定位预览，不具备摄影测量精度。
- 服务没有鉴权，只绑定 `127.0.0.1`；不要直接改为公网或局域网监听。

## 环境准备

需要 Node.js 22、Python 3.11+，以及支持 WebGL 的现代 Chromium 浏览器。

```bash
npm ci
npx playwright install chromium
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env.local
```

编辑 `.env.local`，至少填写 `VITE_TIANDITU_TOKEN`。该值会进入浏览器代码，不应视为秘密；请在天地图控制台轮换已公开的 Key，并限制允许来源。`TIANDITU_REFERER` 用于后端地点反查，生产构建运行时通常改为 `http://127.0.0.1:8000/`。

## 运行

开发时分别启动 API 和 Vite：

```bash
npm run dev:api
npm run dev
```

打开 `http://127.0.0.1:5173/`。Vite 将 `/api` 和 `/media` 代理到 `http://127.0.0.1:8000`。

运行构建版本：

```bash
npm run build
npm start
```

FastAPI 检测到 `dist/` 后会同时提供网页、API 和影像文件，地址为 `http://127.0.0.1:8000/`。两个后端命令都会显式读取 `.env.local`；缺少该文件时应先从 `.env.example` 创建。

## 上传规则

- 支持 `.jpg`、`.jpeg`、`.png` 和 `.webp`，单文件最大 `500 MB`。
- 宽高比必须在 `1.9` 至 `2.1` 之间，并包含有效经纬度和大疆飞行或云台航向。
- 相对高度可以缺失；缺失或绝对值小于 `1 m` 时使用 `120 m` 投影高度。绝对高度可为空且不参与投影计算。
- 批量上传采用全有或全无语义。任一文件无效时整批失败，并清理本批已写入的原图、正射图和目录记录。
- 正射处理同步、串行执行；高分辨率批次可能需要较长时间，前端会等待整个批次完成。

## API

目录接口统一返回：

```json
{
  "images": [],
  "changedIds": []
}
```

- `GET /api/images`：返回完整目录，`changedIds` 为空。
- `POST /api/images`：字段名为重复的 `files`，成功返回 `201`；`changedIds` 按上传顺序列出新 ID。
- `DELETE /api/images/{id}`：删除原图、正射图和记录，并在 `changedIds` 返回被删 ID。
- `GET /api/images/{id}/download`：按原始文件名下载全景。
- `GET /api/images/{id}/orthophoto/download`：下载 JPEG 正射预览。
- `GET /api/geocode/reverse?lat=...&lng=...`：返回 `{ "name": "地点" }`。
- `GET /api/health`：返回 `{ "status": "ok" }`。

错误响应使用 FastAPI 的 `{ "detail": "原因" }`。格式不支持返回 `415`，尺寸、GPS 或航向不符合要求返回 `422`，文件过大返回 `413`。

## 数据

默认数据位于 `data/`：SQLite 目录为 `data/catalog.db`，原图和正射图分别位于 `data/images/`、`data/orthophotos/`。这些内容不会提交到 Git；备份或迁移时应整体复制该目录。也可在 `.env.local` 中设置绝对路径 `DUIBI_DATA_DIR`。

当前精简结构不提供旧数据库迁移。升级到此版本前应备份所需文件，并清空旧的 `catalog.db*`、原图和正射目录后重新上传。

## 验证

先启动前后端，再执行：

```bash
npm run build
npm run verify:ui
```

E2E 默认访问 `http://127.0.0.1:5173/`，可通过 `APP_URL` 覆盖；优先使用 Playwright Chromium，也可通过 `CHROME_PATH` 指定浏览器。脚本使用自生成的带方向标识全景，覆盖原子上传、WebGL 像素、视角同步与独立模式、两种区域描绘、图层顺序、下载和刷新持久化，并在 `1440×900` 与 `960×720` 检查布局。

验证只删除自身创建的记录；清理失败同样视为失败。截图默认写入 `/tmp/duibi-ui-check`，可通过 `ARTIFACT_DIR` 修改。
