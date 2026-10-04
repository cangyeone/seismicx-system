import asyncio
import numpy as np
import pytest
from obspy import Stream, Trace, UTCDateTime
from fastapi.testclient import TestClient
from backend.app import app
from backend.config import settings
from backend.db import init_db
from backend.auth import bootstrap


@pytest.fixture
def client(tmp_path, monkeypatch):
    for k, v in settings.model_dump().items():
        monkeypatch.setattr(settings, k, v)
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "auto_sync", False)
    monkeypatch.setattr(settings, "broadcast_relay_url", "")
    monkeypatch.setattr(settings, "model_relay_key", "test-server-key")
    init_db()
    bootstrap("test-admin", "test-password")
    with TestClient(app) as c:
        session = c.post(
            "/api/auth/login",
            json={"username": "test-admin", "password": "test-password"},
        ).json()
        c.headers["X-CSRF-Token"] = session["csrf"]
        yield c


def test_wave_zoom_returns_real_samples_and_clips_to_window(client, tmp_path):
    from backend.sources import register_waveform

    s = client.post(
        "/api/stations",
        json={"network": "XX", "station": "TEST", "latitude": 35, "longitude": 117},
    ).json()
    traces = []
    for channel in ["BHZ", "BHN", "BHE"]:
        t = Trace(np.arange(12000, dtype=np.int32))
        t.stats.update(
            dict(
                network="XX",
                station="TEST",
                location="",
                channel=channel,
                starttime=UTCDateTime("2026-01-01"),
                sampling_rate=100,
            )
        )
        traces.append(t)
    stream = Stream(traces)
    path = tmp_path / "wave.mseed"
    stream.write(str(path), format="MSEED")
    register_waveform(path, stream, s["id"], "test", False)
    base = f"/api/waveforms/{s['id']}"
    wide = client.get(
        base, params={"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T00:02:00Z"}
    ).json()
    assert wide["traces"][0]["sample_stride"] == 10
    tight = client.get(
        base,
        params={
            "start": "2026-01-01T00:00:20Z",
            "end": "2026-01-01T00:00:21Z",
            "points": 6000,
        },
    ).json()
    assert len(tight["traces"]) == 3
    t = tight["traces"][0]
    assert t["sample_stride"] == 1 and t["points"][0] == [0.0, 2000.0, 2000.0]
    assert t["points"][-1] == [1.0, 2100.0, 2100.0]
    assert (
        client.get(
            base,
            params={
                "start": "2026-01-01T00:00:20Z",
                "end": "2026-01-01T00:00:21Z",
                "points": 999999,
            },
        ).status_code
        == 422
    )


def test_all_six_phases_can_be_adjusted_deleted_and_versioned(client):
    e = client.post(
        "/api/events",
        json={
            "origin_time": "2026-01-01T00:00:00Z",
            "latitude": 35,
            "longitude": 117,
            "depth_km": 10,
        },
    ).json()
    s = client.post(
        "/api/stations",
        json={"network": "XX", "station": "TEST", "latitude": 35, "longitude": 117},
    ).json()
    for i, phase in enumerate(["Pg", "Sg", "Pn", "Sn", "P", "S"]):
        data = {
            "station_id": s["id"],
            "phase": phase,
            "time": f"2026-01-01T00:00:{i + 1:02d}.010Z",
            "reason": "人工波形复核",
        }
        r = client.post(f"/api/events/{e['id']}/picks", json=data)
        assert r.status_code == 200
        pid = r.json()["id"]
        data.update(time=f"2026-01-01T00:00:{i + 1:02d}.020Z", version=1)
        assert client.patch(f"/api/picks/{pid}", json=data).status_code == 200
        assert client.patch(f"/api/picks/{pid}", json=data).status_code == 409
        assert (
            client.delete(f"/api/picks/{pid}?version=1&reason=复核删除").status_code
            == 409
        )
        assert (
            client.delete(f"/api/picks/{pid}?version=2&reason=复核删除").status_code
            == 200
        )
    d = client.get(f"/api/events/{e['id']}").json()
    assert d["n_picks"] == 0 and d["status"] == "candidate"


def test_public_reports_are_local_deduplicated_and_allowlisted(client, monkeypatch):
    import backend.catalog_reports as reports

    calls = []

    async def fake(data):
        calls.append(data.model_dump())
        return {
            "mode": "llm",
            "text": "## 目录质量\n真实统计",
            "statistics": {"count": 1},
            "model": "local-test",
        }

    monkeypatch.setattr(reports, "analyze", fake)
    client.cookies.clear()
    client.headers.pop("X-CSRF-Token", None)
    assert client.post("/api/analysis/report?days=2").status_code == 422
    assert client.post("/api/analysis/report?source=bad").status_code == 422
    client.post("/api/analysis/report?days=7")
    import time

    for _ in range(50):
        r = client.get("/api/analysis/report?days=7").json()
        if r["status"] == "ready":
            break
        time.sleep(0.01)
    assert r["report"]["text"].startswith("##")
    assert client.post("/api/analysis/report?days=7").json()["status"] == "ready"
    assert len(calls) == 1 and calls[0]["provider"] == "local"
    assert (
        client.post(
            "/api/analysis", json={"use_llm": True, "question": "custom"}
        ).status_code
        == 401
    )


def test_relay_requires_server_secret_and_enforces_budget(client, monkeypatch):
    import backend.analysis as analysis

    monkeypatch.setattr(settings, "edge_enabled", True)
    calls = []

    async def fake(messages, output, provider, **kwargs):
        calls.append((messages, output, provider, kwargs))
        return {"choices": [{"message": {"content": "## Report"}}]}, "qwen-test"

    monkeypatch.setattr(analysis, "complete", fake)
    client.cookies.clear()
    client.headers.pop("X-CSRF-Token", None)
    payload = {
        "messages": [
            {"role": "system", "content": "Summarize"},
            {"role": "user", "content": "facts"},
        ],
        "output": 512,
    }
    assert client.post("/api/internal/llm", json=payload).status_code == 401
    assert (
        client.post(
            "/api/internal/llm", json=payload, headers={"X-SeismicX-Relay": "wrong"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/internal/llm",
            json=payload,
            headers={"X-SeismicX-Relay": "test-server-key"},
        ).json()["model"]
        == "qwen-test"
    )
    assert calls[0][2:] == ("local", {"allow_relay": False})
    payload["messages"][1]["content"] = "震" * 4000
    assert (
        client.post(
            "/api/internal/llm",
            json=payload,
            headers={"X-SeismicX-Relay": "test-server-key"},
        ).status_code
        == 422
    )


def test_report_queue_is_bounded_without_dropping_active_entries():
    from backend.catalog_reports import CatalogReports

    service = CatalogReports()
    for days in [1, 7, 30]:
        assert service.get(days, "all", True)["status"] == "queued"
    assert service.get(3650, "all", True)["status"] == "deferred"
    assert service.get(1, "all", True)["status"] == "queued"
    assert service.queue.qsize() == 3


def test_workstation_relay_forwards_own_summary_with_server_credential(monkeypatch):
    import httpx
    import backend.analysis as analysis

    monkeypatch.setattr(settings, "edge_enabled", False)
    monkeypatch.setattr(settings, "broadcast_relay_url", "http://board.test:5012")
    monkeypatch.setattr(settings, "model_relay_key", "private-relay-test-key")
    messages = [
        {"role": "system", "content": "Markdown"},
        {"role": "user", "content": "workstation catalog count=17"},
    ]
    calls = []

    def handle(request):
        import json

        calls.append(
            (
                str(request.url),
                request.headers["x-seismicx-relay"],
                json.loads(request.content),
            )
        )
        return httpx.Response(
            200,
            json={
                "payload": {"choices": [{"message": {"content": "## 17"}}]},
                "model": "board-qwen",
            },
        )

    original = httpx.AsyncClient
    monkeypatch.setattr(
        analysis.httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    payload, model = asyncio.run(analysis.complete(messages, 512, "local"))
    assert (
        model == "board-qwen" and payload["choices"][0]["message"]["content"] == "## 17"
    )
    assert calls == [
        (
            "http://board.test:5012/api/internal/llm",
            "private-relay-test-key",
            {"messages": messages, "output": 512},
        )
    ]
    monkeypatch.setattr(settings, "model_relay_key", "")
    with pytest.raises(ValueError, match="服务端凭据"):
        asyncio.run(analysis.complete(messages, 512, "local"))
    assert len(calls) == 1


def test_model_receives_precomputed_counts_not_unverified_daily_trends(client):
    import json
    from backend.analysis import summarize, build_messages

    summary = summarize(7, "all")
    summary["daily"] = [{"date": "2026-01-01", "count": 500}]
    summary["magnitude_histogram"] = [
        {"magnitude": 3.5, "count": 5},
        {"magnitude": 4.0, "count": 7},
        {"magnitude": 5.0, "count": 3},
    ]
    messages, bound, output = build_messages(summary, "分析目录")
    facts = json.loads(messages[1]["content"])["statistics"]
    assert "daily" not in facts and "magnitude_histogram" not in facts
    assert "M≥4的记录数为10" in facts["distribution_facts"][0]
    assert "M≥5的记录数为3" in facts["distribution_facts"][1]
    assert "280" in messages[0]["content"] and bound + output < 8000
    assert summary["daily"][0]["count"] == 500  # charts retain observed records


def test_report_surfaces_truncation_and_actual_relay_output_limit(client, monkeypatch):
    import backend.analysis as analysis
    from backend.schemas import AnalysisInput

    async def fake(*args, **kwargs):
        return {
            "choices": [
                {"message": {"content": "## 目录质量"}, "finish_reason": "stop"}
            ],
            "usage": {"completion_tokens": 256},
            "_seismicx_output_limit": 256,
        }, "test"

    monkeypatch.setattr(analysis, "complete", fake)
    result = asyncio.run(analysis.analyze(AnalysisInput(use_llm=True)))
    assert result["truncated"] is True
    assert result["max_output_tokens"] == 256
    assert result["total_budget"] == result["input_token_upper_bound"] + 256
