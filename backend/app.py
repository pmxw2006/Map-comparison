from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import ExifTags, Image, UnidentifiedImageError


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("DUIBI_DATA_DIR", ROOT_DIR / "data")).resolve()
IMAGE_DIR = DATA_DIR / "images"
ORTHOPHOTO_DIR = DATA_DIR / "orthophotos"
DATABASE_PATH = DATA_DIR / "catalog.db"
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_FILE_SIZE = 500 * 1024 * 1024
NEARBY_DISTANCE_METERS = 20.0
ORTHOPHOTO_FOOTPRINT_METERS = 500.0
DEFAULT_PROJECTION_ALTITUDE_METERS = 120.0
GEOCODE_TIMEOUT_SECONDS = 4
PANORAMA_NORTH_CORRECTION_DEGREES = 180.0

for directory in (DATA_DIR, IMAGE_DIR, ORTHOPHOTO_DIR):
    directory.mkdir(parents=True, exist_ok=True)

# 大疆原图分辨率较高，放宽 Pillow 的默认像素限制；上传大小仍受上面的 500 MB 限制。
Image.MAX_IMAGE_PIXELS = 400_000_000

app = FastAPI(title="全景影像管理 API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media/images", StaticFiles(directory=IMAGE_DIR), name="images")
app.mount("/media/orthophotos", StaticFiles(directory=ORTHOPHOTO_DIR), name="orthophotos")


def tianditu_token() -> str:
    """读取天地图 Key；开发环境通常只放在 Vite 的 .env.local 中。"""
    token = os.environ.get("TIANDITU_TOKEN") or os.environ.get("VITE_TIANDITU_TOKEN")
    if token:
        return token.strip()

    for env_file in (ROOT_DIR / ".env.local", ROOT_DIR / ".env", ROOT_DIR / ".env.example"):
        if not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.startswith(("TIANDITU_TOKEN=", "VITE_TIANDITU_TOKEN=")):
                continue
            return line.split("=", 1)[1].strip().strip("\"'")
    return ""


def database() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database() -> None:
    with database() as connection:
        # 只保存文件索引和元数据，原图/生成图仍落在 data/images 与 data/orthophotos。
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS images (
                id TEXT PRIMARY KEY,
                original_name TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                latitude REAL,
                longitude REAL,
                absolute_altitude REAL,
                relative_altitude REAL,
                heading REAL,
                north_offset REAL NOT NULL DEFAULT 0,
                orthophoto_status TEXT NOT NULL,
                orthophoto_name TEXT,
                orthophoto_kind TEXT,
                footprint_meters REAL
            )
            """
        )
        # 历史记录继续使用 nadir_preview 标识；实际内容统一为 500 m × 500 m 地面反投影预览。
        connection.execute(
            "UPDATE images SET footprint_meters = ? WHERE orthophoto_kind = 'nadir_preview'",
            (ORTHOPHOTO_FOOTPRINT_METERS,),
        )


initialize_database()


def rational_to_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return 0.0


def dms_to_decimal(values: Any, reference: str) -> float | None:
    if not values or len(values) < 3:
        return None
    degrees, minutes, seconds = (rational_to_float(value) for value in values[:3])
    decimal = degrees + minutes / 60 + seconds / 3600
    if reference.upper() in {"S", "W"}:
        decimal *= -1
    return decimal


def first_number(source: str, names: tuple[str, ...]) -> float | None:
    """兼容大疆 XMP 的属性和 XML 节点两种写法。"""
    for name in names:
        escaped = re.escape(name)
        patterns = (
            rf"{escaped}\s*=\s*[\"']\s*([+-]?\d+(?:\.\d+)?)",
            rf"<{escaped}>\s*([+-]?\d+(?:\.\d+)?)\s*</{escaped}>",
        )
        for pattern in patterns:
            match = re.search(pattern, source, flags=re.IGNORECASE)
            if match:
                try:
                    return float(match.group(1))
                except ValueError:
                    pass
    return None


def read_metadata(path: Path) -> dict[str, float | int | None]:
    latitude = longitude = absolute_altitude = relative_altitude = heading = None

    with Image.open(path) as image:
        width, height = image.size
        exif = image.getexif()
        if exif:
            # 普通 GPS 字段在 EXIF GPS IFD 中；大疆 XMP 读不到时会用这里的坐标兜底。
            try:
                gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
            except (AttributeError, KeyError, TypeError):
                gps = {}
            gps_names = {ExifTags.GPSTAGS.get(key, key): value for key, value in gps.items()}
            latitude = dms_to_decimal(gps_names.get("GPSLatitude"), str(gps_names.get("GPSLatitudeRef", "N")))
            longitude = dms_to_decimal(
                gps_names.get("GPSLongitude"), str(gps_names.get("GPSLongitudeRef", "E"))
            )
            if gps_names.get("GPSAltitude") is not None:
                absolute_altitude = rational_to_float(gps_names["GPSAltitude"])
                altitude_reference = gps_names.get("GPSAltitudeRef", 0) or 0
                if isinstance(altitude_reference, bytes):
                    altitude_reference = altitude_reference[0] if altitude_reference else 0
                if int(altitude_reference) == 1:
                    absolute_altitude *= -1

    # 大疆通常把飞行参数写在 JPEG 内嵌 XMP 中，直接读取文本可兼容常见机型。
    with path.open("rb") as source:
        xmp_bytes = source.read(4 * 1024 * 1024)
        if path.stat().st_size > len(xmp_bytes):
            source.seek(max(0, path.stat().st_size - 1024 * 1024))
            xmp_bytes += source.read()
    xmp = xmp_bytes.decode("latin-1", errors="ignore")
    xmp_latitude = first_number(xmp, ("drone-dji:GPSLatitude", "GPSLatitude"))
    xmp_longitude = first_number(xmp, ("drone-dji:GPSLongitude", "GPSLongitude"))
    xmp_altitude = first_number(xmp, ("drone-dji:AbsoluteAltitude", "AbsoluteAltitude"))
    if xmp_latitude is not None:
        latitude = xmp_latitude
    if xmp_longitude is not None:
        longitude = xmp_longitude
    if xmp_altitude is not None:
        absolute_altitude = xmp_altitude

    relative_altitude = first_number(xmp, ("drone-dji:RelativeAltitude", "RelativeAltitude"))
    heading = first_number(
        xmp,
        (
            "drone-dji:GimbalYawDegree",
            "drone-dji:FlightYawDegree",
            "GimbalYawDegree",
            "FlightYawDegree",
        ),
    )

    return {
        "width": width,
        "height": height,
        "latitude": latitude,
        "longitude": longitude,
        "absolute_altitude": absolute_altitude,
        "relative_altitude": relative_altitude,
        "heading": heading,
    }


def projection_altitude_meters(relative_altitude: float | int | None) -> float:
    """返回用于地面反投影的相机离地高度；缺少大疆相对高度时使用保守默认值。"""
    if relative_altitude is None:
        return DEFAULT_PROJECTION_ALTITUDE_METERS
    try:
        altitude = abs(float(relative_altitude))
    except (TypeError, ValueError):
        return DEFAULT_PROJECTION_ALTITUDE_METERS
    if not math.isfinite(altitude) or altitude < 1:
        return DEFAULT_PROJECTION_ALTITUDE_METERS
    return altitude


def corrected_panorama_heading(heading: float | int | None) -> float:
    """大疆 360 全景的等距柱状图中心与 XMP 航向相差 180°，这里统一修正南北方向。"""
    try:
        value = float(heading or 0)
    except (TypeError, ValueError):
        value = 0
    return (value + PANORAMA_NORTH_CORRECTION_DEGREES) % 360


def build_nadir_preview(
    source_path: Path,
    target_path: Path,
    heading: float | None,
    relative_altitude: float | int | None,
) -> None:
    """把 360 全景按平坦地面假设反投影成 500 m × 500 m 北向朝上的定位预览。"""
    with Image.open(source_path) as source:
        source = source.convert("RGB")
        source_width, source_height = source.size
        output_size = min(1536, max(768, source_width // 4))
        source_pixels = np.asarray(source)

        # 输出图每个像素对应真实地面米制坐标：上北、下南、左西、右东。
        height_meters = projection_altitude_meters(relative_altitude)
        half_footprint = ORTHOPHOTO_FOOTPRINT_METERS / 2
        meters_per_pixel = ORTHOPHOTO_FOOTPRINT_METERS / output_size
        output = np.empty((output_size, output_size, 3), dtype=np.uint8)
        yaw_offset = math.radians(corrected_panorama_heading(heading))
        east_offsets = (np.arange(output_size) + 0.5) * meters_per_pixel - half_footprint

        for row_start in range(0, output_size, 128):
            row_end = min(row_start + 128, output_size)
            north_offsets = half_footprint - (np.arange(row_start, row_end) + 0.5) * meters_per_pixel
            east, north = np.meshgrid(east_offsets, north_offsets)

            # 从相机位置看向地面点，再把方位角/俯角映射回等距柱状全景。
            ground_distance = np.sqrt(east * east + north * north)
            bearing = np.arctan2(east, north)
            pitch = -np.arctan2(height_meters, ground_distance)
            source_x = ((bearing - yaw_offset) / (2 * math.pi) + 0.5) * source_width
            source_y = (0.5 - pitch / math.pi) * source_height
            source_x = source_x.astype(np.int32)
            source_y = source_y.astype(np.int32)
            source_x %= source_width
            np.clip(source_y, 0, source_height - 1, out=source_y)
            output[row_start:row_end] = source_pixels[source_y, source_x]

        Image.fromarray(output, mode="RGB").save(target_path, "JPEG", quality=90, optimize=True)


def haversine_meters(first: sqlite3.Row | dict[str, Any], second: sqlite3.Row | dict[str, Any]) -> float:
    lat1, lon1 = math.radians(first["latitude"]), math.radians(first["longitude"])
    lat2, lon2 = math.radians(second["latitude"]), math.radians(second["longitude"])
    delta_lat = lat2 - lat1
    delta_lon = lon2 - lon1
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 6_371_008.8 * 2 * math.asin(math.sqrt(value))


def overlay_bounds(latitude: float, longitude: float, footprint_meters: float) -> list[list[float]]:
    """把中心点和米制边长换算成 Leaflet imageOverlay 需要的西南/东北经纬度。"""
    half = footprint_meters / 2
    latitude_delta = half / 111_320
    longitude_scale = max(0.1, math.cos(math.radians(latitude)))
    longitude_delta = half / (111_320 * longitude_scale)
    return [
        [latitude - latitude_delta, longitude - longitude_delta],
        [latitude + latitude_delta, longitude + longitude_delta],
    ]


def serialize_rows(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for row in rows:
        nearby_ids = []
        if row["latitude"] is not None and row["longitude"] is not None:
            # 同一地点多次拍摄时，前端用 nearby_ids 展示“影像 1/影像 2”选择。
            nearby_ids = [
                other["id"]
                for other in rows
                if other["id"] != row["id"]
                and other["latitude"] is not None
                and other["longitude"] is not None
                and haversine_meters(row, other) <= NEARBY_DISTANCE_METERS
            ]

        bounds = None
        if row["latitude"] is not None and row["longitude"] is not None and row["footprint_meters"]:
            bounds = overlay_bounds(row["latitude"], row["longitude"], row["footprint_meters"])

        records.append(
            {
                "id": row["id"],
                "name": Path(row["original_name"]).stem,
                "file_name": row["original_name"],
                "mime_type": row["mime_type"],
                "file_size": row["file_size"],
                "width": row["width"],
                "height": row["height"],
                "created_at": row["created_at"],
                "latitude": row["latitude"],
                "longitude": row["longitude"],
                "absolute_altitude": row["absolute_altitude"],
                "relative_altitude": row["relative_altitude"],
                "projection_altitude": projection_altitude_meters(row["relative_altitude"]),
                "heading": row["heading"],
                # 对外给前端使用修正后的北向偏移，保证指南针、全景描绘和正射反投影方向一致。
                "north_offset": corrected_panorama_heading(row["north_offset"]),
                "image_url": f"/media/images/{row['stored_name']}",
                "download_url": f"/api/images/{row['id']}/download",
                "orthophoto_status": row["orthophoto_status"],
                "orthophoto_kind": row["orthophoto_kind"],
                "orthophoto_url": (
                    f"/media/orthophotos/{row['orthophoto_name']}" if row["orthophoto_name"] else None
                ),
                "orthophoto_download_url": (
                    f"/api/images/{row['id']}/orthophoto/download" if row["orthophoto_name"] else None
                ),
                "overlay_bounds": bounds,
                "nearby_ids": nearby_ids,
            }
        )
    return records


def list_records() -> list[dict[str, Any]]:
    with database() as connection:
        rows = connection.execute("SELECT * FROM images ORDER BY created_at DESC").fetchall()
    return serialize_rows(rows)


def pick_place_name(payload: dict[str, Any]) -> str:
    """从天地图逆地理编码结果中取最适合作为“靠近某地”的短名称。"""
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(result, dict):
        return ""

    component = result.get("addressComponent")
    if isinstance(component, dict):
        for key in ("village", "town", "county", "poi", "address", "city", "province"):
            value = component.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

    for key in ("formatted_address", "formattedAddress", "address"):
        value = result.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def request_tianditu_reverse_geocode(latitude: float, longitude: float) -> dict[str, str]:
    token = tianditu_token()
    fallback = f"{latitude:.6f}, {longitude:.6f}"
    if not token:
        return {"name": fallback, "formatted_address": fallback, "source": "fallback"}

    # 天地图逆地理编码要求把经纬度 JSON 放入 postStr 参数；通过后端代理可避免浏览器跨域问题。
    query = urlencode(
        {
            "postStr": json.dumps({"lon": longitude, "lat": latitude, "ver": 1}, separators=(",", ":")),
            "type": "geocode",
            "tk": token,
        }
    )
    url = f"https://api.tianditu.gov.cn/geocoder?{query}"
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": os.environ.get("TIANDITU_REFERER", "http://localhost:5173/"),
        },
    )
    try:
        with urlopen(request, timeout=GEOCODE_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8", errors="ignore"))
    except Exception:
        return {"name": fallback, "formatted_address": fallback, "source": "fallback"}

    name = pick_place_name(payload) or fallback
    result = payload.get("result") if isinstance(payload, dict) else {}
    formatted = result.get("formatted_address") if isinstance(result, dict) else ""
    return {
        "name": name,
        "formatted_address": formatted or name,
        "source": "tianditu" if name != fallback else "fallback",
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/geocode/reverse")
async def reverse_geocode(lat: float, lng: float) -> dict[str, str]:
    if not math.isfinite(lat) or not math.isfinite(lng):
        raise HTTPException(status_code=400, detail="经纬度无效")
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise HTTPException(status_code=400, detail="经纬度超出范围")
    return await asyncio.to_thread(request_tianditu_reverse_geocode, lat, lng)


@app.get("/api/images")
def list_images() -> list[dict[str, Any]]:
    return list_records()


@app.post("/api/images", status_code=201)
async def upload_images(files: list[UploadFile] = File(...)) -> list[dict[str, Any]]:
    if not files:
        raise HTTPException(status_code=400, detail="请选择图片文件")

    inserted_ids: list[str] = []
    for upload in files:
        original_name = Path(upload.filename or "image.jpg").name
        extension = Path(original_name).suffix.lower()
        if extension not in ALLOWED_EXTENSIONS:
            raise HTTPException(status_code=415, detail=f"不支持文件格式：{original_name}")

        image_id = uuid.uuid4().hex
        stored_name = f"{image_id}{extension}"
        stored_path = IMAGE_DIR / stored_name
        size = 0
        try:
            with stored_path.open("wb") as target:
                # 分块写入，避免大疆高分辨率全景一次性读入内存。
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_FILE_SIZE:
                        raise HTTPException(status_code=413, detail=f"文件超过 500 MB：{original_name}")
                    target.write(chunk)

            try:
                metadata = await asyncio.to_thread(read_metadata, stored_path)
            except (UnidentifiedImageError, OSError, ValueError) as error:
                raise HTTPException(status_code=415, detail=f"无法读取图片：{original_name}") from error

            width, height = int(metadata["width"] or 0), int(metadata["height"] or 0)
            is_panorama = width >= height * 1.8
            ortho_name = f"{image_id}.jpg" if is_panorama else None
            ortho_status = "ready" if is_panorama else "unsupported"
            ortho_kind = "nadir_preview" if is_panorama else None

            if ortho_name:
                await asyncio.to_thread(
                    build_nadir_preview,
                    stored_path,
                    ORTHOPHOTO_DIR / ortho_name,
                    metadata["heading"],
                    metadata["relative_altitude"],
                )

            relative_altitude = metadata["relative_altitude"]
            # 地面反投影结果固定覆盖 500 m × 500 m；GPS 坐标位于正方形中心。
            footprint = ORTHOPHOTO_FOOTPRINT_METERS
            mime_type = upload.content_type or "application/octet-stream"
            created_at = datetime.now(timezone.utc).isoformat()
            heading = metadata["heading"]
            north_offset = float(heading or 0) % 360

            with database() as connection:
                connection.execute(
                    """
                    INSERT INTO images (
                        id, original_name, stored_name, mime_type, file_size, width, height, created_at,
                        latitude, longitude, absolute_altitude, relative_altitude, heading, north_offset,
                        orthophoto_status, orthophoto_name, orthophoto_kind, footprint_meters
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        image_id,
                        original_name,
                        stored_name,
                        mime_type,
                        size,
                        width,
                        height,
                        created_at,
                        metadata["latitude"],
                        metadata["longitude"],
                        metadata["absolute_altitude"],
                        relative_altitude,
                        heading,
                        north_offset,
                        ortho_status,
                        ortho_name,
                        ortho_kind,
                        footprint,
                    ),
                )
            inserted_ids.append(image_id)
        except Exception:
            # 任一处理步骤失败就清理本次上传产生的文件，避免数据库和磁盘状态不一致。
            stored_path.unlink(missing_ok=True)
            (ORTHOPHOTO_DIR / f"{image_id}.jpg").unlink(missing_ok=True)
            raise
        finally:
            await upload.close()

    records = list_records()
    return [record for record in records if record["id"] in inserted_ids]


@app.get("/api/images/{image_id}/download")
def download_image(image_id: str):
    from fastapi.responses import FileResponse

    with database() as connection:
        row = connection.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="影像不存在")
    return FileResponse(IMAGE_DIR / row["stored_name"], filename=row["original_name"], media_type=row["mime_type"])


@app.get("/api/images/{image_id}/orthophoto/download")
def download_orthophoto(image_id: str):
    from fastapi.responses import FileResponse

    with database() as connection:
        row = connection.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    if not row or not row["orthophoto_name"]:
        raise HTTPException(status_code=404, detail="正射图不存在")

    source_name = Path(row["original_name"]).stem
    return FileResponse(
        ORTHOPHOTO_DIR / row["orthophoto_name"],
        filename=f"{source_name}-orthophoto.jpg",
        media_type="image/jpeg",
    )


@app.delete("/api/images/{image_id}")
def delete_image(image_id: str) -> dict[str, bool]:
    with database() as connection:
        row = connection.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="影像不存在")
        connection.execute("DELETE FROM images WHERE id = ?", (image_id,))

    (IMAGE_DIR / row["stored_name"]).unlink(missing_ok=True)
    if row["orthophoto_name"]:
        (ORTHOPHOTO_DIR / row["orthophoto_name"]).unlink(missing_ok=True)
    return {"deleted": True}


# 构建后的前端可由同一个 Python 服务提供；开发阶段仍使用 Vite 热更新和代理。
DIST_DIR = ROOT_DIR / "dist"
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")
