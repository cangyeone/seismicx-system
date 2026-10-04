import asyncio
import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from backend.map_tiles import TileCache, tile_source
from backend.app import app
from backend.config import settings

PNG = b"\x89PNG\r\n\x1a\n" + b"test-tile"


def test_fixed_sources_and_xyz_boundaries():
    assert tile_source("satellite", 3, 4, 2)[1].endswith("/3/2/4.jpeg")
    assert tile_source("elevation", 3, 4, 2)[1].endswith("/3/4/2.png")
    for args in [
        ("unknown", 0, 0, 0),
        ("elevation", 13, 0, 0),
        ("satellite", 9, 0, 0),
        ("relief", 1, -1, 0),
        ("relief", 1, 0, 2),
        ("relief", -1, 0, 0),
    ]:
        with pytest.raises(HTTPException) as result:
            tile_source(*args)
        assert result.value.status_code == 404


def test_tiles_deduplicate_and_survive_disconnected_viewer(tmp_path):
    async def run():
        calls = 0
        entered, release = asyncio.Event(), asyncio.Event()

        async def fetch(request):
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            return httpx.Response(
                200, content=PNG, headers={"content-type": "image/png"}
            )

        cache = TileCache(tmp_path, httpx.MockTransport(fetch))
        try:
            first = asyncio.create_task(cache.get("elevation", 0, 0, 0))
            await entered.wait()
            second = asyncio.create_task(cache.get("elevation", 0, 0, 0))
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            release.set()
            assert await second == (PNG, "image/png")
            assert await cache.get("elevation", 0, 0, 0) == (PNG, "image/png")
            assert calls == 1
        finally:
            await cache.close()

    asyncio.run(run())


@pytest.mark.parametrize(
    "payload,mime",
    [
        (b"<html>failure</html>", "text/html"),
        (b"wrong", "image/png"),
        (PNG + b"x" * (2 * 1024 * 1024), "image/png"),
    ],
)
def test_tiles_reject_bad_payloads_and_back_off(tmp_path, payload, mime):
    async def run():
        calls = 0

        def fetch(request):
            nonlocal calls
            calls += 1
            return httpx.Response(200, content=payload, headers={"content-type": mime})

        cache = TileCache(tmp_path, httpx.MockTransport(fetch))
        try:
            for _ in range(2):
                with pytest.raises(HTTPException) as result:
                    await cache.get("elevation", 0, 0, 0)
                assert result.value.status_code == 503
                assert "https:" not in result.value.detail
            assert calls == 1
            assert not list(tmp_path.glob("*.tile"))
        finally:
            await cache.close()

    asyncio.run(run())


def test_disk_budget_evicts_old_tiles(tmp_path, monkeypatch):
    import backend.map_tiles as module

    monkeypatch.setattr(module, "MAX_DISK", len(PNG) * 2)

    async def run():
        cache = TileCache(
            tmp_path,
            httpx.MockTransport(
                lambda r: httpx.Response(
                    200, content=PNG, headers={"content-type": "image/png"}
                )
            ),
        )
        try:
            for x in range(4):
                await cache.get("elevation", 2, x, 0)
            assert (
                sum(p.stat().st_size for p in tmp_path.glob("*.tile")) <= len(PNG) * 2
            )
        finally:
            await cache.close()

    asyncio.run(run())


def test_public_tile_cache_headers_do_not_open_admin(tmp_path, monkeypatch):
    for key, value in settings.model_dump().items():
        monkeypatch.setattr(settings, key, value)
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "auto_sync", False)
    monkeypatch.setattr(settings, "broadcast_relay_url", "")
    directory = tmp_path / "map-tiles"
    directory.mkdir()
    (directory / "elevation-0-0-0.tile").write_bytes(PNG)
    with TestClient(app) as client:
        result = client.get("/api/map/tiles/elevation/0/0/0")
        assert result.status_code == 200
        assert result.content == PNG
        assert result.headers["cache-control"].startswith("public,")
        assert client.get("/api/map/tiles/relief/99/0/0").status_code == 404
        assert client.get("/api/settings").status_code == 401
        assert client.get("/api/health").headers["cache-control"] == "no-store"
        assert client.post("/api/map/tiles/elevation/0/0/0").status_code == 401
