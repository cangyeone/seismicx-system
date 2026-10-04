"""Bounded public-data smoke test, no mock waveforms and no production claims."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import json
import uuid
from backend.db import init_db, connect, now
from backend.sources import get, PROVIDERS, sync_all
from backend.algorithms import detect


def main():
    init_db()
    report = {"sources": sync_all(), "runs": []}
    response = get(
        PROVIDERS["SCEDC"] + "/fdsnws/station/1/query",
        {
            "latitude": 35.77,
            "longitude": -117.6,
            "maxradius": 0.8,
            "level": "channel",
            "format": "text",
            "starttime": "2019-07-06T03:19:00",
            "endtime": "2019-07-06T03:24:00",
            "channel": "HH?",
        },
    )
    selected = {"CLC", "CCC", "LRL", "JRC2", "MPM", "SLA"}
    seen = set()
    with connect() as db:
        for line in response.text.splitlines():
            if line.startswith("#"):
                continue
            p = line.split("|")
            if len(p) < 8 or p[1] not in selected or p[1] in seen:
                continue
            seen.add(p[1])
            sid = f"{p[0]}.{p[1]}.{p[2]}"
            db.execute(
                """INSERT OR IGNORE INTO stations(id,network,station,location,channel,latitude,
                longitude,elevation_m,name,provider,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    sid,
                    p[0],
                    p[1],
                    p[2],
                    "HH?",
                    float(p[4]),
                    float(p[5]),
                    float(p[6]),
                    "SCEDC " + p[1],
                    "SCEDC",
                    now(),
                ),
            )
    for score in (0.35, 0.12):
        run_id = "smoke-" + uuid.uuid4().hex[:12]
        result = detect(
            run_id,
            {
                "start": "2019-07-06T03:19:20Z",
                "end": "2019-07-06T03:22:20Z",
                "station_ids": [f"CI.{s}." for s in sorted(seen)],
                "vp": 6.2,
                "vs": 3.5,
                "min_score": score,
                "velocity_name": "homogeneous-regional-smoke-test",
            },
            print,
        )
        report["runs"].append({"threshold": score, **result})
    target = Path("runtime/real-smoke-report.json")
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(target.resolve())


if __name__ == "__main__":
    main()
