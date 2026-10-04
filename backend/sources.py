"""Bounded real FDSN access. A station inventory is not evidence of live data."""

import io
import hashlib
import math
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
import httpx
import numpy as np
from .db import connect, now, state, rows
from .config import settings

PROVIDERS = {
    "EARTHSCOPE": "https://service.earthscope.org",
    "GEOFON": "https://geofon.gfz.de",
    "SCEDC": "https://service.scedc.caltech.edu",
    "BGR": "https://eida.bgr.de",
    "INGV": "https://webservices.ingv.it",
    "INFP": "https://eida-sc3.infp.ro",
}


def get(url, params=None, timeout=35):
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        with client.stream("GET", url, params=params) as response:
            response.raise_for_status()
            parts, size = [], 0
            for part in response.iter_bytes():
                size += len(part)
                if size > 40_000_000:
                    raise ValueError("公共源单请求超过 40 MB，请缩小时间窗或台站范围")
                parts.append(part)
            return httpx.Response(
                response.status_code,
                content=b"".join(parts),
                request=response.request,
                headers={
                    k: v
                    for k, v in response.headers.items()
                    if k not in ("content-encoding", "content-length")
                },
            )


def sync_catalog():
    data = get(
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson"
    ).json()
    count = 0
    with connect() as db:
        for feature in data.get("features", []):
            p, coords = feature["properties"], feature["geometry"]["coordinates"]
            if any(v is None or not math.isfinite(v) for v in coords[:3]):
                continue
            origin = (
                datetime.fromtimestamp(p["time"] / 1000, timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
            db.execute(
                """INSERT INTO events(id,origin_time,latitude,longitude,depth_km,magnitude,
                magnitude_type,place,source,status,rms,method,provenance,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                origin_time=excluded.origin_time,latitude=excluded.latitude,longitude=excluded.longitude,
                depth_km=excluded.depth_km,magnitude=excluded.magnitude,magnitude_type=excluded.magnitude_type,
                place=excluded.place,rms=excluded.rms,provenance=excluded.provenance,updated_at=excluded.updated_at
                WHERE events.status='external' AND events.version=1""",
                (
                    "usgs:" + feature["id"],
                    origin,
                    coords[1],
                    coords[0],
                    coords[2],
                    p.get("mag"),
                    p.get("magType", ""),
                    p.get("place") or feature["id"],
                    "USGS",
                    "external",
                    p.get("rms"),
                    "USGS published catalog",
                    __import__("json").dumps(
                        {
                            "url": p.get("url"),
                            "detail": p.get("detail"),
                            "updated": p.get("updated"),
                            "feed_generated": data.get("metadata", {}).get("generated"),
                        }
                    ),
                    now(),
                ),
            )
            count += 1
    return {"count": count, "fetched_at": now(), "source": "USGS M2.5+ past day"}


def sync_stations(provider="EARTHSCOPE", network="IU,II"):
    text = get(
        PROVIDERS[provider] + "/fdsnws/station/1/query",
        {
            "network": network,
            "level": "station",
            "format": "text",
            "endafter": now(),
            "nodata": 204,
        },
    ).text
    count = 0
    with connect() as db:
        for line in text.splitlines():
            if not line.strip() or line.startswith("#"):
                continue
            parts = line.split("|")
            if len(parts) < 6:
                continue
            net, sta, lat, lon, elev, name = parts[:6]
            # Location is selected from waveform metadata; wildcard fetch allows real epochs.
            sid = f"{net}.{sta}."
            db.execute(
                """INSERT INTO stations(id,network,station,latitude,longitude,elevation_m,name,provider,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                latitude=excluded.latitude,longitude=excluded.longitude,elevation_m=excluded.elevation_m,
                name=excluded.name,updated_at=excluded.updated_at
                WHERE NOT EXISTS (SELECT 1 FROM audit WHERE entity='station' AND entity_id=stations.id)""",
                (
                    sid,
                    net,
                    sta,
                    float(lat),
                    float(lon),
                    float(elev),
                    name,
                    provider,
                    now(),
                ),
            )
            count += 1
    return {"count": count, "fetched_at": now(), "provider": provider}


def sync_all():
    results = {}
    actions = {"catalog": sync_catalog, "stations": sync_stations}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(fn): name for name, fn in actions.items()}
        for future in as_completed(futures):
            name = futures[future]
            try:
                results[name] = {"ok": True, **future.result()}
            except Exception as exc:
                results[name] = {
                    "ok": False,
                    "error": str(exc)[:500],
                    "fetched_at": now(),
                }
            state("source:" + name, results[name])
    return results


def register_waveform(path, stream, station_id, source, live=False):
    start = min(t.stats.starttime for t in stream)
    end = max(t.stats.endtime for t in stream)
    with connect() as db:
        db.execute(
            "INSERT INTO waveform_files VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET start=MIN(start,excluded.start),end=MAX(end,excluded.end)",
            (str(path), station_id, str(start), str(end), source, now()),
        )
        if live:
            db.execute(
                """UPDATE stations SET last_sample=CASE WHEN last_sample IS NULL OR last_sample<?
                THEN ? ELSE last_sample END,last_received=?,error=NULL WHERE id=?""",
                (str(end), str(end), now(), station_id),
            )


def fetch_waveform(station, start, end, directory=None, live=False):
    from obspy import read

    directory = Path(directory or settings.data_dir / "waveforms")
    directory.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(
        f"{station['id']}|{station['channel']}|{start}|{end}|{station['provider']}".encode()
    ).hexdigest()[:24]
    path = directory / (key + ".mseed")
    if path.exists():
        return path, read(str(path))
    response = get(
        PROVIDERS[station["provider"]] + "/fdsnws/dataselect/1/query",
        {
            "net": station["network"],
            "sta": station["station"],
            "loc": station["location"] or "*",
            "cha": station["channel"],
            "start": start,
            "end": end,
            "nodata": 404,
        },
        timeout=45,
    )
    if len(response.content) > 40_000_000:
        raise ValueError("单请求超过 40 MB，请缩短时间窗")
    stream = read(io.BytesIO(response.content))
    if not stream:
        raise ValueError("数据源未返回可读波形")
    for trace in stream:
        if not np.all(np.isfinite(trace.data)):
            raise ValueError("波形包含非有限采样值")
    with tempfile.NamedTemporaryFile(
        dir=directory, suffix=".tmp", delete=False
    ) as handle:
        temp = Path(handle.name)
        handle.write(response.content)
    try:
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)
    register_waveform(path, stream, station["id"], station["provider"], live)
    return path, stream


def waveforms_view(station, start, end, max_points=1200):
    from obspy import Stream, read, UTCDateTime

    # Prefer data received by the collector, then use the FDSN archive.
    files = rows(
        "SELECT path FROM waveform_files WHERE station_id=? AND end>=? AND start<=? ORDER BY start LIMIT 500",
        (station["id"], start, end),
    )
    stream = Stream()
    for item in files:
        if Path(item["path"]).exists():
            stream += read(
                item["path"], starttime=UTCDateTime(start), endtime=UTCDateTime(end)
            )
    if not stream:
        _, stream = fetch_waveform(station, start, end)
    stream.merge(method=1, fill_value=None)
    stream.trim(UTCDateTime(start), UTCDateTime(end))
    output = []
    for trace in stream:
        data = np.ma.asarray(trace.data, dtype=float)
        stride = max(1, math.ceil(len(data) / max_points))
        points = []
        # Min/max envelope preserves impulsive arrivals; gaps remain null.
        for i in range(0, len(data), stride):
            section = data[i : i + stride]
            if np.ma.getmaskarray(section).any():
                points.append([i / trace.stats.sampling_rate, None, None])
            else:
                points.append(
                    [
                        i / trace.stats.sampling_rate,
                        float(section.min()),
                        float(section.max()),
                    ]
                )
        output.append(
            {
                "id": trace.id,
                "start": str(trace.stats.starttime),
                "sample_rate": trace.stats.sampling_rate,
                "npts": trace.stats.npts,
                "units": "counts",
                "sample_stride": stride,
                "points": points,
            }
        )
    return {
        "station_id": station["id"],
        "source": station["provider"],
        "traces": output,
    }
