"""Independent public bulletin polling and durable, restart-safe notifications."""

import asyncio
import json
import math
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from .db import connect, rows, one, state, now
from .sources import get, sync_catalog
from .config import settings

CENC_URL = "https://www.ceic.ac.cn/data/data.json"


def epoch(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def distance(a, b):
    lat1, lat2 = math.radians(a["latitude"]), math.radians(b["latitude"])
    dlat = lat2 - lat1
    dlon = math.radians(b["longitude"] - a["longitude"])
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 12742 * math.asin(min(1, math.sqrt(h)))


def same_event(a, b):
    """Conservative presentation grouping only; scientific catalogs stay separate."""
    return (
        a["source"] != b["source"]
        and abs(epoch(a["origin_time"]) - epoch(b["origin_time"])) <= 60
        and distance(a, b) <= 80
        and (
            a["magnitude"] is None
            or b["magnitude"] is None
            or abs(a["magnitude"] - b["magnitude"]) <= 0.8
        )
    )


def cenc_record(item):
    # The official page explicitly labels time as Beijing time, not UTC.
    origin = datetime.strptime(item["time"], "%Y-%m-%d %H:%M:%S").replace(
        tzinfo=timezone(timedelta(hours=8))
    )
    lat, lon, depth, mag = [
        float(item[k]) for k in ("latitude", "longitude", "depth", "magnitude")
    ]
    if not all(math.isfinite(v) for v in (lat, lon, depth, mag)) or not (
        -90 <= lat <= 90
        and -180 <= lon <= 180
        and -10 <= depth <= 800
        and -3 <= mag <= 10
    ):
        raise ValueError("CENC coordinate or magnitude outside range")
    return {
        "id": "cenc:" + str(item["id"])[:100],
        "origin_time": origin.astimezone(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "latitude": lat,
        "longitude": lon,
        "depth_km": depth,
        "magnitude": mag,
        "magnitude_type": "M",
        "place": str(item["location"])[:300],
        "source": "CENC",
        "status": "external",
        "method": "中国地震台网公开目录",
        "provenance": json.dumps(
            {
                "url": "https://www.ceic.ac.cn/",
                "feed": CENC_URL,
                "original_time_beijing": item["time"],
                "original_id": item["id"],
                "magnitude_scale": "not specified in feed",
            },
            ensure_ascii=False,
        ),
        "updated_at": now(),
    }


def sync_cenc():
    payload = get(CENC_URL, timeout=15).json()
    if not isinstance(payload, list) or not payload:
        raise ValueError("中国地震台网目录格式无效或为空")
    records, skipped = [], 0
    for item in payload[:3000]:
        try:
            records.append(cenc_record(item))
        except (KeyError, TypeError, ValueError):
            skipped += 1
    if not records:
        raise ValueError("中国地震台网目录未包含可解析事件")
    with connect() as db:
        for record in records:
            fields = list(record)
            changes = [
                f"{k}=excluded.{k}"
                for k in fields
                if k not in ("id", "source", "status", "method")
            ]
            db.execute(
                f"INSERT INTO events({','.join(fields)}) VALUES ({','.join('?' for _ in fields)}) ON CONFLICT(id) DO UPDATE SET {','.join(changes)} WHERE events.status='external' AND events.version=1",
                list(record.values()),
            )
    return {
        "count": len(records),
        "skipped": skipped,
        "fetched_at": now(),
        "latest_origin": max(r["origin_time"] for r in records),
        "source": "中国地震台网",
        "url": "https://www.ceic.ac.cn/",
    }


def observe_events(baseline=False):
    """Cold-start/imported history/revisions never become new-earthquake alerts."""
    cutoff = datetime.now(timezone.utc).timestamp() - 86400 * 8
    candidates = rows(
        "SELECT * FROM events WHERE status!='rejected' ORDER BY origin_time DESC LIMIT 3000"
    )
    known_sources = {
        e["source"]: bool(state("broadcast:source:" + e["source"])) for e in candidates
    }
    recent_notices = rows(
        "SELECT e.* FROM broadcast_notices n JOIN events e ON e.id=n.event_id ORDER BY n.seq DESC LIMIT 200"
    )
    with connect() as db:
        for event in candidates:
            inserted = db.execute(
                "INSERT OR IGNORE INTO broadcast_seen VALUES (?,?)",
                (event["id"], now()),
            ).rowcount
            if (
                not inserted
                or baseline
                or not known_sources[event["source"]]
                or event["source"] == "manual"
            ):
                continue
            age = datetime.now(timezone.utc).timestamp() - epoch(event["origin_time"])
            # Late arrivals remain in the replay catalog; only recent origins interrupt.
            if not -60 <= age <= 7200 or any(
                same_event(event, other) for other in recent_notices
            ):
                continue
            db.execute(
                "INSERT OR IGNORE INTO broadcast_notices(event_id,received_at) VALUES (?,?)",
                (event["id"], now()),
            )
            recent_notices.append(event)
        # Notices are a bounded delivery log, not the authoritative earthquake archive.
        db.execute(
            "DELETE FROM broadcast_notices WHERE seq < (SELECT COALESCE(MAX(seq),0)-1000 FROM broadcast_notices)"
        )
        db.execute(
            "DELETE FROM broadcast_cache WHERE updated_at < ?",
            (
                datetime.fromtimestamp(cutoff, timezone.utc)
                .isoformat()
                .replace("+00:00", "Z"),
            ),
        )
    for source in known_sources:
        state("broadcast:source:" + source, {"initialized": True})


def presentation_events():
    cutoff = (
        (datetime.now(timezone.utc) - timedelta(days=7))
        .isoformat()
        .replace("+00:00", "Z")
    )
    events = rows(
        "SELECT * FROM events WHERE origin_time>=? AND status!='rejected' ORDER BY origin_time DESC LIMIT 300",
        (cutoff,),
    )
    result = []
    for event in events:
        duplicate = next((e for e in result if same_event(event, e)), None)
        if duplicate:
            duplicate.setdefault("also_reported_by", []).append(event["source"])
            duplicate.setdefault("alternate_reports", []).append(event)
        else:
            result.append(event)
    return result[:100]


def feed(after=None):
    seq = one("SELECT COALESCE(MAX(seq),0) AS seq FROM broadcast_notices")["seq"]
    notices = (
        []
        if after is None
        else rows(
            "SELECT n.seq,n.received_at,e.* FROM broadcast_notices n JOIN events e ON e.id=n.event_id WHERE n.seq>? AND e.status!='rejected' ORDER BY n.seq LIMIT 100",
            (after,),
        )
    )
    # Advance to the last delivered entry, so reconnect bursts cannot skip notices.
    cursor = notices[-1]["seq"] if notices else seq
    return {
        "events": presentation_events(),
        "notices": notices,
        "cursor": cursor,
        "time": now(),
        "poll_seconds": max(30, settings.catalog_poll_seconds),
        "sources": {"USGS": state("source:catalog"), "CENC": state("source:cenc")},
        "delivery": "公开源发布后轮询接收；不等同于地震预警",
    }


def sync_bulletins():
    def run(name, fn):
        try:
            result = {"ok": True, **fn()}
        except Exception as exc:
            old = state("source:" + name) or {}
            result = {
                **old,
                "ok": False,
                "error": str(exc)[:200],
                "attempted_at": now(),
            }
        state("source:" + name, result)

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(
            pool.map(
                lambda pair: run(*pair),
                [("catalog", sync_catalog), ("cenc", sync_cenc)],
            )
        )
    observe_events()


async def run_feeds():
    # Existing events are baseline even after service restart; durable notices survive.
    first_start = not one("SELECT event_id FROM broadcast_seen LIMIT 1")
    await asyncio.to_thread(observe_events, first_start)
    while True:
        from .runtime_settings import refresh

        refresh()
        try:
            await asyncio.to_thread(sync_bulletins)
        except Exception as exc:
            state("broadcast:feed_error", {"error": str(exc)[:200], "at": now()})
        # Also inspect locally detected events every 3 seconds between public polls.
        for _ in range(max(10, settings.catalog_poll_seconds // 3)):
            await asyncio.sleep(3)
            await asyncio.to_thread(observe_events)
