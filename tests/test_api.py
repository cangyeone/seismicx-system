import csv
import io
import pytest
from fastapi.testclient import TestClient
from backend.config import settings
from backend.db import init_db
from backend.app import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "auto_sync", False)
    monkeypatch.setattr(settings, "api_token", "")
    init_db()
    from backend.auth import bootstrap

    bootstrap("test-admin", "test-password")
    with TestClient(app) as client:
        session = client.post(
            "/api/auth/login",
            json={"username": "test-admin", "password": "test-password"},
        ).json()
        client.headers["X-CSRF-Token"] = session["csrf"]
        yield client


def event(client):
    r = client.post(
        "/api/events",
        json={
            "origin_time": "2024-01-01T00:00:00Z",
            "latitude": 35,
            "longitude": 117,
            "depth_km": 10,
            "magnitude": 3.2,
            "place": "API regression fixture",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


def station(client):
    r = client.post(
        "/api/stations",
        json={
            "network": "XX",
            "station": "TEST",
            "latitude": 35,
            "longitude": 117,
            "enabled": True,
        },
    )
    assert r.status_code == 200
    return r.json()


def test_manual_edit_preserves_source_and_rejects_conflict(client):
    e = event(client)
    body = {**e, "reason": "复核震级", "magnitude": 3.4, "status": "reviewed"}
    result = client.patch("/api/events/" + e["id"], json=body)
    assert result.status_code == 200
    assert result.json()["source"] == "manual"
    assert result.json()["magnitude"] == 3.4
    assert client.patch("/api/events/" + e["id"], json=body).status_code == 409
    detail = client.get("/api/events/" + e["id"]).json()
    assert len(detail["audit"]) == 2


def test_pick_edits_invalidate_review_and_keep_audit(client):
    e = event(client)
    s = station(client)
    payload = {
        "station_id": s["id"],
        "phase": "Pg",
        "time": "2024-01-01T00:00:04Z",
        "reason": "波形拾取",
    }
    p = client.post(f"/api/events/{e['id']}/picks", json=payload).json()
    assert client.post(f"/api/events/{e['id']}/picks", json=payload).status_code == 409
    assert (
        client.patch(
            "/api/picks/" + p["id"],
            json={**payload, "time": "2024-01-01T00:00:04.2Z", "version": 1},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            "/api/picks/" + p["id"], json={**payload, "version": 1}
        ).status_code
        == 409
    )
    detail = client.get("/api/events/" + e["id"]).json()
    assert (
        detail["status"] == "candidate"
        and detail["n_picks"] == 1
        and detail["version"] == 3
    )
    assert len(detail["audit"]) == 3
    assert (
        client.delete(
            "/api/picks/" + p["id"] + "?version=2&reason=错误拾取"
        ).status_code
        == 200
    )
    assert client.get("/api/events/" + e["id"]).json()["n_picks"] == 0


def test_inventory_is_not_live_and_historical_reads_do_not_change_status(client):
    s = station(client)
    result = client.get("/api/stations").json()[0]
    assert result["status"] == "waiting" and result["latency_s"] is None
    from backend.sources import register_waveform
    from obspy import Stream, Trace, UTCDateTime
    import numpy as np

    trace = Trace(
        np.zeros(100, dtype=np.int32),
        header={"starttime": UTCDateTime("2024-01-01"), "sampling_rate": 10},
    )
    register_waveform("/unused.mseed", Stream([trace]), s["id"], "FDSN", live=False)
    assert client.get("/api/stations").json()[0]["last_sample"] is None


def test_invalid_inputs_and_queue_limits(client, monkeypatch):
    invalid = client.post(
        "/api/events",
        json={
            "origin_time": "2024-01-01T00:00:00",
            "latitude": 91,
            "longitude": 0,
            "depth_km": -1,
        },
    )
    assert invalid.status_code == 422
    window = {
        "start": "2024-01-01T00:00:00Z",
        "end": "2024-01-01T01:00:00Z",
        "station_ids": ["XX.TEST."],
    }
    assert client.post("/api/jobs/detect", json=window).status_code == 422
    monkeypatch.setattr(settings, "queue_capacity", 1)
    assert client.post("/api/sync").status_code == 202
    assert client.post("/api/sync").status_code == 422


def test_csv_and_quakeml_roundtrip(client):
    event(client)
    response = client.get("/api/catalog/export")
    data = list(csv.DictReader(io.StringIO(response.text.lstrip("\ufeff"))))
    assert len(data) == 1 and float(data[0]["depth_km"]) == 10
    from obspy import read_events

    xml = client.get("/api/catalog/export?format=quakeml")
    catalog = read_events(io.BytesIO(xml.content))
    assert catalog[0].origins[0].depth == 10000
    assert catalog[0].magnitudes[0].mag == 3.2


def test_auth_and_secret_redaction(client, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "test-secret")
    monkeypatch.setattr(settings, "llm_api_key", "never-expose-me")
    assert client.get("/api/stations").status_code == 200
    response = client.get(
        "/api/settings", headers={"Authorization": "Bearer test-secret"}
    )
    assert response.status_code == 200
    assert "never-expose-me" not in response.text


def test_small_model_budget_and_no_invented_statistics(client):
    from backend.analysis import summarize, build_messages

    summary = summarize(7, "all")
    assert summary["count"] == 0 and summary["magnitude_max"] is None
    messages, bound, output = build_messages(summary, "分析活动性")
    assert bound + output < 8000 and output <= 1400
    assert len(messages) == 2
    summary["caveats"] = ["长" * 10000]
    with pytest.raises(ValueError):
        build_messages(summary, "分析活动性")


def test_external_sync_does_not_overwrite_manual_review(client, monkeypatch):
    from backend import sources

    class Response:
        def json(self):
            return {
                "features": [
                    {
                        "id": "test1",
                        "properties": {
                            "time": 1704067200000,
                            "mag": 4.0,
                            "magType": "Mw",
                            "place": "external",
                        },
                        "geometry": {"coordinates": [117, 35, 12]},
                    }
                ]
            }

    monkeypatch.setattr(sources, "get", lambda *a, **k: Response())
    sources.sync_catalog()
    e = client.get("/api/events/usgs:test1").json()
    assert (
        client.patch(
            "/api/events/usgs:test1",
            json={**e, "status": "reviewed", "reason": "人工复核", "magnitude": 4.5},
        ).status_code
        == 200
    )
    sources.sync_catalog()
    assert client.get("/api/events/usgs:test1").json()["magnitude"] == 4.5


def test_inventory_sync_keeps_manual_station_metadata(client, monkeypatch):
    from backend import sources

    s = station(client)

    class Response:
        text = "#Network|Station|Latitude|Longitude|Elevation|SiteName\nXX|TEST|1|2|3|remote name\n"

    monkeypatch.setattr(sources, "get", lambda *a, **k: Response())
    sources.sync_stations()
    actual = next(x for x in client.get("/api/stations").json() if x["id"] == s["id"])
    assert actual["latitude"] == 35 and actual["longitude"] == 117
    assert actual["enabled"] == 1


def test_relocation_refreshes_quality_and_provenance(client, monkeypatch):
    import json
    from backend import algorithms
    from backend.db import connect

    e = event(client)
    stations = []
    for i in range(3):
        s = client.post(
            "/api/stations",
            json={
                "network": "XX",
                "station": f"S{i}",
                "latitude": 35 + i * 0.1,
                "longitude": 117 - i * 0.1,
            },
        ).json()
        stations.append(s)
        for phase, seconds in [("Pg", 4 + i), ("Sg", 7 + i)]:
            client.post(
                f"/api/events/{e['id']}/picks",
                json={
                    "station_id": s["id"],
                    "phase": phase,
                    "time": f"2024-01-01T00:00:{seconds:02d}Z",
                    "reason": "fixture",
                },
            )
    with connect() as db:
        db.execute(
            "UPDATE events SET provenance=? WHERE id=?",
            (json.dumps({"qc": ["old quality"], "run": "original"}), e["id"]),
        )

    def locator(args, directory):
        algorithms.write_csv(
            directory / "located.csv",
            [
                {
                    "origin_time": "2024-01-01T00:00:00.123456Z",
                    "latitude": 35.1,
                    "longitude": 117.1,
                    "depth_km": 0,
                    "rms": 0.2,
                }
            ],
        )

    monkeypatch.setattr(algorithms, "run_skill", locator)
    result = algorithms.relocate(
        "relocation-test",
        {"event_id": e["id"], "vp": 6.2, "vs": 3.5, "velocity_name": "test-region"},
        lambda message: None,
    )
    actual = client.get(f"/api/events/{e['id']}").json()
    assert actual["version"] == 8 and actual["status"] == "candidate"
    assert actual["velocity_model"] == "test-region" and actual["rms"] == 0.2
    assert result["location"]["updated_at"] == actual["updated_at"]
    provenance = (
        json.loads(actual["provenance"])
        if isinstance(actual["provenance"], str)
        else actual["provenance"]
    )
    assert (
        provenance["relocation_run"] == "relocation-test"
        and provenance["run"] == "original"
    )
    assert (
        "深度位于搜索边界" in provenance["qc"] and "old quality" not in provenance["qc"]
    )


def test_edge_api_auth_and_cloud_secrets_are_never_exposed(client, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "test-secret")
    monkeypatch.setattr(settings, "cloud_llm_api_key", "cloud-private-key")
    monkeypatch.setattr(settings, "cloud_llm_base_url", "https://example.invalid/v1")
    monkeypatch.setattr(settings, "cloud_llm_model", "large-model")
    assert client.get("/api/edge/status").status_code == 200
    headers = {"Authorization": "Bearer test-secret"}
    edge = client.get("/api/edge/status", headers=headers)
    assert edge.status_code == 200 and edge.json()["recent_picks"] == []
    response = client.get("/api/settings", headers=headers)
    assert "cloud-private-key" not in response.text
    assert "test-secret" not in response.text
    assert "large-model" in response.text


def test_cloud_model_routing_and_small_model_budget(client, monkeypatch):
    from backend import analysis

    monkeypatch.setattr(settings, "edge_enabled", True)
    monkeypatch.setattr(settings, "cloud_llm_base_url", "https://example.invalid/v1")
    monkeypatch.setattr(settings, "cloud_llm_model", "cloud-model")
    monkeypatch.setattr(settings, "cloud_llm_api_key", "test-only-key")
    requests = []

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": "test answer"}}]}

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, url, **kwargs):
            requests.append((url, kwargs))
            return Response()

    monkeypatch.setattr(analysis.httpx, "Client", Client)
    response = client.post("/api/analysis", json={"use_llm": True, "provider": "cloud"})
    assert response.status_code == 200
    assert requests[0][0] == "https://example.invalid/v1/chat/completions"
    assert requests[0][1]["json"]["model"] == "cloud-model"
    assert requests[0][1]["headers"]["Authorization"] == "Bearer test-only-key"
    assert response.json()["total_budget"] < 8000
    messages, bound, output = analysis.build_messages(
        analysis.summarize(7, "all"), "检查目录质量", "local"
    )
    assert output <= 1024 and bound + output < 8000
    assert "high_rms_event_count_above_1s" not in messages[1]["content"]
