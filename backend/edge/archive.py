"""Bounded packet batches: durable waveform bytes precede cursor checkpoints."""

import ctypes
import io
import json
import os
import sys
import time
from collections import defaultdict
from ..config import settings
from ..db import connect, now


class ArchiveBatch:
    def __init__(self, server, max_packets=256, max_bytes=8 * 1024 * 1024):
        self.server = server
        self.max_packets = max_packets
        self.max_bytes = max_bytes
        self.traces = defaultdict(list)
        self.raw = defaultdict(bytearray)
        self.station_ids = defaultdict(set)
        self.cursors = {}
        self.count = self.size = 0
        self.started = time.monotonic()
        self.directory = settings.data_dir / "waveforms"
        self.directory.mkdir(parents=True, exist_ok=True)

    def add(self, sid, sequence, stream, mapping, raw=None):
        # Validate before mutating the batch or moving a resume cursor.
        additions = []
        for trace in stream:
            matches = [
                s
                for s in mapping.get(sid, [])
                if (
                    s["location"] == trace.stats.location
                    if settings.edge_enabled
                    else not s["location"] or s["location"] == trace.stats.location
                )
            ]
            if not matches:
                raise ValueError("SeedLink 返回未订阅的台站/位置码")
            bucket = int(float(trace.stats.starttime) // 300)
            path = self.directory / f"{trace.id}-{bucket}.mseed"
            additions.append((path, trace, matches))
        for path, trace, matches in additions:
            self.traces[path].append(trace)
            self.station_ids[path].update(s["id"] for s in matches)
            self.size += trace.data.nbytes
        if raw and stream:
            bucket = int(float(stream[0].stats.starttime) // 300)
            self.raw[self.directory / f"{sid}-{bucket}.raw.mseed3"].extend(raw)
            self.size += len(raw)
        self.cursors[sid] = sequence
        self.count += 1

    def due(self):
        return self.count and (
            self.count >= self.max_packets
            or self.size >= self.max_bytes
            or time.monotonic() - self.started >= 1
        )

    @staticmethod
    def durable(paths, directory):
        # Linux syncfs amortizes write barriers across hundreds of files. A failure
        # leaves old DB cursors intact, so reconnect can replay the entire batch.
        if sys.platform.startswith("linux"):
            libc = ctypes.CDLL(None, use_errno=True)
            syncfs = getattr(libc, "syncfs", None)
            if syncfs:
                syncfs.argtypes = [ctypes.c_int]
                syncfs.restype = ctypes.c_int
                fd = os.open(directory, os.O_RDONLY)
                try:
                    if syncfs(fd) != 0:
                        raise OSError(ctypes.get_errno(), "waveform syncfs failed")
                finally:
                    os.close(fd)
                return
        for path in paths:
            with path.open("rb") as handle:
                os.fsync(handle.fileno())
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def flush(self):
        if not self.count:
            return
        from obspy import Stream

        paths = set(self.traces) | set(self.raw)
        offsets = {}
        # Register the last known valid append boundary before touching each file.
        # After a process crash, an uncommitted partial record is truncated before
        # replay, so an interrupted miniSEED packet cannot poison future reads.
        with connect() as db:
            for path in paths:
                row = db.execute(
                    "SELECT size FROM archive_offsets WHERE path=?", (str(path),)
                ).fetchone()
                if row is None:
                    size = path.stat().st_size if path.exists() else 0
                    db.execute(
                        "INSERT INTO archive_offsets VALUES (?,?)", (str(path), size)
                    )
                else:
                    size = row["size"]
                offsets[path] = size
        sizes = {}

        def append(path, data):
            with path.open("r+b" if path.exists() else "w+b") as output:
                output.seek(0, os.SEEK_END)
                if output.tell() < offsets[path]:
                    raise OSError("已提交的波形文件被截短，停止推进游标：" + str(path))
                output.truncate(offsets[path])
                output.seek(offsets[path])
                output.write(data)
                sizes[path] = output.tell()

        indexes = []
        touched = set()
        for path, traces in self.traces.items():
            stream = Stream(traces)
            stream.merge(method=-1)  # coalesce only matching contiguous records
            buffer = io.BytesIO()
            stream.write(buffer, format="MSEED")
            append(path, buffer.getvalue())
            touched.add(path)
            start = str(min(t.stats.starttime for t in stream))
            end = str(max(t.stats.endtime for t in stream))
            for sid in self.station_ids[path]:
                indexes.append((str(path), sid, start, end, "SeedLink4", now()))
        for path, payload in self.raw.items():
            append(path, payload)
            touched.add(path)
        self.durable(touched, self.directory)
        with connect() as db:
            db.executemany(
                "UPDATE archive_offsets SET size=? WHERE path=?",
                [(size, str(path)) for path, size in sizes.items()],
            )
            db.executemany(
                """INSERT INTO waveform_files VALUES (?,?,?,?,?,?)
                ON CONFLICT(path) DO UPDATE SET start=MIN(start,excluded.start),end=MAX(end,excluded.end)""",
                indexes,
            )
            db.executemany(
                """UPDATE stations SET last_sample=CASE WHEN last_sample IS NULL OR last_sample<?
                THEN ? ELSE last_sample END,last_received=?,error=NULL WHERE id=?""",
                [(r[3], r[3], now(), r[1]) for r in indexes],
            )
            db.executemany(
                "INSERT OR REPLACE INTO state VALUES (?,?)",
                [
                    (
                        "seedlink-cursor:" + self.server + ":" + sid,
                        json.dumps({"sequence": seq}),
                    )
                    for sid, seq in self.cursors.items()
                ],
            )
        self.traces.clear()
        self.raw.clear()
        self.station_ids.clear()
        self.cursors.clear()
        self.count = self.size = 0
        self.started = time.monotonic()
