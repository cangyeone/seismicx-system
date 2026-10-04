"""Subprocess boundary to the actual pinned seismicx-catalog skill algorithms."""

from .runtime_settings import task_config, accepts_pick, association_args, location_args

import csv
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from .config import settings
from .db import connect, rows, one, now, audit
from .sources import fetch_waveform

SKILL_REVISION = "eebb87878ae27fbc8e33214c38c44fdeff9ba07b"
MODEL_SHA256 = "900dbf785d39b16fcaab5f53d04adddf6796b47f7aec17929abc6e7cfa5b2ddb"


def engine_status():
    script = settings.skill_dir / "scripts/seismicx_catalog.py"
    return {
        "installed": script.is_file(),
        "revision": SKILL_REVISION,
        "picker": "PNSN v3 / Pg,Sg,Pn,Sn",
        "association": "SeismicX Python REAL",
        "location": "SeismicX grid baseline",
        "domain": "区域地震 ≤2000 km；均匀速度基线需区域标定",
        "model_sha256": MODEL_SHA256,
        "inference_backend": settings.inference_backend,
        "npu_model_installed": settings.npu_model.is_file(),
    }


def run_skill(args, work):
    script = settings.skill_dir / "scripts/seismicx_catalog.py"
    if not script.is_file():
        raise RuntimeError(
            "尚未安装编目技能，请运行 python scripts/install_algorithms.py"
        )
    if args[0] == "pick":
        model = settings.skill_dir / "assets/models/pnsn.v3.jit"
        if hashlib.sha256(model.read_bytes()).hexdigest() != MODEL_SHA256:
            raise RuntimeError("PNSN 模型校验失败")
        if settings.inference_backend == "bm1684x":
            from .edge.picker import run_pick

            with (work / "commands.jsonl").open("a") as handle:
                handle.write(json.dumps(["BM1684X", *map(str, args)]) + "\n")
            run_pick(args)
            return
    command = [sys.executable, str(script), *map(str, args)]
    with (work / "commands.jsonl").open("a") as handle:
        handle.write(json.dumps(command) + "\n")
    import os

    threads = str(args[args.index("--real-jobs") + 1]) if "--real-jobs" in args else "2"
    environment = {
        **os.environ,
        "OMP_NUM_THREADS": "2",
        "MKL_NUM_THREADS": "2",
        "NUMBA_NUM_THREADS": threads,
    }
    with (work / "engine.log").open("a") as log:
        try:
            result = subprocess.run(
                command, stdout=log, stderr=log, timeout=900, env=environment
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("算法超过 15 分钟限额，已终止；请缩短时间窗") from exc
    if result.returncode:
        tail = (work / "engine.log").read_text(errors="replace")[-2000:]
        raise RuntimeError(f"{args[0]} 失败: {tail}")


def write_csv(path, data, fields=None):
    with Path(path).open("w", newline="") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=fields or list(data[0]), extrasaction="ignore"
        )
        writer.writeheader()
        writer.writerows(data)


def read_csv(path):
    with Path(path).open() as handle:
        return list(csv.DictReader(handle))


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (ValueError, TypeError):
        return None


def station_export(stations):
    return [{**s, "station_id": s["id"]} for s in stations]


def velocity_file(work, data):
    path = work / "velocity.csv"
    write_csv(path, [{"depth_km": 0, "vp_km_s": data["vp"], "vs_km_s": data["vs"]}])
    return path


def detect(job_id, data, progress):
    data = task_config(data)
    work = settings.data_dir / "runs" / job_id
    wave_dir = work / "waveforms"
    wave_dir.mkdir(parents=True, exist_ok=True)
    stations = [
        one("SELECT * FROM stations WHERE id=?", (sid,))
        for sid in dict.fromkeys(data["station_ids"])
    ]
    if not all(stations):
        raise ValueError("台站不存在")
    # Homogeneous REAL cannot associate a worldwide network as one regional array.
    from obspy.geodetics import gps2dist_azimuth

    if any(
        gps2dist_azimuth(a["latitude"], a["longitude"], b["latitude"], b["longitude"])[
            0
        ]
        > 2_000_000
        for a in stations
        for b in stations
    ):
        raise ValueError(
            "PNSN/REAL 区域流程要求所选台网跨度不超过 2000 km；全球台网请分区处理"
        )
    write_csv(work / "stations.csv", station_export(stations))
    velocity = velocity_file(work, data)
    (work / "manifest.json").write_text(
        json.dumps(
            {
                "request": data,
                "skill_revision": SKILL_REVISION,
                "model_sha256": MODEL_SHA256,
                "input_units": "counts",
                "inference_backend": settings.inference_backend,
                "npu_model_sha256": hashlib.sha256(
                    settings.npu_model.read_bytes()
                ).hexdigest()
                if settings.inference_backend == "bm1684x"
                and settings.npu_model.is_file()
                else None,
                "sample_rate": 100,
                "components": ["E", "N", "Z"],
                "filter": "none",
                "status": "candidate baseline",
            },
            indent=2,
        )
    )
    if data.get("_precomputed_picks"):
        import shutil

        selected = set(data["station_ids"])
        picks = [
            p
            for p in read_csv(data["_precomputed_picks"])
            if f"{p['network']}.{p['station']}.{p['location']}" in selected
        ]
        for pick in picks:
            origin = Path(pick["waveform_path"])
            target = wave_dir / origin.name
            if not target.exists():
                shutil.copy2(origin, target)
                from obspy import read
                from .sources import register_waveform

                register_waveform(
                    target,
                    read(str(target)),
                    f"{pick['network']}.{pick['station']}.{pick['location']}",
                    "edge-event",
                )
            pick["waveform_path"] = str(target)
        write_csv(work / "picks.csv", picks)
        failures = []
        successful = list(selected)
    else:
        progress("下载真实三分量波形")
        failures, successful = [], []
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {
                pool.submit(
                    fetch_waveform, station, data["start"], data["end"], wave_dir
                ): station
                for station in stations
            }
            for future in as_completed(futures):
                station = futures[future]
                try:
                    future.result()
                    successful.append(station["id"])
                except Exception as exc:
                    failures.append({"station": station["id"], "error": str(exc)[:400]})
        (work / "download-errors.json").write_text(json.dumps(failures, indent=2))
        if not successful:
            raise ValueError(
                "全部台站下载失败：" + json.dumps(failures, ensure_ascii=False)
            )
        run_skill(
            [
                "scan",
                "-w",
                wave_dir,
                "-o",
                work / "scan.csv",
                "--errors",
                work / "scan-errors.csv",
            ],
            work,
        )
        progress("PNSN v3 震相检测 · 未滤波三分量")
        run_skill(
            [
                "pick",
                "-w",
                wave_dir,
                "-o",
                work / "picks.csv",
                "--picker",
                "torchscript-pnsn",
                "--model",
                "pnsn-v3",
                "--phases",
                "Pg,Sg,Pn,Sn",
            ],
            work,
        )
    picks = read_csv(work / "picks.csv")
    import shutil

    shutil.copy2(work / "picks.csv", work / "raw-picks.csv")
    fields = list(picks[0]) if picks else None
    picks = [p for p in picks if accepts_pick(p, data)]
    if fields:
        write_csv(work / "picks.csv", picks, fields)
    if not picks:
        return {
            "events": [],
            "picks": 0,
            "failed_stations": failures,
            "message": "模型未检测到震相，未生成事件",
            "run": job_id,
        }
    if len(successful) < 3:
        return {
            "events": [],
            "picks": len(picks),
            "failed_stations": failures,
            "message": "有效台站不足 3 个，保存拾取但不生成定位目录",
            "run": job_id,
        }
    progress("Python REAL 多台站关联")
    run_skill(
        [
            "associate",
            "--method",
            "real",
            "-p",
            work / "picks.csv",
            "-s",
            work / "stations.csv",
            "-o",
            work / "associated.csv",
            "--assignments",
            work / "assignments.csv",
            "--associated-picks",
            work / "associated-picks.csv",
            "--workdir",
            work / "real",
            "--real-V",
            f"{data['vp']}/{data['vs']}",
            "--real-min-score",
            data["min_score"],
            *association_args(data),
        ],
        work,
    )
    associated = read_csv(work / "associated.csv")
    if not associated:
        return {
            "events": [],
            "picks": len(picks),
            "message": "拾取已保存，未通过多台站关联门槛",
            "failed_stations": failures,
            "run": job_id,
        }
    progress("网格定位与质量检查")
    run_skill(
        [
            "locate",
            "--method",
            "grid",
            "-p",
            work / "associated-picks.csv",
            "-s",
            work / "stations.csv",
            "-v",
            velocity,
            "-o",
            work / "located.csv",
            *location_args(data),
        ],
        work,
    )
    located = read_csv(work / "located.csv")
    associated_picks = read_csv(work / "associated-picks.csv")
    lookup = {e["event_id"]: e for e in associated}
    ids = []
    with connect() as db:
        for event in located:
            original_id = event["event_id"]
            # Repeat the same window without duplicating detections.
            stable = f"{data['start']}|{sorted(successful)}|{event['origin_time']}"
            eid = "sx:" + hashlib.sha256(stable.encode()).hexdigest()[:20]
            group = [p for p in associated_picks if p["event_id"] == original_id]
            # Overlapping continuous windows must not create duplicate events.
            # Require >=3 matching station/phase arrivals, not just nearby epicenters.
            from datetime import datetime

            neighbors = db.execute(
                "SELECT id FROM events WHERE source='SeismicX' AND ABS((julianday(origin_time)-julianday(?))*86400)<10",
                (event["origin_time"],),
            ).fetchall()
            for neighbor in neighbors:
                old_picks = db.execute(
                    "SELECT * FROM picks WHERE event_id=?", (neighbor["id"],)
                ).fetchall()
                matching_stations = set()
                for p in group:
                    for old in old_picks:
                        same_station = old["station_id"].split(".")[:2] == [
                            p["network"],
                            p["station"],
                        ]
                        delta = abs(
                            (
                                datetime.fromisoformat(
                                    old["time"].replace("Z", "+00:00")
                                )
                                - datetime.fromisoformat(
                                    p["time"].replace("Z", "+00:00")
                                )
                            ).total_seconds()
                        )
                        if same_station and old["phase"] == p["phase"] and delta < 0.5:
                            matching_stations.add(old["station_id"])
                if len(matching_stations) >= 3:
                    eid = neighbor["id"]
                    break
            qc = []
            if (number(event.get("rms")) or 0) > 1:
                qc.append("RMS > 1 s")
            if number(event.get("depth_km")) in (
                data["_configuration"]["config"]["location"]["min_depth"],
                data["_configuration"]["config"]["location"]["max_depth"],
            ):
                qc.append("深度位于搜索边界")
            gap = number(lookup.get(original_id, {}).get("azimuth_gap_deg"))
            if gap is not None and gap > 180:
                qc.append("方位角空缺 > 180°")
            provenance = {
                "run": job_id,
                "skill_revision": SKILL_REVISION,
                "model_sha256": MODEL_SHA256,
                "velocity": data["velocity_name"],
                "qc": qc,
                "configuration": data["_configuration"],
                "magnitude": "未计算：需区域响应与标定",
                "reference_event": data.get("event_id"),
            }
            inserted = db.execute(
                """INSERT OR IGNORE INTO events(id,origin_time,latitude,longitude,depth_km,
                source,status,rms,n_picks,azimuth_gap,method,velocity_model,place,provenance,updated_at)
                VALUES (?,?,?,?,?,'SeismicX','candidate',?,?,?,?,?,?,?,?)""",
                (
                    eid,
                    event["origin_time"],
                    float(event["latitude"]),
                    float(event["longitude"]),
                    float(event["depth_km"]),
                    number(event.get("rms")),
                    len(group),
                    gap,
                    "PNSN v3 → Python REAL → grid",
                    data["velocity_name"],
                    "自动检测 · 区域候选事件",
                    json.dumps(provenance, ensure_ascii=False),
                    now(),
                ),
            ).rowcount
            if inserted:
                for pick in group:
                    # Keep exact network/station/location in picks, matching downloaded data.
                    sid = next(
                        (
                            s["id"]
                            for s in stations
                            if s["network"] == pick["network"]
                            and s["station"] == pick["station"]
                            and (not s["location"] or s["location"] == pick["location"])
                        ),
                        "",
                    )
                    db.execute(
                        """INSERT INTO picks(id,event_id,station_id,phase,time,score,method,waveform_path)
                        VALUES (?,?,?,?,?,?,?,?)""",
                        (
                            eid + ":" + pick["pick_id"],
                            eid,
                            sid,
                            pick["phase"],
                            pick["time"],
                            number(pick.get("score")),
                            pick["picker"],
                            pick["waveform_path"],
                        ),
                    )
            ids.append(eid)
    return {
        "events": ids,
        "picks": len(picks),
        "failed_stations": failures,
        "run": job_id,
        "quality": "候选目录，需人工复核与区域速度标定",
    }


def relocate(job_id, data, progress):
    data = task_config(data)
    event = one("SELECT * FROM events WHERE id=?", (data["event_id"],))
    picks = rows("SELECT * FROM picks WHERE event_id=?", (event["id"],))
    if (
        len(picks) < data["_configuration"]["config"]["location"]["min_picks"]
        or len({p["station_id"] for p in picks}) < 3
    ):
        raise ValueError("定位至少需要 4 个震相和 3 个不同台站")
    work = settings.data_dir / "runs" / job_id
    work.mkdir(parents=True, exist_ok=True)
    stations = [
        one("SELECT * FROM stations WHERE id=?", (sid,))
        for sid in {p["station_id"] for p in picks}
    ]
    station_lookup = {s["id"]: s for s in stations}
    from obspy.geodetics import gps2dist_azimuth

    if any(
        gps2dist_azimuth(a["latitude"], a["longitude"], b["latitude"], b["longitude"])[
            0
        ]
        > 2_000_000
        for a in stations
        for b in stations
    ):
        raise ValueError("此定位器仅支持区域台网，请将跨度限制在 2000 km 内")
    export = [
        {
            **p,
            "pick_id": p["id"],
            "network": station_lookup[p["station_id"]]["network"],
            "station": station_lookup[p["station_id"]]["station"],
            "location": station_lookup[p["station_id"]]["location"],
        }
        for p in picks
    ]
    write_csv(work / "picks.csv", export)
    write_csv(work / "stations.csv", station_export(stations))
    velocity = velocity_file(work, data)
    (work / "manifest.json").write_text(
        json.dumps({"request": data, "skill_revision": SKILL_REVISION}, indent=2)
    )
    progress("使用人工震相重新定位")
    run_skill(
        [
            "locate",
            "--method",
            "grid",
            "-p",
            work / "picks.csv",
            "-s",
            work / "stations.csv",
            "-v",
            velocity,
            "-o",
            work / "located.csv",
            *location_args(data),
        ],
        work,
    )
    result = read_csv(work / "located.csv")
    if not result:
        raise ValueError("定位未产生有效结果")
    result = result[0]
    with connect() as db:
        current = dict(
            db.execute("SELECT * FROM events WHERE id=?", (event["id"],)).fetchone()
        )
        if current["version"] != event["version"]:
            raise ValueError("计算期间事件或震相已被修改，请重新定位")
        updated = {
            **current,
            **{
                k: float(result[k])
                for k in ("latitude", "longitude", "depth_km", "rms")
            },
            "origin_time": result["origin_time"],
            "status": "candidate",
            "version": current["version"] + 1,
            "method": "SeismicX grid / current picks",
            "velocity_model": data["velocity_name"],
            "updated_at": now(),
        }
        azimuths = sorted(
            gps2dist_azimuth(
                updated["latitude"], updated["longitude"], s["latitude"], s["longitude"]
            )[1]
            for s in stations
        )
        updated["azimuth_gap"] = round(
            max(b - a for a, b in zip(azimuths, azimuths[1:] + [azimuths[0] + 360])), 2
        )
        provenance = json.loads(current["provenance"] or "{}")
        provenance.update(
            relocation_run=job_id,
            configuration=data["_configuration"],
            velocity=data["velocity_name"],
            qc=[
                label
                for condition, label in [
                    (updated["rms"] > 1, "RMS > 1 s"),
                    (
                        updated["depth_km"]
                        <= data["_configuration"]["config"]["location"]["min_depth"]
                        or updated["depth_km"]
                        >= data["_configuration"]["config"]["location"]["max_depth"],
                        "深度位于搜索边界",
                    ),
                    (updated["azimuth_gap"] > 180, "方位角空缺 > 180°"),
                ]
                if condition
            ],
        )
        updated["provenance"] = json.dumps(provenance, ensure_ascii=False)
        db.execute(
            """UPDATE events SET origin_time=?,latitude=?,longitude=?,depth_km=?,rms=?,status='candidate',
            method=?,velocity_model=?,version=version+1,updated_at=?,azimuth_gap=?,provenance=? WHERE id=?""",
            (
                updated["origin_time"],
                updated["latitude"],
                updated["longitude"],
                updated["depth_km"],
                updated["rms"],
                updated["method"],
                data["velocity_name"],
                updated["updated_at"],
                updated["azimuth_gap"],
                updated["provenance"],
                event["id"],
            ),
        )
        audit(
            db,
            "event",
            event["id"],
            current,
            updated,
            "根据当前震相重新定位；" + data["velocity_name"],
        )
    return {"event": event["id"], "location": updated, "run": job_id}


def magnitude(job_id, data, progress):
    """Calibrated skill ML only: response failures never fall back to raw counts."""
    import io
    from obspy import Inventory, read_inventory
    from .sources import get, PROVIDERS

    event = one("SELECT * FROM events WHERE id=?", (data["event_id"],))
    picks = rows("SELECT * FROM picks WHERE event_id=?", (event["id"],))
    if not any(p["phase"].startswith("S") for p in picks):
        raise ValueError("标定 ML 需要 S 震相及对应的水平分量")
    work = settings.data_dir / "runs" / job_id
    work.mkdir(parents=True, exist_ok=True)
    inventory = Inventory([], source="FDSN responses")
    stations = [
        one("SELECT * FROM stations WHERE id=?", (sid,))
        for sid in {p["station_id"] for p in picks}
    ]
    from datetime import datetime, timedelta

    origin = datetime.fromisoformat(event["origin_time"].replace("Z", "+00:00"))
    start = (origin - timedelta(seconds=30)).isoformat()
    end = (origin + timedelta(seconds=300)).isoformat()
    export = []
    progress("获取事件时段 StationXML 仪器响应")
    for s in stations:
        response = get(
            PROVIDERS[s["provider"]] + "/fdsnws/station/1/query",
            {
                "net": s["network"],
                "sta": s["station"],
                "loc": s["location"] or "*",
                "cha": s["channel"],
                "start": start,
                "end": end,
                "level": "response",
                "format": "xml",
            },
        )
        inventory += read_inventory(io.BytesIO(response.content))
        path, _ = fetch_waveform(s, start, end, work / "waveforms")
        for p in picks:
            if p["station_id"] == s["id"]:
                export.append(
                    {
                        **p,
                        "pick_id": p["id"],
                        "network": s["network"],
                        "station": s["station"],
                        "location": s["location"],
                        "waveform_path": str(path),
                    }
                )
    inventory.write(str(work / "stations.xml"), format="STATIONXML")
    write_csv(work / "stations.csv", station_export(stations))
    write_csv(work / "picks.csv", export)
    write_csv(work / "events.csv", [{**event, "event_id": event["id"]}])
    progress("SeismicX seedtools DD1 响应校正与 ML 计算")
    run_skill(
        [
            "magnitude-ml",
            "-e",
            work / "events.csv",
            "-p",
            work / "picks.csv",
            "-s",
            work / "stations.csv",
            "--inventory",
            work / "stations.xml",
            "--region",
            data["region"],
            "-o",
            work / "events-ml.csv",
            "--station-output",
            work / "station-ml.csv",
        ],
        work,
    )
    station_results = read_csv(work / "station-ml.csv")
    calibrated = [
        r
        for r in station_results
        if r.get("quality") == "seedtools_response_simulated_um"
        and number(r.get("ml")) is not None
    ]
    if len(calibrated) < 2:
        raise ValueError("有效响应标定台站少于 2 个，保留原震级；查看 station-ml.csv")
    from statistics import median

    ml = median(float(r["ml"]) for r in calibrated)
    if not -3 <= ml <= 10:
        raise ValueError("ML 超出合理范围，未写入事件")
    with connect() as db:
        current = dict(
            db.execute("SELECT * FROM events WHERE id=?", (event["id"],)).fetchone()
        )
        if current["version"] != event["version"]:
            raise ValueError("计算期间事件已修改，请重试")
        provenance = json.loads(current["provenance"])
        provenance["magnitude"] = {
            "method": "seedtools-dd1",
            "region": data["region"],
            "stations": len(calibrated),
            "run": job_id,
            "quality": "response calibrated; regional curve and saturation require review",
        }
        db.execute(
            "UPDATE events SET magnitude=?,magnitude_type='ML',status='candidate',version=version+1,provenance=?,updated_at=? WHERE id=?",
            (ml, json.dumps(provenance), now(), event["id"]),
        )
        audit(
            db,
            "event",
            event["id"],
            current,
            {"magnitude": ml, "region": data["region"], "run": job_id},
            "技能响应标定 ML；区域曲线需复核",
        )
    return {
        "event": event["id"],
        "magnitude": ml,
        "magnitude_type": "ML",
        "stations": calibrated,
        "run": job_id,
    }
