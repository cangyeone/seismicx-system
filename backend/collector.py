"""Standalone FDSN/SeedLink ingestion; bounded memory, disk limits, live telemetry."""

import argparse
import queue
import threading
import time
from datetime import datetime, timedelta, timezone
from .config import settings
from .db import init_db, rows, connect, state, now
from .sources import fetch_waveform, register_waveform


def storage_guard():
    retention = (
        settings.waveform_retention_hours * 3600
        if settings.edge_enabled
        else settings.waveform_retention_days * 86400
    )
    cutoff = time.time() - retention
    root = settings.data_dir / "waveforms"
    root.mkdir(exist_ok=True)
    # Only expire collector cache; scientific run inputs remain immutable.
    for path in root.glob("*.mseed*"):
        if path.stat().st_mtime < cutoff:
            with connect() as db:
                db.execute("DELETE FROM waveform_files WHERE path=?", (str(path),))
                db.execute("DELETE FROM archive_offsets WHERE path=?", (str(path),))
            path.unlink(missing_ok=True)
    used = sum(p.stat().st_size for p in settings.data_dir.rglob("*.mseed*"))
    if used >= settings.waveform_disk_limit_gb * 1024**3:
        raise RuntimeError("波形存储达到容量上限，采集暂停；请归档 run 数据或增加容量")


def telemetry(**extra):
    return state("collector", {"heartbeat": now(), **extra})


def poll(args):
    from concurrent.futures import ThreadPoolExecutor, as_completed

    while True:
        end = datetime.now(timezone.utc) - timedelta(seconds=args.delay)
        start = end - timedelta(seconds=args.window)
        stations = rows("SELECT * FROM stations WHERE enabled=1")
        received = 0
        errors = []
        successful = []
        try:
            storage_guard()
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                pending = {
                    pool.submit(
                        fetch_waveform,
                        s,
                        start.isoformat(),
                        end.isoformat(),
                        None,
                        True,
                    ): s
                    for s in stations
                }
                for future in as_completed(pending):
                    s = pending[future]
                    try:
                        future.result()
                        received += 1
                        successful.append(s)
                    except Exception as exc:
                        errors.append({"station": s["id"], "error": str(exc)[:180]})
                        with connect() as db:
                            db.execute(
                                "UPDATE stations SET error=? WHERE id=?",
                                (str(exc)[:300], s["id"]),
                            )
            if args.auto_catalog and len(successful) >= 3:
                from .worker import enqueue

                # Explicit regional partitioning; arrays near a tile boundary should
                # be deployed as reviewed station shards, not claimed complete globally.
                groups = {}
                for s in successful:
                    key = (
                        int((s["latitude"] + 90) // 5),
                        int((s["longitude"] + 180) // 5),
                    )
                    groups.setdefault(key, []).append(s["id"])
                for ids in groups.values():
                    if len(ids) >= 3:
                        enqueue(
                            "detect",
                            {
                                "start": start.isoformat(),
                                "end": end.isoformat(),
                                "station_ids": ids[:32],
                                **({"vp": args.vp} if args.vp is not None else {}),
                                **({"vs": args.vs} if args.vs is not None else {}),
                            },
                        )
            telemetry(
                mode="fdsn",
                subscribed=len(stations),
                received=received,
                errors=errors[:20],
                auto_catalog=args.auto_catalog,
            )
        except Exception as exc:
            telemetry(mode="fdsn", error=str(exc))
        time.sleep(args.interval)


def seedlink3(args):
    from obspy.clients.seedlink.easyseedlink import EasySeedLinkClient
    from obspy import Stream

    packets = queue.Queue(maxsize=settings.queue_capacity)
    stats = {"received": 0, "dropped": 0, "errors": []}

    def writer():
        checked = 0.0
        while True:
            station, trace = packets.get()
            try:
                if time.monotonic() - checked > 30:
                    storage_guard()
                    checked = time.monotonic()
                from io import BytesIO

                bucket = int(float(trace.stats.starttime) // 300)
                path = settings.data_dir / "waveforms" / f"{trace.id}-{bucket}.mseed"
                stream = Stream([trace])
                buffer = BytesIO()
                stream.write(buffer, format="MSEED")
                with path.open("ab") as output:
                    output.write(buffer.getvalue())
                register_waveform(path, stream, station["id"], "SeedLink", True)
                stats["received"] += 1
            except Exception as exc:
                stats["errors"] = [str(exc)]
            finally:
                packets.task_done()

    threading.Thread(target=writer, daemon=True).start()
    backoff = 2
    while True:
        stations = rows("SELECT * FROM stations WHERE enabled=1")
        if not stations:
            telemetry(mode="seedlink", subscribed=0, **stats)
            time.sleep(5)
            continue
        mapping = {(s["network"], s["station"]): s for s in stations}

        class Client(EasySeedLinkClient):
            def on_data(self, trace):
                station = mapping.get((trace.stats.network, trace.stats.station))
                if station:
                    try:
                        packets.put_nowait((station, trace.copy()))
                    except queue.Full:
                        stats["dropped"] += 1

        client = None
        finished = threading.Event()
        try:
            client = Client(args.server, autoconnect=False)
            client.conn.timeout = 15
            client.conn.netto = 30
            client.connect()
            for s in stations:
                client.select_stream(
                    s["network"],
                    s["station"],
                    (s["location"] or "??") + s["channel"].replace("*", "?"),
                )

            def monitor():
                while not finished.wait(5):
                    telemetry(
                        mode="seedlink",
                        server=args.server,
                        subscribed=len(stations),
                        queue=packets.qsize(),
                        **stats,
                    )
                    current = rows("SELECT * FROM stations WHERE enabled=1")
                    if [(s["id"], s["channel"]) for s in current] != [
                        (s["id"], s["channel"]) for s in stations
                    ]:
                        client.close()
                        return

            threading.Thread(target=monitor, daemon=True).start()
            client.run()
            backoff = 2
        except Exception as exc:
            telemetry(mode="seedlink", error=str(exc), reconnect_in=backoff, **stats)
        finally:
            finished.set()
            if client:
                try:
                    client.close()
                except Exception:
                    pass
        time.sleep(backoff)
        backoff = min(60, backoff * 2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["fdsn", "seedlink"], default="fdsn")
    parser.add_argument("--server", default=settings.seedlink_server)
    parser.add_argument("--shards", type=int, default=settings.seedlink_shards)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--window", type=int, default=300)
    parser.add_argument("--delay", type=int, default=60)
    parser.add_argument("--auto-catalog", action="store_true")
    parser.add_argument(
        "--vp", type=float, help="Override the administrator Vp for this collector"
    )
    parser.add_argument(
        "--vs", type=float, help="Override the administrator Vs for this collector"
    )
    args = parser.parse_args()
    if (
        not 1 <= args.shards <= 8
        or not 1 <= args.workers <= 32
        or not 1 <= args.window <= 1800
        or args.interval < 5
        or args.delay < 0
    ):
        parser.error("workers 1–32, window 1–1800, interval ≥5, delay ≥0")
    init_db()
    from .seedlink4 import run as seedlink

    if args.mode == "seedlink" and args.shards > 1:
        import multiprocessing
        from argparse import Namespace

        workers = []
        try:
            for shard in range(args.shards):
                config = Namespace(**vars(args), shard=shard)
                process = multiprocessing.Process(target=seedlink, args=(config,))
                process.start()
                workers.append(process)
            checked = 0.0
            while all(p.is_alive() for p in workers):
                if time.monotonic() - checked > 60:
                    try:
                        storage_guard()
                        state("collector-storage", {"error": None})
                    except Exception as exc:
                        state("collector-storage", {"error": str(exc)})
                    checked = time.monotonic()
                statuses = [
                    state(f"collector:shard:{i}") or {} for i in range(args.shards)
                ]
                errors = [s.get("error") for s in statuses if s.get("error")]
                telemetry(
                    mode="seedlink4",
                    server=args.server,
                    shards=args.shards,
                    subscribed=len(rows("SELECT id FROM stations WHERE enabled=1")),
                    received=sum(s.get("received", 0) for s in statuses),
                    dropped=sum(s.get("dropped", 0) for s in statuses),
                    errors=errors,
                    shard_status=statuses,
                )
                time.sleep(5)
            raise RuntimeError("SeedLink 子进程退出，重启采集服务以恢复全部分片")
        finally:
            for process in workers:
                process.terminate()
            for process in workers:
                process.join(timeout=5)
    else:
        (seedlink if args.mode == "seedlink" else poll)(args)


if __name__ == "__main__":
    main()
