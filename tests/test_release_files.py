"""Publication checks must examine blobs without exposing credential contents."""
from scripts.check_release_files import validate


def test_release_blocks_private_documents_runtime_and_keys():
    files = [("notes/连接（本地私密）.md", b"not for publication"),
             (".env.production", b"configuration"),
             ("runtime/seismicx.sqlite3", b"database"),
             ("accidental.txt", b"-----BEGIN " + b"OPENSSH PRIVATE KEY-----")]
    issues = validate(files)
    assert len(issues) == 4
    assert all("not for publication" not in reason for _, reason in issues)
    assert validate([(".env.example", b"SEISMICX_LLM_API_KEY=\n")]) == []


def test_community_blocks_newer_version_and_private_features():
    version = ("package.json", b'{"version":"2.1.0-community.1"}')
    assert validate([version], community=True) == []
    assert validate([("package.json", b'{"version":"3.2.0"}')], community=True)
    assert validate([version, ("backend/postgres.py", b"code")], community=True)
    assert validate([("package.json", b'{"version":"3.2.0"}'),
                     ("backend/postgres.py", b"code")]) == []
