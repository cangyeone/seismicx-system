"""Start API, durable worker and optional waveform collector; Ctrl-C stops all."""

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--collector", choices=["none", "fdsn", "seedlink"], default="fdsn"
    )
    parser.add_argument("--auto-catalog", action="store_true")
    args = parser.parse_args()
    commands = [
        [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.app:app",
            "--host",
            args.host,
            "--port",
            str(args.port),
            "--no-access-log",
        ],
        [sys.executable, "-m", "backend.worker"],
    ]
    if args.collector != "none":
        command = [sys.executable, "-m", "backend.collector", "--mode", args.collector]
        if args.auto_catalog:
            command.append("--auto-catalog")
        commands.append(command)
    processes = []
    try:
        for command in commands:
            processes.append(subprocess.Popen(command, cwd=ROOT))
        print(f"SeismicX: http://{args.host}:{args.port}", flush=True)
        while all(p.poll() is None for p in processes):
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    main()
