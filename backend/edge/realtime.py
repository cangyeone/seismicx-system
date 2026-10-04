"""Continuous shared NPU picking, then regional skill association/location jobs."""

import hashlib
import json
import shutil
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from ..config import settings
from ..db import init_db, connect, rows, state, now
from ..algorithms import run_skill, read_csv
from ..worker import enqueue


def cached_window(station, start, end, destination):
    from obspy import read, Stream, UTCDateTime

    files = rows(
        "SELECT path FROM waveform_files WHERE station_id=? AND end>=? AND start<=? ORDER BY start LIMIT 100",
        (station["id"], start, end),
    )
    stream = Stream()
    for item in files:
        path = Path(item["path"])
        if path.is_file():
            stream += read(
                str(path),
                format="MSEED",
                starttime=UTCDateTime(start),
                endtime=UTCDateTime(end),
            )
    if not stream:
        raise ValueError("尚未收到所选时间窗采样")
    stream.merge(method=1, fill_value=None)
    stream.trim(UTCDateTime(start), UTCDateTime(end))
    # Reject incomplete/gapped triplets; zero-filled holes are not live evidence.
    from .picker import skill_module

    skill = skill_module()
    components = skill.select_three_components(stream)
    if not components:
        raise ValueError("实时三分量尚不完整")
    import numpy as np

    common_start = max(t.stats.starttime for _, t in components)
    common_end = min(t.stats.endtime for _, t in components)
    if common_end - common_start < min(100, settings.edge_window_seconds * 0.6):
        raise ValueError("共同连续波形不足100秒")
    stream = Stream([t.copy().trim(common_start, common_end) for _, t in components])
    if any(
        np.ma.isMaskedArray(t.data) and np.ma.getmaskarray(t.data).any() for t in stream
    ):
        raise ValueError("时间窗存在数据缺口，等待连续采样")
    path = destination / (station["id"] + ".mseed")
    stream.write(str(path), format="MSEED")
    return path


def regional_groups(stations):
    # Overlap grids so boundary stations can participate in neighboring groups.
    groups = {}
    for shift in (0, 2.5):
        for s in stations:
            key = (
                shift,
                int((s["latitude"] + 90 + shift) // 5),
                int((s["longitude"] + 180 + shift) // 5),
            )
            groups.setdefault(key, []).append(s["id"])
    return [
        sorted(ids)[:32]
        for ids in {tuple(sorted(g)) for g in groups.values()}
        if len(ids) >= 3
    ]


def cleanup_completed_edge_inputs(cutoff):
    """Expire automatic no-event input copies; preserve event and manual evidence."""
    jobs = rows(
        "SELECT id,result FROM jobs WHERE status='completed' AND kind='detect' "
        "AND payload LIKE '%_precomputed_picks%' AND julianday(updated_at)<julianday(?)",
        (datetime.fromtimestamp(cutoff, timezone.utc).isoformat(),),
    )
    for job in jobs:
        result = json.loads(job["result"] or "{}")
        if "events" not in result or result["events"]:
            continue
        work = settings.data_dir / "runs" / job["id"]
        waves = work / "waveforms"
        if not waves.is_dir():
            continue
        for path in waves.glob("*.mseed"):
            if rows("SELECT id FROM picks WHERE waveform_path=? LIMIT 1", (str(path),)):
                continue
            with connect() as db:
                db.execute("DELETE FROM waveform_files WHERE path=?", (str(path),))
            path.unlink(missing_ok=True)
        if not list(waves.iterdir()):
            waves.rmdir()
            (work / "inputs-expired.json").write_text(
                json.dumps(
                    {
                        "expired_at": now(),
                        "reason": "automatic window produced no catalog event",
                    }
                )
            )


def cleanup():
    cutoff = time.time() - settings.edge_run_retention_hours * 3600
    cleanup_completed_edge_inputs(cutoff)
    for path in (settings.data_dir / "edge-runs").glob("*"):
        if path.is_dir() and path.stat().st_mtime < cutoff:
            pending = rows(
                "SELECT payload FROM jobs WHERE status IN ('queued','running') AND payload LIKE ?",
                ("%" + str(path) + "%",),
            )
            if not pending:
                shutil.rmtree(path)
    with connect() as db:
        db.execute(
            "DELETE FROM realtime_picks WHERE julianday(time)<julianday('now','-7 days')"
        )


def cycle():
    from ..runtime_settings import refresh, task_config, accepts_pick

    configuration = refresh()
    parameters = task_config({"_configuration": configuration})
    started = time.perf_counter()
    end = datetime.now(timezone.utc) - timedelta(
        seconds=settings.edge_input_delay_seconds
    )
    start = end - timedelta(seconds=settings.edge_window_seconds)
    start_text = start.isoformat().replace("+00:00", "Z")
    end_text = end.isoformat().replace("+00:00", "Z")
    clock = datetime.now(timezone.utc)
    cutoff = (
        (clock - timedelta(seconds=settings.edge_max_input_lag_seconds))
        .isoformat()
        .replace("+00:00", "Z")
    )
    subscriptions = rows("SELECT id,last_sample FROM stations WHERE enabled=1")
    lags = sorted(
        (
            clock - datetime.fromisoformat(s["last_sample"].replace("Z", "+00:00"))
        ).total_seconds()
        for s in subscriptions
        if s["last_sample"]
    )
    stations = rows(
        "SELECT * FROM stations WHERE enabled=1 AND last_sample>=? ORDER BY id LIMIT ?",
        (cutoff, settings.edge_max_stations),
    )
    run = "edge-" + end.strftime("%Y%m%dT%H%M%S")
    work = settings.data_dir / "edge-runs" / run
    waves = work / "waveforms"
    waves.mkdir(parents=True, exist_ok=True)
    ready = []
    errors = []
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from .picker import skill_module

    skill_module()  # initialize the shared module before concurrent reads
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {
            pool.submit(cached_window, station, start_text, end_text, waves): station
            for station in stations
        }
        for future in as_completed(pending):
            station = pending[future]
            try:
                future.result()
                ready.append(station)
            except Exception as exc:
                errors.append({"station": station["id"], "error": str(exc)[:160]})
    ready.sort(key=lambda s: s["id"])
    previous = state("edge") or {}
    status = {
        "heartbeat": now(),
        "run": run,
        "subscribed": len(subscriptions),
        "input_lag_median_seconds": round(__import__("statistics").median(lags), 1)
        if lags
        else None,
        "input_lag_p95_seconds": round(
            lags[min(len(lags) - 1, int(len(lags) * 0.95))], 1
        )
        if lags
        else None,
        "stale_stations": len(subscriptions) - len(stations),
        "max_input_lag_seconds": settings.edge_max_input_lag_seconds,
        "online_seen": len(stations),
        "processed_stations": len(ready),
        "window_start": start_text,
        "window_end": end_text,
        "interval_seconds": settings.edge_interval_seconds,
        "errors": errors[:12],
        "cycles": previous.get("cycles", 0) + 1,
    }
    if ready:
        run_skill(
            [
                "pick",
                "-w",
                waves,
                "-o",
                work / "picks.csv",
                "--errors",
                work / "pick-errors.csv",
                "--phases",
                "Pg,Sg,Pn,Sn",
            ],
            work,
        )
        picks = read_csv(work / "picks.csv")
        with connect() as db:
            for p in picks:
                sid = f"{p['network']}.{p['station']}.{p['location']}"
                # Across windows, small numerical shifts must not multiply one arrival.
                duplicate = db.execute(
                    "SELECT 1 FROM realtime_picks WHERE station_id=? AND phase=? AND ABS((julianday(time)-julianday(?))*86400)<1 LIMIT 1",
                    (sid, p["phase"], p["time"]),
                ).fetchone()
                if not duplicate:
                    key = hashlib.sha256(
                        (sid + p["phase"] + p["time"]).encode()
                    ).hexdigest()[:24]
                    db.execute(
                        "INSERT OR IGNORE INTO realtime_picks VALUES (?,?,?,?,?,?,?)",
                        (
                            key,
                            sid,
                            p["phase"],
                            p["time"],
                            float(p["score"]),
                            run,
                            now(),
                        ),
                    )
        jobs = []
        for ids in regional_groups(ready):
            if (
                len(
                    [
                        p
                        for p in picks
                        if f"{p['network']}.{p['station']}.{p['location']}" in ids
                        and accepts_pick(p, parameters)
                    ]
                )
                < configuration["config"]["association"]["min_total"]
            ):
                continue
            jobs.append(
                enqueue(
                    "detect",
                    {
                        "start": start_text,
                        "end": end_text,
                        "station_ids": ids,
                        **parameters,
                        "_precomputed_picks": str(work / "picks.csv"),
                    },
                )
            )
        status.update(picks=len(picks), association_jobs=len(jobs), npu=state("npu"))
    else:
        status.update(picks=0, association_jobs=0)
    status["configuration_revision"] = configuration["revision"]
    status["cycle_seconds"] = time.perf_counter() - started
    status["lagging"] = status["cycle_seconds"] > settings.edge_interval_seconds
    status["heartbeat"] = now()
    state("edge", status)
    (work / "manifest.json").write_text(
        json.dumps(status, ensure_ascii=False, indent=2)
    )
    cleanup()
    return status


def main():
    import fcntl

    init_db()
    lock = (settings.data_dir / "edge-worker.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if settings.inference_backend != "bm1684x":
        raise RuntimeError("Continuous edge worker requires BM1684X backend")
    while True:
        started = time.monotonic()
        try:
            cycle()
        except Exception as exc:
            previous = state("edge") or {}
            state("edge", {**previous, "heartbeat": now(), "error": str(exc)[:500]})
        time.sleep(
            max(1, settings.edge_interval_seconds - (time.monotonic() - started))
        )


if __name__ == "__main__":
    main()
