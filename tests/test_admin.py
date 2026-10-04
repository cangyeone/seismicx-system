import json
import time
import pytest
from fastapi.testclient import TestClient
from backend.app import app
from backend.config import settings
from backend.db import init_db, connect, one, state
from backend.auth import bootstrap
from backend.runtime_settings import task_config, accepts_pick


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Restore process globals changed by persisted runtime settings between tests.
    for key, value in settings.model_dump().items():
        monkeypatch.setattr(settings, key, value)
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "auto_sync", False)
    monkeypatch.setattr(settings, "broadcast_relay_url", "")
    init_db()
    bootstrap("test-admin", "test-password")
    with TestClient(app, base_url="https://testserver") as client:
        yield client


def login(client, username="test-admin", password="test-password"):
    response = client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200, response.text
    client.headers["X-CSRF-Token"] = response.json()["csrf"]
    return response


def test_public_reads_and_all_administration_require_login(client, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "old-secret")
    for path in (
        "/api/overview",
        "/api/stations",
        "/api/events",
        "/api/broadcast/feed",
        "/api/catalog/export",
        "/admin",
    ):
        assert client.get(path).status_code == 200
    assert client.post("/api/analysis", json={}).status_code == 200
    assert (
        client.post(
            "/api/analysis", json={"use_llm": True, "provider": "cloud"}
        ).status_code
        == 401
    )
    for path in (
        "/api/settings",
        "/api/jobs",
        "/api/edge/status",
        "/api/admin/openapi.json",
        "/api/admin/docs",
    ):
        assert (
            client.get(path, headers={"Authorization": "Bearer old-secret"}).status_code
            == 401
        )
    for method, path in (
        ("POST", "/api/events"),
        ("PATCH", "/api/events/unknown"),
        ("POST", "/api/stations"),
        ("PATCH", "/api/stations/unknown"),
        ("POST", "/api/events/unknown/picks"),
        ("PATCH", "/api/picks/unknown"),
        ("DELETE", "/api/picks/unknown"),
        ("POST", "/api/jobs/detect"),
        ("POST", "/api/events/unknown/relocate"),
        ("POST", "/api/events/unknown/magnitude"),
        ("POST", "/api/sync"),
        ("PUT", "/api/settings"),
        ("PUT", "/api/auth/credentials"),
    ):
        assert client.request(method, path, json={}).status_code == 401, path


def test_sessions_csrf_cookie_and_logout(client):
    assert client.get("/api/auth/session").json() == {"authenticated": False}
    result = login(client)
    cookie = result.headers["set-cookie"]
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=strict" in cookie
    assert client.get("/api/settings").status_code == 200
    assert (
        client.post("/api/sync", headers={"X-CSRF-Token": "wrong"}).status_code == 403
    )
    assert (
        client.post("/api/sync", headers={"Origin": "https://evil.example"}).status_code
        == 403
    )
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/settings").status_code == 401
    assert client.get("/api/overview").status_code == 200


def test_login_rate_limit_and_origin(client):
    assert (
        client.post(
            "/api/auth/login",
            json={"username": "test-admin", "password": "test-password"},
            headers={"Origin": "https://evil.example"},
        ).status_code
        == 403
    )
    for _ in range(10):
        assert (
            client.post(
                "/api/auth/login", json={"username": "test-admin", "password": "wrong"}
            ).status_code
            == 401
        )
    assert (
        client.post(
            "/api/auth/login",
            json={"username": "test-admin", "password": "test-password"},
        ).status_code
        == 429
    )


def test_credentials_change_revokes_all_sessions_and_never_stores_plaintext(client):
    login(client)
    previous = client.cookies.get("seismicx_admin")
    login(client)
    assert (
        client.put(
            "/api/auth/credentials",
            json={
                "username": "next-admin",
                "current_password": "wrong",
                "password": "new-password",
            },
        ).status_code
        == 403
    )
    assert (
        client.put(
            "/api/auth/credentials",
            json={
                "username": "next-admin",
                "current_password": "test-password",
                "password": "new-password",
            },
        ).status_code
        == 200
    )
    assert client.get("/api/settings").status_code == 401
    assert (
        client.get(
            "/api/settings", headers={"Cookie": f"seismicx_admin={previous}"}
        ).status_code
        == 401
    )
    login(client, "next-admin", "new-password")
    stored = one("SELECT password_hash FROM admin_account")["password_hash"]
    assert "new-password" not in stored
    assert "new-password" not in json.dumps(one("SELECT * FROM audit"))
    with connect() as db:
        db.execute("UPDATE admin_sessions SET expires=?", (time.time() - 1,))
    assert client.get("/api/settings").status_code == 401


def test_public_payloads_do_not_leak_worker_paths_or_private_configuration(client):
    login(client)
    event = client.post(
        "/api/events",
        json={
            "origin_time": "2024-01-01T00:00:00Z",
            "latitude": 35,
            "longitude": 117,
            "depth_km": 10,
        },
    ).json()
    sid = client.post(
        "/api/stations",
        json={"network": "XX", "station": "TEST", "latitude": 35, "longitude": 117},
    ).json()["id"]
    pick = client.post(
        f"/api/events/{event['id']}/picks",
        json={
            "station_id": sid,
            "phase": "Pg",
            "time": "2024-01-01T00:00:04Z",
            "reason": "fixture",
        },
    ).json()
    secret = "/private/config/endpoint-token"
    with connect() as db:
        db.execute(
            "UPDATE events SET provenance=?",
            (json.dumps({"request": {"url": secret}, "qc": ["RMS > 1 s"]}),),
        )
        db.execute("UPDATE picks SET waveform_path=? WHERE id=?", (secret, pick["id"]))
        db.execute("UPDATE stations SET error=?", (secret,))
    state("collector", {"server": secret, "error": secret, "heartbeat": "2024-01-01"})
    state("source:catalog", {"ok": False, "error": secret})
    client.post("/api/auth/logout")
    for path in (
        "/api/overview",
        "/api/stations",
        "/api/events",
        f"/api/events/{event['id']}",
        "/api/broadcast/feed",
    ):
        response = client.get(path)
        assert response.status_code == 200
        assert secret not in response.text
    public = client.get(f"/api/events/{event['id']}").json()
    assert public["audit"] == [] and "waveform_path" not in public["picks"][0]
    assert "RMS > 1 s" in public["provenance"]


def test_settings_persist_conflicts_and_task_snapshots(client):
    login(client)
    before = client.get("/api/settings").json()["runtime"]
    config = before["config"]
    config["phase"].update(p_threshold=0.7, s_threshold=0.5)
    config["location"].update(vp=6.5, vs=3.8, grid_depth=13, max_depth=40)
    config["association"].update(min_p=4, min_total=6)
    config["system"]["platform_name"] = "Test Observatory"
    body = {"revision": 0, "config": config}
    response = client.put("/api/settings", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 1
    assert client.get("/api/overview").json()["platform_name"] == "Test Observatory"
    assert client.put("/api/settings", json=body).status_code == 409
    job = client.post(
        "/api/jobs/detect",
        json={
            "start": "2024-01-01T00:00:00Z",
            "end": "2024-01-01T00:03:00Z",
            "station_ids": ["XX.TEST."],
        },
    ).json()
    payload = json.loads(
        one("SELECT payload FROM jobs WHERE id=?", (job["id"],))["payload"]
    )
    assert payload["vp"] == 6.5 and payload["vs"] == 3.8
    assert payload["_configuration"]["revision"] == 1
    assert not accepts_pick({"phase": "Pn", "score": 0.6}, payload)
    assert accepts_pick({"phase": "Sn", "score": 0.6}, payload)
    body["revision"] = 1
    config["phase"]["p_threshold"] = 0.9
    assert client.put("/api/settings", json=body).status_code == 200
    unchanged = json.loads(
        one("SELECT payload FROM jobs WHERE id=?", (job["id"],))["payload"]
    )
    assert unchanged == payload
    assert task_config({})["_configuration"]["revision"] == 2
    assert (
        client.get("/api/settings").json()["runtime"]["config"]["phase"]["p_threshold"]
        == 0.9
    )


@pytest.mark.parametrize(
    "group,key,value",
    [
        ("phase", "p_threshold", 0.01),
        ("association", "grid_spacing_deg", 0.001),
        ("association", "min_total", 4),
        ("location", "vs", 6),
        ("location", "min_depth", 40),
        ("system", "llm_context_tokens", 8000),
        ("system", "edge_interval_seconds", 600),
        ("system", "llm_base_url", "https://user:secret@example.com/v1"),
    ],
)
def test_invalid_settings_rejected_without_partial_write(client, group, key, value):
    login(client)
    original = client.get("/api/settings").json()["runtime"]
    body = json.loads(json.dumps(original))
    body.pop("updated_at")
    body["config"][group][key] = value
    assert client.put("/api/settings", json=body).status_code == 422
    assert client.get("/api/settings").json()["runtime"] == original


def test_real_and_grid_receive_configuration_and_empty_threshold_result(
    client, monkeypatch
):
    from backend import algorithms
    from backend.runtime_settings import location_args

    login(client)
    body = client.get("/api/settings").json()["runtime"]
    body.pop("updated_at")
    body["config"]["phase"].update(p_threshold=0.8, s_threshold=0.5)
    body["config"]["association"].update(search_radius_deg=0.3, min_p=4, min_total=6)
    body["config"]["location"].update(grid_lat=21, grid_lon=19, max_depth=40)
    assert client.put("/api/settings", json=body).status_code == 200
    ids = []
    for index in range(3):
        ids.append(
            client.post(
                "/api/stations",
                json={
                    "network": "XX",
                    "station": f"S{index}",
                    "latitude": 35 + index * 0.1,
                    "longitude": 117,
                },
            ).json()["id"]
        )
    calls = []

    def engine(args, work):
        calls.append(args)
        if args[0] == "pick":
            algorithms.write_csv(
                work / "picks.csv",
                [
                    {
                        "network": "XX",
                        "station": "S0",
                        "location": "",
                        "phase": "Pg",
                        "score": 0.6,
                    },
                    {
                        "network": "XX",
                        "station": "S1",
                        "location": "",
                        "phase": "Sg",
                        "score": 0.7,
                    },
                ],
            )
        if args[0] == "associate":
            filtered = algorithms.read_csv(work / "picks.csv")
            assert len(filtered) == 1 and filtered[0]["phase"] == "Sg"
            assert str(args[args.index("--real-R") + 1]).startswith("0.3/")
            assert str(args[args.index("--real-S") + 1]).startswith("4/2/6/")
            algorithms.write_csv(work / "associated.csv", [], fields=["event_id"])

    monkeypatch.setattr(algorithms, "run_skill", engine)
    monkeypatch.setattr(algorithms, "fetch_waveform", lambda *args: None)
    payload = task_config(
        {
            "start": "2024-01-01T00:00:00Z",
            "end": "2024-01-01T00:03:00Z",
            "station_ids": ids,
        }
    )
    result = algorithms.detect("configured", payload, lambda _: None)
    assert result["picks"] == 1 and any(c[0] == "associate" for c in calls)
    grid = location_args(payload)
    assert (
        grid[grid.index("--grid-lat") + 1] == "21"
        and grid[grid.index("--max-depth") + 1] == "40.0"
    )
    calls.clear()
    payload["min_score"] = 0.95
    result = algorithms.detect("all-filtered", payload, lambda _: None)
    assert result["picks"] == 0 and not any(c[0] == "associate" for c in calls)
    assert (
        len(algorithms.read_csv(settings.data_dir / "runs/all-filtered/raw-picks.csv"))
        == 2
    )
    assert algorithms.read_csv(settings.data_dir / "runs/all-filtered/picks.csv") == []


def test_same_origin_checks_preserve_nondefault_public_port(client):
    client.headers.update(
        {"Host": "testserver:5012", "Origin": "https://testserver:5012"}
    )
    login(client)
    assert client.post("/api/sync").status_code == 202
    assert (
        client.post("/api/sync", headers={"Origin": "https://testserver"}).status_code
        == 403
    )
    assert client.post("/api/auth/logout").status_code == 200


def test_broadcast_provider_requires_admin_and_valid_cloud_configuration(client):
    login(client)
    original = client.get("/api/settings").json()["runtime"]
    config = original["config"]
    config["system"]["broadcast_llm_provider"] = "cloud"
    config["system"]["cloud_llm_base_url"] = ""
    config["system"]["cloud_llm_model"] = ""
    assert (
        client.put(
            "/api/settings", json={"revision": original["revision"], "config": config}
        ).status_code
        == 422
    )
    config["system"]["cloud_llm_base_url"] = "https://model.example/v1"
    config["system"]["cloud_llm_model"] = "example-online"
    saved = client.put(
        "/api/settings", json={"revision": original["revision"], "config": config}
    )
    assert saved.status_code == 200
    assert saved.json()["config"]["system"]["broadcast_llm_provider"] == "cloud"
    client.post("/api/auth/logout")
    assert (
        client.put("/api/settings", json={"revision": 1, "config": config}).status_code
        == 401
    )


def test_older_configuration_gains_model_provider_without_losing_values(client):
    from backend.runtime_settings import snapshot, RuntimeConfig

    config = RuntimeConfig().model_dump()
    del config["system"]["broadcast_llm_provider"]
    config["phase"]["p_threshold"] = 0.42
    state(
        "runtime:configuration", {"revision": 7, "updated_at": None, "config": config}
    )
    migrated = snapshot()
    assert migrated["revision"] == 7
    assert migrated["config"]["system"]["broadcast_llm_provider"] == "local"
    assert migrated["config"]["phase"]["p_threshold"] == 0.42
