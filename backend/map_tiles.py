"""Fixed-source open map tiles; bounded I/O, cache and public response size."""

import asyncio
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

router = APIRouter(prefix="/api/map")
GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
SOURCES = {
    "elevation": (
        12,
        "image/png",
        "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    ),
    "satellite": (
        8,
        "image/jpeg",
        GIBS
        + "/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
    ),
    "relief": (
        12,
        "image/jpeg",
        GIBS
        + "/ASTER_GDEM_Color_Shaded_Relief/default/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpeg",
    ),
}
MAX_TILE = 2 * 1024 * 1024
MAX_DISK = 256 * 1024 * 1024
TTL = 30 * 86400


def tile_source(kind, z, x, y):
    if kind not in SOURCES:
        raise HTTPException(404, "未知地图图层")
    maximum, mime, template = SOURCES[kind]
    if not 0 <= z <= maximum or not (0 <= x < 2**z and 0 <= y < 2**z):
        raise HTTPException(404, "瓦片超出覆盖范围")
    return mime, template.format(z=z, x=x, y=y)


class TileCache:
    def __init__(self, directory: Path, transport=None):
        self.directory = directory
        self.client = httpx.AsyncClient(
            timeout=20,
            follow_redirects=False,
            transport=transport,
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
        )
        self.slots = asyncio.Semaphore(8)
        self.pending = {}
        self.failed = {}
        self.disk_lock = asyncio.Lock()
        self.disk_size = None

    async def close(self):
        tasks = list(self.pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.client.aclose()

    def _read(self, path):
        try:
            info = path.stat()
            if info.st_size <= MAX_TILE and time.time() - info.st_mtime < TTL:
                return path.read_bytes()
        except OSError:
            pass
        return None

    def _write(self, path, data):
        self.directory.mkdir(parents=True, exist_ok=True)
        if self.disk_size is None or self.disk_size + len(data) > MAX_DISK:
            files = sorted(
                (
                    (p.stat().st_mtime, p.stat().st_size, p)
                    for p in self.directory.glob("*.tile")
                ),
                key=lambda entry: entry[0],
            )
            self.disk_size = sum(size for _, size, _ in files)
            for modified, size, old in files:
                if (
                    self.disk_size + len(data) <= MAX_DISK
                    and time.time() - modified < TTL
                ):
                    break
                old.unlink(missing_ok=True)
                self.disk_size -= size
        previous = path.stat().st_size if path.exists() else 0
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(data)
        temporary.replace(path)
        self.disk_size += len(data) - previous

    async def get(self, kind, z, x, y):
        mime, url = tile_source(kind, z, x, y)
        key = f"{kind}-{z}-{x}-{y}"
        path = self.directory / f"{key}.tile"
        data = await asyncio.to_thread(self._read, path)
        if data is not None:
            return data, mime
        if self.failed.get(key, 0) > time.monotonic():
            raise HTTPException(
                503, "地图源暂不可用，请稍后重试", headers={"Retry-After": "30"}
            )
        if key not in self.pending:
            if len(self.pending) >= 64:
                raise HTTPException(503, "地图请求排队中", headers={"Retry-After": "5"})
            self.pending[key] = asyncio.create_task(self._fetch(key, path, mime, url))
        # One disconnected viewer must not cancel a shared tile download.
        return await asyncio.shield(self.pending[key])

    async def _fetch(self, key, path, mime, url):
        try:
            async with self.slots, self.client.stream("GET", url) as response:
                response.raise_for_status()
                if response.headers.get("content-type", "").split(";")[0] != mime:
                    raise ValueError("Unexpected map payload")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_TILE:
                        raise ValueError("Oversized map tile")
                if not data.startswith(
                    b"\x89PNG\r\n\x1a\n" if mime == "image/png" else b"\xff\xd8\xff"
                ):
                    raise ValueError("Invalid map tile")
            async with self.disk_lock:
                await asyncio.to_thread(self._write, path, data)
            self.failed.pop(key, None)
            return bytes(data), mime
        except (httpx.HTTPError, OSError, ValueError):
            if len(self.failed) >= 256:
                self.failed.pop(next(iter(self.failed)))
            self.failed[key] = time.monotonic() + 30
            raise HTTPException(
                503, "地图源暂不可用，请稍后重试", headers={"Retry-After": "30"}
            ) from None
        finally:
            self.pending.pop(key, None)


@router.get("/tiles/{kind}/{z}/{x}/{y}")
async def map_tile(kind: str, z: int, x: int, y: int, request: Request):
    data, mime = await request.app.state.map_tiles.get(kind, z, x, y)
    return Response(
        data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=604800, stale-if-error=2592000"},
    )
