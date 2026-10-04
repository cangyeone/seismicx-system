"""Discover live GEOFON triplets and FDSN coordinates; preview unless --apply."""

import argparse
import json
import socket
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from backend.seedlink4 import line, command, packet
from backend.sources import get, PROVIDERS
from backend.db import connect, init_db, now


def discover(server, freshness=180):
    host, port = server.rsplit(":", 1)
    with socket.create_connection((host, int(port)), timeout=20) as sock:
        sock.settimeout(30)
        sock.sendall(b"HELLO\r\n")
        line(sock)
        line(sock)
        command(sock, "SLPROTO 4.0")
        sock.sendall(b"INFO STREAMS\r\n")
        fmt, _, _, payload = packet(sock)
        if fmt != b"JI":
            raise ValueError("SeedLink INFO STREAMS did not return JSON")
        inventory = json.loads(payload)["station"]
    clock = datetime.now(timezone.utc)
    feeds = [("GEOFON", "*"), ("BGR", "GR,SX"), ("INGV", "MN"), ("INFP", "RO")]

    def fetch(feed):
        provider, networks = feed
        text = get(
            PROVIDERS[provider] + "/fdsnws/station/1/query",
            {
                "network": networks,
                "format": "text",
                "level": "station",
                "endafter": clock.isoformat(),
                "nodata": 204,
            },
            timeout=60,
        ).text
        return provider, text

    metadata = {}
    errors = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [(feed, pool.submit(fetch, feed)) for feed in feeds]
        for feed, future in futures:
            try:
                provider, content = future.result()
                for row in content.splitlines():
                    if not row or row.startswith("#"):
                        continue
                    p = row.split("|")
                    if len(p) < 8:
                        continue

                    def date(text):
                        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
                        return (
                            dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
                        )

                    if date(p[6]) > clock or (p[7] and date(p[7]) <= clock):
                        continue
                    key = p[0] + "_" + p[1]
                    if key in metadata and metadata[key]["epoch"] > p[6]:
                        continue
                    metadata[key] = dict(
                        network=p[0],
                        station=p[1],
                        latitude=float(p[2]),
                        longitude=float(p[3]),
                        elevation_m=float(p[4]),
                        name=p[5],
                        provider=provider,
                        epoch=p[6],
                    )
            except Exception as exc:
                errors.append({"provider": feed[0], "error": str(exc)[:200]})
    selected, missing = [], []
    for station in inventory:
        groups = {}
        for stream in station.get("stream", []):
            p = stream["id"].split("_")
            if len(p) != 4 or p[1] not in ("B", "H") or p[2] != "H":
                continue
            stamp = datetime.strptime(
                stream["end_time"], "%Y/%m/%d %H:%M:%S.%f"
            ).replace(tzinfo=timezone.utc)
            groups.setdefault(tuple(p[:3]), {})[p[3]] = stamp
        choices = []
        for (loc, band, _), components in groups.items():
            if not {"E", "N", "Z"} <= components.keys():
                continue
            age = (clock - min(components[x] for x in ["E", "N", "Z"])).total_seconds()
            if 0 <= age <= freshness:
                choices.append((0 if band == "B" else 1, age, loc, band))
        if not choices:
            continue
        if station["id"] not in metadata:
            missing.append(station["id"])
            continue
        _, _, loc, band = min(choices)
        meta = {k: v for k, v in metadata[station["id"]].items() if k != "epoch"}
        selected.append(
            {**meta, "location": loc, "channel": band + "H?", "enabled": True}
        )
    return selected, missing, errors


def apply(stations):
    init_db()
    with connect() as db:
        for item in stations:
            s = {
                **item,
                "id": f"{item['network']}.{item['station']}.{item['location']}",
                "updated_at": now(),
            }
            db.execute(
                f"INSERT INTO stations({','.join(s)}) VALUES ({','.join('?' for _ in s)}) "
                "ON CONFLICT(id) DO UPDATE SET enabled=1,channel=excluded.channel,provider=excluded.provider",
                list(s.values()),
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default="geofon.gfz.de:18000")
    parser.add_argument("--freshness", type=int, default=180)
    parser.add_argument("--max-stations", type=int, default=256)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    selected, missing, errors = discover(args.server, args.freshness)
    selected = selected[: args.max_stations]
    if args.apply:
        apply(selected)
    print(
        json.dumps(
            {
                "applied": args.apply,
                "selected": len(selected),
                "missing_metadata": missing,
                "provider_errors": errors,
                "stations": selected,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
