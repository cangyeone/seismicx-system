"""Install the reviewed, pinned SeismicX catalog engine without vendoring it."""

import argparse
from pathlib import Path
import subprocess

REVISION = "eebb87878ae27fbc8e33214c38c44fdeff9ba07b"
REPO = "https://github.com/cangyeone/seismicx-catalog-skill.git"

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="external/seismicx-catalog")
    args = parser.parse_args()
    target = Path(args.target)
    if target.exists():
        current = subprocess.check_output(
            ["git", "-C", str(target), "rev-parse", "HEAD"], text=True
        ).strip()
        if current != REVISION:
            raise SystemExit(
                "Existing engine has a different revision; preserve it and choose a new target."
            )
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", REPO, str(target)], check=True)
        subprocess.run(
            ["git", "-C", str(target), "checkout", "--detach", REVISION], check=True
        )
    print(f"SeismicX catalog ready: {target.resolve()} @ {REVISION}")
