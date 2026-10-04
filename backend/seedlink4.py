"""FDSN SeedLink 4, miniSEED 2/3 payloads, bounded packets and durable cursors.

Protocol: https://docs.fdsn.org/projects/seedlink/en/latest/protocol.html
The socket supplies backpressure; a packet is acknowledged only after disk IO.
"""

import io
import socket
import struct
import time
import zlib
from .config import settings
from .db import state, rows
from .edge.archive import ArchiveBatch

MAX_PACKET_BYTES = 4 * 1024 * 1024


def read_exact(sock, count):
    data = bytearray()
    while len(data) < count:
        part = sock.recv(count - len(data))
        if not part:
            raise ConnectionError("SeedLink 连接已关闭")
        data.extend(part)
    return bytes(data)


def line(sock):
    data = bytearray()
    while len(data) < 1024:
        data.extend(read_exact(sock, 1))
        if data.endswith(b"\n"):
            return data.decode("utf-8", errors="replace").strip()
    raise ValueError("SeedLink 响应行超过上限")


def command(sock, text):
    sock.sendall(text.encode("ascii") + b"\r\n")
    response = line(sock)
    if response != "OK":
        raise ValueError(f"SeedLink {text.split()[0]}: {response}")


def packet(sock):
    header = read_exact(sock, 17)
    if header[:2] != b"SE":
        raise ValueError("非法 SeedLink 4 数据包")
    size, sequence, name_length = struct.unpack("<IQB", header[4:])
    if size > MAX_PACKET_BYTES:
        raise ValueError("SeedLink 数据包超过 4 MB 上限")
    station_id = read_exact(sock, name_length).decode("ascii")
    payload = read_exact(sock, size)
    return header[2:4], station_id, sequence, payload


def run(args):
    from obspy import read, Stream
    from .collector import storage_guard
    from .db import now

    shard = getattr(args, "shard", 0)
    shards = getattr(args, "shards", 1)

    def selected():
        return [
            s
            for s in rows("SELECT * FROM stations WHERE enabled=1 ORDER BY id")
            if zlib.crc32((s["network"] + "_" + s["station"]).encode()) % shards
            == shard
        ]

    def telemetry(**extra):
        return state(
            "collector" if shards == 1 else f"collector:shard:{shard}",
            {"heartbeat": now(), "shard": shard, **extra},
        )

    host, port = args.server.rsplit(":", 1)
    backoff, received, last_check = 2, 0, 0.0
    while True:
        stations = selected()
        if not stations:
            telemetry(mode="seedlink4", subscribed=0, received=received)
            time.sleep(5)
            continue
        mapping = {}
        for station in stations:
            mapping.setdefault(f"{station['network']}_{station['station']}", []).append(
                station
            )
        batch = ArchiveBatch(args.server)
        try:
            with socket.create_connection((host, int(port)), timeout=15) as sock:
                sock.settimeout(30)
                sock.sendall(b"HELLO\r\n")
                server = line(sock)
                line(sock)  # Consume the organization line before protocol negotiation.
                if "SLPROTO:4" not in server:
                    # Legacy servers use the ObsPy client implementation.
                    from .collector import seedlink3

                    return seedlink3(args)
                command(sock, "SLPROTO 4.0")
                handshake = []
                for sid, entries in mapping.items():
                    handshake.append("STATION " + sid)
                    for station in entries:
                        pattern = (
                            (
                                station["location"]
                                if settings.edge_enabled
                                else station["location"] or "*"
                            )
                            + "_"
                            + "_".join(station["channel"])
                        )
                        handshake.append("SELECT " + pattern + ".*D")
                    cursor = state("seedlink-cursor:" + args.server + ":" + sid)
                    handshake.append(
                        "DATA" + (" " + str(cursor["sequence"] + 1) if cursor else "")
                    )
                # Pipeline the v4 handshake: hundreds of station subscriptions
                # should not pay three intercontinental round trips per station.
                sock.sendall(("\r\n".join(handshake) + "\r\n").encode("ascii"))
                for request in handshake:
                    response = line(sock)
                    if response != "OK":
                        raise ValueError(f"SeedLink {request.split()[0]}: {response}")
                sock.sendall(b"END\r\n")
                last_storage_check = 0.0
                while True:
                    if time.monotonic() - last_check > 5:
                        if time.monotonic() - last_storage_check > 60:
                            if shards == 1:
                                try:
                                    storage_guard()
                                    state("collector-storage", {"error": None})
                                except Exception as exc:
                                    state("collector-storage", {"error": str(exc)})
                                    raise
                            last_storage_check = time.monotonic()
                        storage = state("collector-storage") or {}
                        if storage.get("error"):
                            raise RuntimeError(storage["error"])
                        last_check = time.monotonic()
                        current = selected()
                        if [(s["id"], s["channel"]) for s in current] != [
                            (s["id"], s["channel"]) for s in stations
                        ]:
                            break
                        telemetry(
                            mode="seedlink4",
                            server=args.server,
                            subscribed=len(stations),
                            received=received,
                            dropped=0,
                        )
                    fmt, sid, sequence, payload = packet(sock)
                    if fmt == b"2D":
                        stream = read(io.BytesIO(payload), format="MSEED")
                    elif fmt == b"3D":
                        from pymseed import MS3Record, sourceid2nslc
                        from obspy import Trace, UTCDateTime

                        stream = Stream()
                        for record in MS3Record.from_buffer(payload, unpack_data=True):
                            net, sta, loc, cha = sourceid2nslc(record.sourceid)
                            stream += Trace(
                                record.np_datasamples.copy(),
                                header={
                                    "network": net,
                                    "station": sta,
                                    "location": loc,
                                    "channel": cha,
                                    "sampling_rate": record.samprate,
                                    "starttime": UTCDateTime(ns=record.starttime),
                                },
                            )
                    else:
                        raise ValueError(f"未请求的 SeedLink payload {fmt!r}")
                    batch.add(
                        sid,
                        sequence,
                        stream,
                        mapping,
                        payload if fmt == b"3D" else None,
                    )
                    if batch.due():
                        batch.flush()
                    received += 1
                    backoff = 2
        except Exception as exc:
            # On reconnect only durable batches are acknowledged. Any uncommitted
            # records are replayed from the last committed sequence by the server.
            telemetry(
                mode="seedlink4",
                server=args.server,
                error=str(exc),
                received=received,
                reconnect_in=backoff,
            )
            time.sleep(backoff)
            backoff = min(60, backoff * 2)
