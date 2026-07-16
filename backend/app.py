from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
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

# 方向链路必须分开：Three.js 的 yaw=0 位于全景接缝，需加 180°；正射采样以图像中心为航向，不加修正。
PANORAMA_VIEW_NORTH_CORRECTION_DEGREES = 180.0
ORTHOPHOTO_SOURCE_NORTH_CORRECTION_DEGREES = 0.0

for directory in (DATA_DIR, IMAGE_DIR, ORTHOPHOTO_DIR):
    directory.mkdir(parents=True, exist_ok=True)

Image.MAX_IMAGE_PIXELS = 400_000_000
logger = logging.getLogger(__name__)
upload_lock = asyncio.Lock()

app = FastAPI(title="全景影像管理 API", version="0.2.0")
app.mount("/media/images", StaticFiles(directory=IMAGE_DIR), name="images")
app.mount("/media/orthophotos", StaticFiles(directory=ORTHOPHOTO_DIR), name="orthophotos")


def database() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database() -> None:
    with database() as connection:
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
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                absolute_altitude REAL,
                relative_altitude REAL,
                heading REAL NOT NULL,
                orthophoto_name TEXT NOT NULL
            )
            """
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
    return -decimal if reference.upper() in {"S", "W"} else decimal


def first_number(source: str, names: tuple[str, ...]) -> float | None:
    for name in names:
        escaped = re.escape(name)
        for pattern in (
            rf"{escaped}\s*=\s*[\"']\s*([+-]?\d+(?:\.\d+)?)",
            rf"<{escaped}>\s*([+-]?\d+(?:\.\d+)?)\s*</{escaped}>",
        ):
            match = re.search(pattern, source, flags=re.IGNORECASE)
            if match:
                return float(match.group(1))
    return None


def read_metadata(path: Path) -> dict[str, float | int | None]:
    latitude = longitude = absolute_altitude = None
    with Image.open(path) as image:
        width, height = image.size
        exif = image.getexif()
        if exif:
            try:
                gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
            except (AttributeError, KeyError, TypeError):
                gps = {}
            gps = {ExifTags.GPSTAGS.get(key, key): value for key, value in gps.items()}
            latitude = dms_to_decimal(gps.get("GPSLatitude"), str(gps.get("GPSLatitudeRef", "N")))
            longitude = dms_to_decimal(gps.get("GPSLongitude"), str(gps.get("GPSLongitudeRef", "E")))
            if gps.get("GPSAltitude") is not None:
                absolute_altitude = rational_to_float(gps["GPSAltitude"])
                altitude_reference = gps.get("GPSAltitudeRef", 0) or 0
                if isinstance(altitude_reference, bytes):
                    altitude_reference = altitude_reference[0] if altitude_reference else 0
                if int(altitude_reference) == 1:
                    absolute_altitude *= -1

    # 大疆 XMP 可能位于 JPEG 头部或尾部；只扫描这两段，避免把数百 MB 原图整体载入内存。
    with path.open("rb") as source:
        xmp_bytes = source.read(4 * 1024 * 1024)
        if path.stat().st_size > len(xmp_bytes):
            source.seek(max(0, path.stat().st_size - 1024 * 1024))
            xmp_bytes += source.read()
    xmp = xmp_bytes.decode("latin-1", errors="ignore")

    xmp_latitude = first_number(xmp, ("drone-dji:GPSLatitude", "GPSLatitude"))
    xmp_longitude = first_number(xmp, ("drone-dji:GPSLongitude", "GPSLongitude"))
    xmp_altitude = first_number(xmp, ("drone-dji:AbsoluteAltitude", "AbsoluteAltitude"))
    return {
        "width": width,
        "height": height,
        "latitude": xmp_latitude if xmp_latitude is not None else latitude,
        "longitude": xmp_longitude if xmp_longitude is not None else longitude,
        "absolute_altitude": xmp_altitude if xmp_altitude is not None else absolute_altitude,
        "relative_altitude": first_number(xmp, ("drone-dji:RelativeAltitude", "RelativeAltitude")),
        "heading": first_number(
            xmp,
            (
                "drone-dji:GimbalYawDegree",
                "drone-dji:FlightYawDegree",
                "GimbalYawDegree",
                "FlightYawDegree",
            ),
        ),
    }


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def projection_altitude_meters(relative_altitude: Any) -> float:
    altitude = finite_number(relative_altitude)
    return abs(altitude) if altitude is not None and abs(altitude) >= 1 else DEFAULT_PROJECTION_ALTITUDE_METERS


def normalize_degrees(value: float) -> float:
    return value % 360


def panorama_view_north_offset(heading: float) -> float:
    return normalize_degrees(heading + PANORAMA_VIEW_NORTH_CORRECTION_DEGREES)


def orthophoto_source_center_bearing(heading: float) -> float:
    return normalize_degrees(heading + ORTHOPHOTO_SOURCE_NORTH_CORRECTION_DEGREES)


def build_nadir_preview(
    source_path: Path,
    target_path: Path,
    heading: float,
    relative_altitude: float | None,
) -> None:
    with Image.open(source_path) as source:
        source = source.convert("RGB")
        source_width, source_height = source.size
        output_size = min(1536, max(768, source_width // 4))
        source_pixels = np.asarray(source)

        height_meters = projection_altitude_meters(relative_altitude)
        half_footprint = ORTHOPHOTO_FOOTPRINT_METERS / 2
        meters_per_pixel = ORTHOPHOTO_FOOTPRINT_METERS / output_size
        output = np.empty((output_size, output_size, 3), dtype=np.uint8)
        yaw_offset = math.radians(orthophoto_source_center_bearing(heading))
        east_offsets = (np.arange(output_size) + 0.5) * meters_per_pixel - half_footprint

        for row_start in range(0, output_size, 128):
            row_end = min(row_start + 128, output_size)
            north_offsets = half_footprint - (np.arange(row_start, row_end) + 0.5) * meters_per_pixel
            east, north = np.meshgrid(east_offsets, north_offsets)

            # 每个输出像素先转成“东/北”地面米制坐标，再由方位角和俯角反查等距柱状全景像素。
            ground_distance = np.sqrt(east * east + north * north)
            bearing = np.arctan2(east, north)
            pitch = -np.arctan2(height_meters, ground_distance)
            source_x = ((bearing - yaw_offset) / (2 * math.pi) + 0.5) * source_width
            source_y = (0.5 - pitch / math.pi) * source_height
            source_x = source_x.astype(np.int32) % source_width
            source_y = source_y.astype(np.int32)
            np.clip(source_y, 0, source_height - 1, out=source_y)
            output[row_start:row_end] = source_pixels[source_y, source_x]

        Image.fromarray(output, mode="RGB").save(target_path, "JPEG", quality=90, optimize=True)


def haversine_meters(first: sqlite3.Row, second: sqlite3.Row) -> float:
    lat1, lon1 = math.radians(first["latitude"]), math.radians(first["longitude"])
    lat2, lon2 = math.radians(second["latitude"]), math.radians(second["longitude"])
    delta_lat = lat2 - lat1
    delta_lon = lon2 - lon1
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 6_371_008.8 * 2 * math.asin(math.sqrt(value))


def overlay_bounds(latitude: float, longitude: float) -> list[list[float]]:
    half = ORTHOPHOTO_FOOTPRINT_METERS / 2
    latitude_delta = half / 111_320
    longitude_delta = half / (111_320 * max(0.1, math.cos(math.radians(latitude))))
    return [
        [latitude - latitude_delta, longitude - longitude_delta],
        [latitude + latitude_delta, longitude + longitude_delta],
    ]


def catalog_response(changed_ids: list[str]) -> dict[str, Any]:
    with database() as connection:
        rows = connection.execute("SELECT * FROM images ORDER BY created_at DESC").fetchall()

    images = []
    for row in rows:
        images.append(
            {
                "id": row["id"],
                "name": Path(row["original_name"]).stem,
                "fileName": row["original_name"],
                "fileSize": row["file_size"],
                "width": row["width"],
                "height": row["height"],
                "latitude": row["latitude"],
                "longitude": row["longitude"],
                "absoluteAltitude": row["absolute_altitude"],
                "relativeAltitude": row["relative_altitude"],
                "projectionAltitude": projection_altitude_meters(row["relative_altitude"]),
                "heading": row["heading"],
                "northOffset": panorama_view_north_offset(row["heading"]),
                "imageUrl": f"/media/images/{row['stored_name']}",
                "downloadUrl": f"/api/images/{row['id']}/download",
                "orthophotoUrl": f"/media/orthophotos/{row['orthophoto_name']}",
                "orthophotoDownloadUrl": f"/api/images/{row['id']}/orthophoto/download",
                "overlayBounds": overlay_bounds(row["latitude"], row["longitude"]),
                "nearbyIds": [
                    other["id"]
                    for other in rows
                    if other["id"] != row["id"] and haversine_meters(row, other) <= NEARBY_DISTANCE_METERS
                ],
            }
        )
    return {"images": images, "changedIds": changed_ids}


def pick_place_name(payload: Any) -> str:
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
    fallback = f"{latitude:.6f}, {longitude:.6f}"
    token = (os.environ.get("TIANDITU_TOKEN") or os.environ.get("VITE_TIANDITU_TOKEN") or "").strip()
    if not token:
        return {"name": fallback}

    query = urlencode(
        {
            "postStr": json.dumps({"lon": longitude, "lat": latitude, "ver": 1}, separators=(",", ":")),
            "type": "geocode",
            "tk": token,
        }
    )
    request = Request(
        f"https://api.tianditu.gov.cn/geocoder?{query}",
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": os.environ.get("TIANDITU_REFERER", "http://localhost:5173/"),
        },
    )
    try:
        with urlopen(request, timeout=GEOCODE_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8", errors="ignore"))
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        logger.warning("天地图逆地理编码失败（%s）", type(error).__name__)
        return {"name": fallback}
    return {"name": pick_place_name(payload) or fallback}


def clean_paths(paths: list[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError as error:
            logger.warning("清理文件失败：%s（%s）", path.name, type(error).__name__)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/geocode/reverse")
async def reverse_geocode(lat: float, lng: float) -> dict[str, str]:
    if not math.isfinite(lat) or not math.isfinite(lng) or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise HTTPException(status_code=400, detail="经纬度无效")
    return await asyncio.to_thread(request_tianditu_reverse_geocode, lat, lng)


@app.get("/api/images")
def list_images() -> dict[str, Any]:
    return catalog_response([])


@app.post("/api/images", status_code=201)
async def upload_images(files: list[UploadFile] = File(...)) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="请选择图片文件")

    created_paths: list[Path] = []
    inserted_ids: list[str] = []
    rows: list[tuple[Any, ...]] = []
    committed = False
    try:
        async with upload_lock:
            for upload in files:
                original_name = Path(upload.filename or "image.jpg").name
                extension = Path(original_name).suffix.lower()
                if extension not in ALLOWED_EXTENSIONS:
                    raise HTTPException(status_code=415, detail=f"不支持文件格式：{original_name}")

                image_id = uuid.uuid4().hex
                stored_name = f"{image_id}{extension}"
                orthophoto_name = f"{image_id}.jpg"
                stored_path = IMAGE_DIR / stored_name
                orthophoto_path = ORTHOPHOTO_DIR / orthophoto_name
                created_paths.extend((stored_path, orthophoto_path))

                size = 0
                with stored_path.open("wb") as target:
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
                if height <= 0 or not 1.9 <= width / height <= 2.1:
                    raise HTTPException(status_code=422, detail=f"图片不是 2:1 全景：{original_name}")

                latitude = finite_number(metadata["latitude"])
                longitude = finite_number(metadata["longitude"])
                heading = finite_number(metadata["heading"])
                if latitude is None or longitude is None or not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                    raise HTTPException(status_code=422, detail=f"图片缺少有效 GPS：{original_name}")
                if heading is None:
                    raise HTTPException(status_code=422, detail=f"图片缺少有效航向：{original_name}")

                absolute_altitude = finite_number(metadata["absolute_altitude"])
                relative_altitude = finite_number(metadata["relative_altitude"])
                await asyncio.to_thread(
                    build_nadir_preview,
                    stored_path,
                    orthophoto_path,
                    heading,
                    relative_altitude,
                )

                inserted_ids.append(image_id)
                rows.append(
                    (
                        image_id,
                        original_name,
                        stored_name,
                        upload.content_type or "application/octet-stream",
                        size,
                        width,
                        height,
                        datetime.now(timezone.utc).isoformat(),
                        latitude,
                        longitude,
                        absolute_altitude,
                        relative_altitude,
                        heading,
                        orthophoto_name,
                    )
                )

            # 文件先全部生成，最后用一次事务写入；提交前任一步失败都会删除本批原图和正射图。
            with database() as connection:
                connection.executemany(
                    """
                    INSERT INTO images (
                        id, original_name, stored_name, mime_type, file_size, width, height, created_at,
                        latitude, longitude, absolute_altitude, relative_altitude, heading, orthophoto_name
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    rows,
                )
            committed = True
            return catalog_response(inserted_ids)
    except BaseException:
        if not committed:
            clean_paths(created_paths)
        raise
    finally:
        for upload in files:
            try:
                await upload.close()
            except OSError as error:
                logger.warning("关闭上传文件失败（%s）", type(error).__name__)


@app.get("/api/images/{image_id}/download")
def download_image(image_id: str) -> FileResponse:
    with database() as connection:
        row = connection.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="影像不存在")
    return FileResponse(IMAGE_DIR / row["stored_name"], filename=row["original_name"], media_type=row["mime_type"])


@app.get("/api/images/{image_id}/orthophoto/download")
def download_orthophoto(image_id: str) -> FileResponse:
    with database() as connection:
        row = connection.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="正射图不存在")
    return FileResponse(
        ORTHOPHOTO_DIR / row["orthophoto_name"],
        filename=f"{Path(row['original_name']).stem}-orthophoto.jpg",
        media_type="image/jpeg",
    )


@app.delete("/api/images/{image_id}")
def delete_image(image_id: str) -> dict[str, Any]:
    with database() as connection:
        row = connection.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="影像不存在")
        connection.execute("DELETE FROM images WHERE id = ?", (image_id,))

    clean_paths([IMAGE_DIR / row["stored_name"], ORTHOPHOTO_DIR / row["orthophoto_name"]])
    return catalog_response([image_id])


DIST_DIR = ROOT_DIR / "dist"
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")
