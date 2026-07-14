# 无人机全景影像工作台

桌面端前后端应用。Vue 3 + Three.js 负责多幅全景同步查看，Python + FastAPI 负责永久保存上传文件、提取大疆元数据和生成地面反投影预览，天地图负责承载定位覆盖层。

## 当前功能

- 初次运行影像库为空，不再内置对比图
- 上传的原图永久保存到 `data/images/`
- SQLite 影像目录保存到 `data/catalog.db`
- 自动读取 EXIF GPS 和常见大疆 XMP 字段：经纬度、绝对/相对高度、飞行或云台航向
- 2:1 全景按 GPS、相对高度和航向反投影到地面平面，保存到 `data/orthophotos/`
- 地面反投影结果固定裁成拍摄点周围 `500 m × 500 m` 北向朝上的正方形
- 缺少大疆相对高度时，后端按默认 `120 m` 高度生成定位预览
- 全景视图与正射地图自由切换
- 两个拍摄点相距不超过 20 米时，地图提供“影像 1 / 影像 2”选择
- 1 至 4 幅全景同步拖拽、俯仰、缩放和归正
- 原图下载、当前视角对比图下载和永久影像库管理

## 关于正射结果

当前自动结果是把单张 360° 全景按平坦地面假设反投影到以拍摄点 GPS 为中心的 `500 m × 500 m` 地面范围，用于快速定位和现场对照。它不是具有测绘精度的真正正射影像；真实地形起伏、建筑物立面、树冠和全景拼接误差都会造成拉伸或错位。真正的正射成果需要大疆任务的一组重叠原始照片，并通过 OpenDroneMap 等摄影测量流程计算。后端已经把 `orthophoto_kind` 和处理状态独立建模，后续可以替换处理器而不改前端交互。

## 开发运行

安装前端依赖：

```bash
npm install
```

创建 Python 虚拟环境并安装依赖：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

分别启动后端和前端：

```bash
npm run dev:api
npm run dev
```

浏览器打开 `http://localhost:5173/`。Vite 会把 `/api` 和 `/media` 请求代理到 `http://127.0.0.1:8000`。

天地图 Key 放在本地 `.env.local`：

```dotenv
VITE_TIANDITU_TOKEN=your-tianditu-token
```

生产环境建议在天地图控制台限制 Key 的可访问域名。

## 构建运行

```bash
npm run build
npm run start
```

存在 `dist/` 时，FastAPI 会同时提供构建后的网页、API 和上传影像，访问 `http://localhost:8000/` 即可。

## 数据与接口

- `GET /api/images`：读取永久影像库，并返回 20 米内的邻近影像 ID
- `POST /api/images`：上传一幅或多幅全景，保存原图并生成地面反投影预览
- `GET /api/images/{id}/download`：按原始文件名下载
- `DELETE /api/images/{id}`：永久删除原图、生成结果和目录记录
- `GET /api/health`：服务健康检查

上传内容不会提交到 Git。备份或迁移时应整体复制 `data/` 目录。

## 验证

在前后端已启动的情况下运行：

```bash
npm run build
npm run verify:ui
```

验证脚本会上传临时全景、检查 WebGL 纹理、视角同步、永久目录、正射模式和下载，然后只删除它自己创建的测试记录。
