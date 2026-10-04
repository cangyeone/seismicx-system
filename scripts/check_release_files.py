"""Check staged Git blobs without reading local private files or printing secrets.

This is a publication guard, not a complete secret scanner. Review configuration
and history separately. --community additionally enforces the old release lane.
"""

import argparse
import json
from pathlib import PurePosixPath
import re
import subprocess

SECRET_MARKERS = (
    re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}\b"),
    re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b"),
)
PRIVATE_MODULES = (
    "deploy/macos/", "deploy/infra/", "backend/adapters/",
    "backend/postgres.py", "backend/bus.py", "backend/message_bus.py",
    "backend/capture_gaps.py", "backend/storage_policy.py",
    "backend/waveform_archive.py",
)


def forbidden_path(name):
    path = PurePosixPath(name)
    sample = path.name.endswith(".example")
    if any(part in {"runtime", "backups", ".ssh", ".venv", "node_modules", "dist"}
           for part in path.parts):
        return True
    if "私密" in name or "访问指南" in name:
        return True
    if path.name == ".DS_Store" or path.name.startswith(("id_rsa", "id_ed25519")):
        return True
    if not sample and (path.name.startswith(".env") or path.suffix in {
        ".env", ".pem", ".key", ".p12", ".pfx", ".db", ".sqlite", ".sqlite3", ".log"
    }):
        return True
    return False


def validate(blobs, community=False):
    issues = []
    version = None
    for name, data in blobs:
        if forbidden_path(name):
            issues.append((name, "private/runtime file is staged"))
        if any(pattern.search(data) for pattern in SECRET_MARKERS):
            issues.append((name, "credential-like content; value suppressed"))
        if community and name.startswith(PRIVATE_MODULES):
            issues.append((name, "belongs to the later private release lane"))
        if name == "package.json":
            try:
                version = json.loads(data)["version"]
            except (ValueError, KeyError, TypeError):
                issues.append((name, "missing or invalid version"))
    if community and (not isinstance(version, str) or not version.startswith("2.1.")):
        issues.append(("package.json", "community lane must stay on the approved 2.1 family"))
    return issues


def index_blobs():
    names = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
    for name in names:
        if name:
            yield name, subprocess.check_output(["git", "show", f":{name}"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--community", action="store_true")
    args = parser.parse_args()
    issues = validate(index_blobs(), args.community)
    for name, reason in issues:
        print(f"BLOCKED: {name}: {reason}")
    if issues:
        raise SystemExit(1)
    print("Staged release files passed; history and deployment values still require review.")


if __name__ == "__main__":
    main()
