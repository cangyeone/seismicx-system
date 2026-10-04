import asyncio
import csv
import io
import json
import secrets
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from .config import settings, ROOT
from .db import init_db, connect, rows, one, now, state, audit
from .schemas import (
    EventInput,
    EventEdit,
    StationInput,
    PickInput,
    WindowInput,
    AnalysisInput,
    LocationInput,
    MagnitudeInput,
    ModelRelayInput,
)
from .worker import enqueue


async def periodic():
    from .sources import sync_stations

    while True:
        try:
            result = await asyncio.to_thread(sync_stations)
            state("source:stations", {"ok": True, **result})
        except Exception as exc:
            state(
                "source:stations",
                {"ok": False, "error": str(exc)[:200], "fetched_at": now()},
            )
        await asyncio.sleep(max(300, settings.sync_seconds))


@asynccontextmanager
async def lifespan(app):
    init_db()
    from .auth import init_auth
    from .runtime_settings import refresh

    init_auth()
    refresh()
    from .broadcast import BroadcastService
    from .broadcast_feeds import run_feeds
    from .map_tiles import TileCache
    from .catalog_reports import CatalogReports

    app.state.map_tiles = TileCache(settings.data_dir / "map-tiles")
    app.state.broadcast = BroadcastService()
    app.state.broadcast.start()
    app.state.catalog_reports = CatalogReports()
    app.state.catalog_reports.start()
    app.state.model_relay_busy = 0
    tasks = (
        [asyncio.create_task(periodic()), asyncio.create_task(run_feeds())]
        if settings.auto_sync
        else []
    )
    yield
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await app.state.broadcast.stop()
    await app.state.catalog_reports.stop()
    await app.state.map_tiles.close()


app = FastAPI(
    title="SeismicX 自动编目平台",
    version="2.1.0-community.1",
    lifespan=lifespan,
    docs_url="/api/admin/docs",
    redoc_url=None,
    openapi_url="/api/admin/openapi.json",
)
from .auth import router as auth_router

app.include_router(auth_router)
from .map_tiles import router as map_router

app.include_router(map_router)


@app.middleware("http")
async def authenticate(request: Request, call_next):
    from .auth import identity, same_origin

    path, method = request.url.path, request.method
    relay = path == "/api/internal/llm" and method == "POST"
    if relay and (
        not settings.model_relay_key
        or not secrets.compare_digest(
            request.headers.get("x-seismicx-relay", ""), settings.model_relay_key
        )
    ):
        return JSONResponse({"detail": "服务端模型转发认证失败"}, status_code=401)
    request.state.admin = (
        await asyncio.to_thread(identity, request) if path.startswith("/api/") else None
    )
    public_read = method in ("GET", "HEAD") and (
        path
        in {
            "/api/health",
            "/api/overview",
            "/api/stations",
            "/api/events",
            "/api/catalog/export",
            "/api/stream",
            "/api/auth/session",
            "/api/broadcast/feed",
            "/api/analysis/report",
        }
        or re.fullmatch(r"/api/(events|waveforms)/[^/]+", path)
        or re.fullmatch(r"/api/broadcast/events/[^/]+/(brief|waves)", path)
        or re.fullmatch(r"/api/map/tiles/[^/]+/-?\d+/-?\d+/-?\d+", path)
    )
    public_post = method == "POST" and (
        path in {"/api/auth/login", "/api/analysis", "/api/analysis/report"}
        or relay
        or re.fullmatch(r"/api/broadcast/events/[^/]+/(brief|waves)", path)
    )
    if (
        path.startswith("/api/")
        and not (public_read or public_post)
        and not request.state.admin
    ):
        return JSONResponse({"detail": "请登录后台管理"}, status_code=401)
    if (
        request.state.admin
        and method not in ("GET", "HEAD", "OPTIONS")
        and path != "/api/auth/login"
    ):
        if not same_origin(request) or not secrets.compare_digest(
            request.headers.get("x-csrf-token", ""), request.state.admin["csrf"]
        ):
            return JSONResponse(
                {"detail": "登录校验已失效，请刷新页面"}, status_code=403
            )
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    if path.startswith("/api/") and not (
        path.startswith("/api/map/tiles/") and response.status_code == 200
    ):
        response.headers["Cache-Control"] = "no-store"
    return response


def public_event(event):
    result = dict(event)
    # Public catalogue retains scientific provenance, never worker paths or payloads.
    provenance = json.loads(result.get("provenance") or "{}")
    result["provenance"] = json.dumps(
        {
            k: provenance[k]
            for k in (
                "qc",
                "skill_revision",
                "model_sha256",
                "velocity",
                "url",
                "provider",
                "fetched_at",
            )
            if k in provenance
        }
    )
    if "alternate_reports" in result:
        result["alternate_reports"] = [
            public_event(e) for e in result["alternate_reports"]
        ]
    return result


def public_status(value):
    if not value:
        return value
    return {
        k: value[k]
        for k in (
            "ok",
            "heartbeat",
            "fetched_at",
            "count",
            "events",
            "received",
            "connected",
            "online",
            "subscribed",
            "cycle_seconds",
            "picks",
            "lagging",
        )
        if k in value
    }


@app.exception_handler(ValueError)
async def value_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=422)


def require_event(eid):
    event = one("SELECT * FROM events WHERE id=?", (eid,))
    if not event:
        raise HTTPException(404, "事件不存在")
    return event


@app.get("/api/health")
def health():
    return {"status": "ok", "time": now(), "version": "2.1.0-community.1"}


@app.get("/api/overview")
def overview():
    stations = list_stations()
    from datetime import timedelta

    cutoff = (
        (datetime.now(timezone.utc) - timedelta(days=1))
        .isoformat()
        .replace("+00:00", "Z")
    )
    latency = [
        s["latency_s"] for s in stations if s["latency_s"] is not None and s["enabled"]
    ]
    return {
        "platform_name": settings.platform_name,
        "edge": public_status(state("edge")),
        "npu": public_status(state("npu")),
        "stations": len(stations),
        "enabled": sum(s["enabled"] for s in stations),
        "online": sum(s["status"] == "online" for s in stations),
        "events_24h": one(
            "SELECT count(*) AS n FROM events WHERE origin_time>=? AND status!='rejected'",
            (cutoff,),
        )["n"],
        "candidates": one("SELECT count(*) AS n FROM events WHERE status='candidate'")[
            "n"
        ],
        "latency_s": sorted(latency)[len(latency) // 2] if latency else None,
        "sources": {
            "catalog": public_status(state("source:catalog")),
            "cenc": public_status(state("source:cenc")),
            "stations": public_status(state("source:stations")),
        },
        "collector": public_status(state("collector")),
        "worker": public_status(state("worker")),
        "time": now(),
    }


@app.get("/api/broadcast/feed")
def broadcast_feed(after: int | None = Query(None, ge=0)):
    from .broadcast_feeds import feed

    result = feed(after)
    result["events"] = [public_event(e) for e in result["events"]]
    result["notices"] = [public_event(e) for e in result["notices"]]
    result["sources"] = {k: public_status(v) for k, v in result["sources"].items()}
    return result


@app.get("/api/broadcast/events/{eid}/brief")
@app.post("/api/broadcast/events/{eid}/brief")
async def broadcast_brief(eid: str, request: Request):
    event = require_event(eid)
    return await request.app.state.broadcast.brief(event, request.method == "POST")


@app.get("/api/broadcast/events/{eid}/waves")
@app.post("/api/broadcast/events/{eid}/waves")
async def broadcast_waves(eid: str, request: Request):
    event = require_event(eid)
    return request.app.state.broadcast.waves(event, request.method == "POST")


@app.get("/api/stations")
def list_stations():
    result = rows("SELECT * FROM stations ORDER BY enabled DESC,network,station")
    for s in result:
        s["error"] = "采集暂不可用" if s["error"] else None
        s["latency_s"] = (
            max(
                0,
                (
                    datetime.now(timezone.utc)
                    - datetime.fromisoformat(s["last_sample"].replace("Z", "+00:00"))
                ).total_seconds(),
            )
            if s["last_sample"]
            else None
        )
        s["status"] = (
            "disabled"
            if not s["enabled"]
            else "online"
            if s["latency_s"] is not None and s["latency_s"] < 180
            else "stale"
            if s["last_sample"]
            else "waiting"
        )
    return result


@app.post("/api/stations")
def add_station(data: StationInput):
    value = data.model_dump()
    sid = f"{data.network}.{data.station}.{data.location}"
    with connect() as db:
        if db.execute("SELECT 1 FROM stations WHERE id=?", (sid,)).fetchone():
            raise HTTPException(409, "台站已存在")
        value.update(id=sid, updated_at=now())
        db.execute(
            f"INSERT INTO stations({','.join(value)}) VALUES ({','.join('?' for _ in value)})",
            list(value.values()),
        )
        audit(db, "station", sid, None, value, "添加台站")
    return value


@app.patch("/api/stations/{sid}")
def edit_station(sid: str, data: StationInput):
    with connect() as db:
        old = db.execute("SELECT * FROM stations WHERE id=?", (sid,)).fetchone()
        if not old:
            raise HTTPException(404, "台站不存在")
        if sid != f"{data.network}.{data.station}.{data.location}":
            raise HTTPException(422, "台站标识不可修改，请另建台站")
        value = data.model_dump()
        db.execute(
            f"UPDATE stations SET {','.join(k + '=?' for k in value)},updated_at=? WHERE id=?",
            [*value.values(), now(), sid],
        )
        audit(db, "station", sid, dict(old), value, "更新台站配置")
    return {"id": sid, **value}


@app.get("/api/events")
def list_events(
    q: str = "",
    source: str = "all",
    status: str = "all",
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    monitored: bool = False,
):
    sql, values = "SELECT * FROM events WHERE 1=1", []
    if q:
        sql += " AND (place LIKE ? OR id LIKE ?)"
        values.extend([f"%{q}%", f"%{q}%"])
    if source != "all":
        sql += " AND source=?"
        values.append(source)
    if status != "all":
        sql += " AND status=?"
        values.append(status)
    if monitored:
        sql += " AND monitored=1"
    total = one("SELECT COUNT(*) AS n FROM (" + sql + ")", values)["n"]
    return {
        "items": [
            public_event(e)
            for e in rows(
                sql + " ORDER BY origin_time DESC LIMIT ? OFFSET ?",
                [*values, limit, offset],
            )
        ],
        "total": total,
    }


@app.get("/api/catalog/export")
def export_catalog(
    format: str = "csv",
    source: str = "all",
    status: str = "all",
    q: str = "",
    monitored: bool = False,
):
    if format not in ("csv", "quakeml"):
        raise HTTPException(422, "格式必须是 csv 或 quakeml")
    sql, params = "SELECT * FROM events WHERE 1=1", []
    if source != "all":
        sql += " AND source=?"
        params.append(source)
    if status != "all":
        sql += " AND status=?"
        params.append(status)
    if q:
        sql += " AND (place LIKE ? OR id LIKE ?)"
        params.extend([f"%{q}%", f"%{q}%"])
    if monitored:
        sql += " AND monitored=1"
    events = rows(sql + " ORDER BY origin_time", params)
    if format == "csv":
        fields = [
            "id",
            "origin_time",
            "latitude",
            "longitude",
            "depth_km",
            "magnitude",
            "magnitude_type",
            "source",
            "status",
            "rms",
            "n_picks",
            "method",
            "velocity_model",
            "version",
            "notes",
        ]

        def generate():
            buf = io.StringIO()
            writer = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            yield "\ufeff" + buf.getvalue()
            for event in events:
                # Prevent spreadsheet formula execution in user-supplied labels.
                safe = {
                    k: (
                        "'" + v
                        if isinstance(v, str) and v.startswith(("=", "+", "-", "@"))
                        else v
                    )
                    for k, v in event.items()
                }
                buf.seek(0)
                buf.truncate(0)
                writer.writerow(safe)
                yield buf.getvalue()

        return StreamingResponse(
            generate(),
            media_type="text/csv",
            headers={
                "Content-Disposition": "attachment; filename=seismicx-catalog.csv"
            },
        )
    from obspy import UTCDateTime
    from obspy.core.event import (
        Catalog,
        Event,
        Origin,
        Magnitude,
        Comment,
        Pick,
        WaveformStreamID,
    )

    catalog = Catalog()
    for e in events:
        origin = Origin(
            time=UTCDateTime(e["origin_time"]),
            latitude=e["latitude"],
            longitude=e["longitude"],
            depth=e["depth_km"] * 1000,
        )
        event = Event(
            origins=[origin],
            comments=[
                Comment(
                    text=f"id={e['id']}; source={e['source']}; status={e['status']}; method={e['method']}"
                )
            ],
        )
        if e["magnitude"] is not None:
            event.magnitudes = [
                Magnitude(mag=e["magnitude"], magnitude_type=e["magnitude_type"])
            ]
        for p in rows("SELECT * FROM picks WHERE event_id=?", (e["id"],)):
            parts = p["station_id"].split(".")
            event.picks.append(
                Pick(
                    time=UTCDateTime(p["time"]),
                    phase_hint=p["phase"],
                    waveform_id=WaveformStreamID(
                        network_code=parts[0],
                        station_code=parts[1],
                        location_code=parts[2] if len(parts) > 2 else "",
                    ),
                )
            )
        catalog.append(event)
    buffer = io.BytesIO()
    catalog.write(buffer, format="QUAKEML")
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="application/xml",
        headers={"Content-Disposition": "attachment; filename=seismicx-catalog.xml"},
    )


@app.post("/api/events")
def create_event(data: EventInput):
    value = data.model_dump()
    value.update(
        id="manual:" + uuid.uuid4().hex[:16],
        source="manual",
        status="manual",
        updated_at=now(),
    )
    with connect() as db:
        db.execute(
            f"INSERT INTO events({','.join(value)}) VALUES ({','.join('?' for _ in value)})",
            list(value.values()),
        )
        audit(db, "event", value["id"], None, value, "人工录入历史地震")
    return require_event(value["id"])


@app.get("/api/events/{eid}")
def event_detail(eid: str, request: Request):
    event = (
        require_event(eid) if request.state.admin else public_event(require_event(eid))
    )
    event["picks"] = rows("SELECT * FROM picks WHERE event_id=? ORDER BY time", (eid,))
    event["audit"] = rows(
        "SELECT * FROM audit WHERE entity_id=? OR entity_id IN (SELECT id FROM picks WHERE event_id=?) ORDER BY id DESC LIMIT 100",
        (eid, eid),
    )
    if not request.state.admin:
        event["audit"] = []
        for pick in event["picks"]:
            pick.pop("waveform_path", None)
    from obspy.geodetics import gps2dist_azimuth

    nearby = list_stations()
    for s in nearby:
        s["distance_km"] = (
            gps2dist_azimuth(
                event["latitude"], event["longitude"], s["latitude"], s["longitude"]
            )[0]
            / 1000
        )
    ordered = sorted(nearby, key=lambda s: s["distance_km"])
    picked = {p["station_id"] for p in event["picks"]}
    event["stations"] = [
        s for i, s in enumerate(ordered) if i < 32 or s["id"] in picked
    ]
    return event


@app.patch("/api/events/{eid}")
def edit_event(eid: str, data: EventEdit):
    value = data.model_dump(exclude={"version", "reason"})
    with connect() as db:
        row = db.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
        if not row:
            raise HTTPException(404, "事件不存在")
        old = dict(row)
        updated = db.execute(
            f"UPDATE events SET {','.join(k + '=?' for k in value)},version=version+1,updated_at=? WHERE id=? AND version=?",
            [*value.values(), now(), eid, data.version],
        ).rowcount
        if not updated:
            raise HTTPException(409, "事件已被修改，请刷新后重试")
        audit(
            db, "event", eid, old, {**value, "version": data.version + 1}, data.reason
        )
    return require_event(eid)


@app.post("/api/events/{eid}/picks")
def add_pick(eid: str, data: PickInput):
    require_event(eid)
    if not one("SELECT id FROM stations WHERE id=?", (data.station_id,)):
        raise HTTPException(422, "台站不存在")
    pid = uuid.uuid4().hex
    with connect() as db:
        if db.execute(
            "SELECT 1 FROM picks WHERE event_id=? AND station_id=? AND phase=? AND time=?",
            (eid, data.station_id, data.phase, data.time),
        ).fetchone():
            raise HTTPException(409, "重复震相")
        db.execute(
            "INSERT INTO picks(id,event_id,station_id,phase,time,method) VALUES (?,?,?,?,?,'manual')",
            (pid, eid, data.station_id, data.phase, data.time),
        )
        db.execute(
            "UPDATE events SET n_picks=n_picks+1,version=version+1,status='candidate',updated_at=? WHERE id=?",
            (now(), eid),
        )
        audit(db, "pick", pid, None, data.model_dump(), data.reason)
    return {"id": pid}


@app.patch("/api/picks/{pid}")
def edit_pick(pid: str, data: PickInput):
    if not one("SELECT id FROM stations WHERE id=?", (data.station_id,)):
        raise HTTPException(422, "台站不存在")
    with connect() as db:
        row = db.execute("SELECT * FROM picks WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "震相不存在")
        old = dict(row)
        if not db.execute(
            "UPDATE picks SET station_id=?,phase=?,time=?,method='manual',version=version+1 WHERE id=? AND version=?",
            (data.station_id, data.phase, data.time, pid, data.version),
        ).rowcount:
            raise HTTPException(409, "震相已被修改")
        db.execute(
            "UPDATE events SET version=version+1,status='candidate',updated_at=? WHERE id=?",
            (now(), old["event_id"]),
        )
        audit(db, "pick", pid, old, data.model_dump(), data.reason)
    return {"id": pid}


@app.delete("/api/picks/{pid}")
def remove_pick(
    pid: str, version: int, reason: str = Query(min_length=2, max_length=500)
):
    with connect() as db:
        row = db.execute("SELECT * FROM picks WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "震相不存在")
        old = dict(row)
        if not db.execute(
            "DELETE FROM picks WHERE id=? AND version=?", (pid, version)
        ).rowcount:
            raise HTTPException(409, "震相已被修改")
        db.execute(
            "UPDATE events SET n_picks=MAX(0,n_picks-1),version=version+1,status='candidate' WHERE id=?",
            (old["event_id"],),
        )
        audit(db, "event", old["event_id"], old, None, "删除震相: " + reason)
    return {"deleted": pid}


@app.get("/api/waveforms/{sid}")
def waveform(
    sid: str, start: str, end: str, points: int = Query(1200, ge=400, le=6000)
):
    from .sources import waveforms_view

    station = one("SELECT * FROM stations WHERE id=?", (sid,))
    if not station:
        raise HTTPException(404, "台站不存在")
    window = WindowInput(start=start, end=end, station_ids=[sid])
    try:
        return waveforms_view(station, window.start, window.end, points)
    except Exception as exc:
        raise HTTPException(502, "该时段真实波形暂不可用，请稍后重试") from exc


@app.post("/api/jobs/detect", status_code=202)
def detect_job(data: WindowInput):
    if data.event_id:
        require_event(data.event_id)
    return enqueue("detect", data.model_dump(exclude_unset=True))


@app.post("/api/events/{eid}/relocate", status_code=202)
def relocate_job(eid: str, data: LocationInput):
    require_event(eid)
    return enqueue("relocate", {"event_id": eid, **data.model_dump(exclude_unset=True)})


@app.post("/api/events/{eid}/magnitude", status_code=202)
def magnitude_job(eid: str, data: MagnitudeInput):
    require_event(eid)
    return enqueue("magnitude", {"event_id": eid, **data.model_dump()})


@app.post("/api/sync", status_code=202)
def sync_job():
    return enqueue("sync", {})


@app.get("/api/jobs")
def jobs():
    return rows("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50")


@app.get("/api/settings")
def configuration():
    from .runtime_settings import refresh, RuntimeConfig

    runtime = refresh()
    from .algorithms import engine_status

    return {
        "runtime": runtime,
        "runtime_schema": RuntimeConfig.model_json_schema(),
        "algorithms": engine_status(),
        "llm": {
            "model": settings.llm_model,
            "base_url": settings.llm_base_url,
            "context_tokens": min(settings.llm_context_tokens, 7900),
            "output_tokens": min(settings.llm_output_tokens, 1400),
        },
        "cloud_llm": {
            "configured": bool(
                settings.cloud_llm_base_url and settings.cloud_llm_model
            ),
            "base_url": settings.cloud_llm_base_url,
            "model": settings.cloud_llm_model,
        },
        "seedlink": settings.seedlink_server,
        "queue_capacity": settings.queue_capacity,
        "retention_days": settings.waveform_retention_days,
        "disk_limit_gb": settings.waveform_disk_limit_gb,
    }


from .runtime_settings import UpdateConfig


@app.put("/api/settings")
def update_configuration(data: UpdateConfig, request: Request):
    from .runtime_settings import save

    return save(data, request.state.admin["username"])


@app.get("/api/edge/status")
def edge_status():
    import shutil

    disk = shutil.disk_usage(settings.data_dir)
    return {
        "platform_name": settings.platform_name,
        "enabled": settings.edge_enabled,
        "backend": settings.inference_backend,
        "edge": state("edge"),
        "npu": state("npu"),
        "llm": state("llm"),
        "benchmark": state("edge-benchmark"),
        "max_stations": settings.edge_max_stations,
        "interval_seconds": settings.edge_interval_seconds,
        "window_seconds": settings.edge_window_seconds,
        "disk_free_gb": round(disk.free / 1024**3, 2),
        "recent_picks": rows(
            "SELECT * FROM realtime_picks ORDER BY time DESC LIMIT 50"
        ),
    }


@app.post("/api/analysis")
async def analysis(data: AnalysisInput, request: Request):
    if data.use_llm and not request.state.admin:
        raise HTTPException(401, "自定义模型分析需要后台登录；地图自动解读可公开查看")
    from .analysis import analyze
    from .runtime_settings import refresh

    refresh()

    try:
        return await analyze(data)
    except ValueError:
        raise
    except Exception as exc:
        raise HTTPException(502, "模型服务不可用；统计分析仍可使用。") from exc


@app.get("/api/analysis/report")
@app.post("/api/analysis/report")
async def catalog_report(request: Request, days: int = 7, source: str = "all"):
    from .catalog_reports import REPORT_DAYS, REPORT_SOURCES

    if days not in REPORT_DAYS or source not in REPORT_SOURCES:
        raise HTTPException(422, "请选择有效的目录时间窗和来源")
    return request.app.state.catalog_reports.get(days, source, request.method == "POST")


@app.post("/api/internal/llm")
async def relay_model(data: ModelRelayInput, request: Request):
    from .analysis import complete

    if not settings.edge_enabled:
        raise HTTPException(503, "当前服务不是边缘模型处理端")
    if request.app.state.model_relay_busy >= 2:
        raise HTTPException(429, "模型转发任务已满")
    messages = [m.model_dump() for m in data.messages]
    bound = sum(len(m["content"].encode("utf-8")) + 32 for m in messages)
    output = min(data.output, settings.llm_output_tokens, 1400)
    if bound + output >= min(7900, settings.llm_context_tokens):
        raise HTTPException(422, "模型请求超过处理端预算")
    request.app.state.model_relay_busy += 1
    try:
        payload, model = await complete(messages, output, "local", allow_relay=False)
        return {"payload": payload, "model": model, "output_limit": output}
    except Exception as exc:
        raise HTTPException(502, "开发板本地模型暂不可用") from exc
    finally:
        request.app.state.model_relay_busy -= 1


@app.get("/api/stream")
async def stream():
    async def events():
        while True:
            yield (
                "event: status\ndata: "
                + json.dumps(await asyncio.to_thread(overview))
                + "\n\n"
            )
            await asyncio.sleep(5)

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )


if (ROOT / "dist/assets").is_dir():
    app.mount("/assets", StaticFiles(directory=ROOT / "dist/assets"), name="assets")
if (ROOT / "dist/cesium").is_dir():
    app.mount("/cesium", StaticFiles(directory=ROOT / "dist/cesium"), name="cesium")


@app.get("/map-cache-worker.js")
@app.get("/map-cache-policy.js")
async def map_cache_script(request: Request):
    return FileResponse(
        ROOT / "public" / request.url.path.lstrip("/"),
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
    )


@app.get("/map-sources.html")
def map_sources():
    return FileResponse(ROOT / "public/map-sources.html")


@app.get("/world.geojson")
def world():
    return FileResponse(ROOT / "public/world.geojson")


@app.get("/plates.geojson")
def plates():
    return FileResponse(ROOT / "public/plates.geojson")


@app.get("/admin")
@app.get("/")
def index():
    if (ROOT / "dist/index.html").exists():
        return FileResponse(ROOT / "dist/index.html")
    return {"message": "运行 npm run dev 或 npm run build 打开工作台", "docs": "/docs"}
