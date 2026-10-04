"""SQLite WAL metadata store. Raw waveforms are never stored in database rows."""

import json
import sqlite3
import threading
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from .config import settings

# SQLite 3.51.0/3.51.1 has a Unix open/close mutex inversion, fixed in 3.51.2.
# Some macOS Python distributions still bundle it. Only those runtimes serialize
# short metadata transactions; other versions retain normal WAL concurrency.
# https://www.sqlite.org/releaselog/3_51_2.html
_legacy_sqlite_lock = threading.RLock()


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@contextmanager
def connect():
    guard = (
        _legacy_sqlite_lock
        if (3, 51, 0) <= sqlite3.sqlite_version_info < (3, 51, 2)
        else nullcontext()
    )
    with guard:
        with _connection() as db:
            yield db


@contextmanager
def _connection():
    db = sqlite3.connect(settings.data_dir / "seismicx.sqlite3", timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=30000")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db():
    with connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
        CREATE TABLE IF NOT EXISTS stations (
          id TEXT PRIMARY KEY, network TEXT NOT NULL, station TEXT NOT NULL,
          location TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT 'BH?',
          latitude REAL NOT NULL, longitude REAL NOT NULL, elevation_m REAL DEFAULT 0,
          name TEXT DEFAULT '', provider TEXT DEFAULT 'EARTHSCOPE', enabled INTEGER DEFAULT 0,
          last_sample TEXT, last_received TEXT, error TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY, origin_time TEXT NOT NULL, latitude REAL NOT NULL,
          longitude REAL NOT NULL, depth_km REAL NOT NULL, magnitude REAL,
          magnitude_type TEXT DEFAULT '', place TEXT DEFAULT '', source TEXT NOT NULL,
          status TEXT DEFAULT 'candidate', rms REAL, n_picks INTEGER DEFAULT 0,
          azimuth_gap REAL, method TEXT DEFAULT '', velocity_model TEXT DEFAULT '',
          version INTEGER DEFAULT 1, monitored INTEGER DEFAULT 0,
          notes TEXT DEFAULT '', provenance TEXT DEFAULT '{}', updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_time ON events(origin_time DESC);
        CREATE TABLE IF NOT EXISTS picks (
          id TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id), station_id TEXT NOT NULL,
          phase TEXT NOT NULL, time TEXT NOT NULL, score REAL, residual_s REAL,
          method TEXT NOT NULL, version INTEGER DEFAULT 1, waveform_path TEXT DEFAULT '');
        CREATE INDEX IF NOT EXISTS picks_event ON picks(event_id);
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY, entity TEXT, entity_id TEXT, before_json TEXT,
          after_json TEXT, reason TEXT, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued', progress TEXT DEFAULT '', result TEXT,
          error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, created_at);
        CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS waveform_files (
          path TEXT PRIMARY KEY, station_id TEXT NOT NULL, start TEXT NOT NULL,
          end TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS waveform_station ON waveform_files(station_id, start, end);
        CREATE TABLE IF NOT EXISTS archive_offsets (
          path TEXT PRIMARY KEY, size INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS realtime_picks (
          id TEXT PRIMARY KEY, station_id TEXT NOT NULL, phase TEXT NOT NULL,
          time TEXT NOT NULL, score REAL, run TEXT, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS realtime_pick_station ON realtime_picks(station_id,phase,time);
        CREATE TABLE IF NOT EXISTS broadcast_seen (
          event_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS broadcast_notices (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
          received_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS broadcast_cache (
          cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS broadcast_cache_time ON broadcast_cache(updated_at);
        """)


def rows(sql, params=()):
    with connect() as db:
        return [dict(row) for row in db.execute(sql, params).fetchall()]


def one(sql, params=()):
    found = rows(sql, params)
    return found[0] if found else None


def state(key, value=None):
    if value is not None:
        with connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO state VALUES (?,?)", (key, json.dumps(value))
            )
        return value
    row = one("SELECT value FROM state WHERE key=?", (key,))
    return json.loads(row["value"]) if row else None


def audit(db, entity, entity_id, before, after, reason):
    db.execute(
        "INSERT INTO audit(entity,entity_id,before_json,after_json,reason,created_at) VALUES (?,?,?,?,?,?)",
        (entity, entity_id, json.dumps(before), json.dumps(after), reason, now()),
    )
