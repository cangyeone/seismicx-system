"""Persistent job worker. CPU algorithms run outside the API process."""

import json
import logging
import time
import uuid
from .db import connect, now, init_db
from .config import settings


def enqueue(kind, payload):
    if kind in ("detect", "relocate"):
        from .runtime_settings import task_config

        payload = task_config(payload)
    job_id = uuid.uuid4().hex
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        if (
            db.execute(
                "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')"
            ).fetchone()[0]
            >= settings.queue_capacity
        ):
            raise ValueError("任务队列已满，请稍后提交")
        db.execute(
            "INSERT INTO jobs(id,kind,payload,created_at,updated_at) VALUES (?,?,?,?,?)",
            (job_id, kind, json.dumps(payload), now(), now()),
        )
    return {"id": job_id, "status": "queued"}


def process_one():
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if row is None:
            return False
        job = dict(row)
        db.execute(
            "UPDATE jobs SET status='running',updated_at=? WHERE id=?",
            (now(), job["id"]),
        )

    def progress(message):
        with connect() as db:
            db.execute(
                "UPDATE jobs SET progress=?,updated_at=? WHERE id=?",
                (message, now(), job["id"]),
            )

    try:
        from .algorithms import detect, relocate, magnitude
        from .sources import sync_all

        if job["kind"] == "sync":
            result = sync_all()
        else:
            result = {"detect": detect, "relocate": relocate, "magnitude": magnitude}[
                job["kind"]
            ](job["id"], json.loads(job["payload"]), progress)
        with connect() as db:
            db.execute(
                "UPDATE jobs SET status='completed',result=?,progress='完成',updated_at=? WHERE id=?",
                (json.dumps(result, ensure_ascii=False), now(), job["id"]),
            )
    except Exception as exc:
        logging.exception("Job %s failed", job["id"])
        with connect() as db:
            db.execute(
                "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?",
                (str(exc)[-3000:], now(), job["id"]),
            )
    return True


def main():
    import fcntl

    init_db()
    # A single SQLite worker per data directory; API restarts never requeue active jobs.
    lock = (settings.data_dir / "worker.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    with connect() as db:
        db.execute(
            "UPDATE jobs SET status='failed',error='工作进程中断，请重试',updated_at=? WHERE status='running'",
            (now(),),
        )
    import threading

    def heartbeat():
        from .db import state

        while True:
            state("worker", {"heartbeat": now()})
            time.sleep(5)

    threading.Thread(target=heartbeat, daemon=True).start()
    while True:
        if not process_one():
            time.sleep(1)


if __name__ == "__main__":
    main()
