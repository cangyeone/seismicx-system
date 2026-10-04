"""Initialize/recover the administrator; never stores plaintext credentials."""

import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.db import init_db
from backend.auth import bootstrap

if __name__ == "__main__":
    username = input("Username: ").strip()
    password = getpass.getpass("Password (8+ characters): ")
    init_db()
    bootstrap(username, password)
    print("Administrator saved; previous sessions revoked.")
