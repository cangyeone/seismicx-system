import asyncio
import json
from datetime import datetime, timedelta, timezone
import pytest
from fastapi.testclient import TestClient
from backend.config import settings
from backend.db import init_db, connect, rows, state, now
from backend.broadcast_feeds import (
    cenc_record,
    observe_events,
    feed,
    sync_cenc,
    same_event,
)
from backend.broadcast_context import messages_for, decode_brief
from backend.broadcast import BroadcastService, fingerprint, cached
from backend.app import app


@pytest.fixture
def database(tmp_path, monkeypatch):
    for key, value in settings.model_dump().items():
        monkeypatch.setattr(settings, key, value)
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "auto_sync", False)
    monkeypatch.setattr(settings, "api_token", "")
    monkeypatch.setattr(settings, "broadcast_relay_url", "")
    init_db()


def insert(eid="usgs:one", source="USGS", seconds=0, lon=110):
    event = {
        "id": eid,
        "origin_time": (datetime.now(timezone.utc) - timedelta(seconds=seconds))
        .isoformat()
        .replace("+00:00", "Z"),
        "latitude": 30,
        "longitude": lon,
        "depth_km": 10,
        "magnitude": 4.5,
        "magnitude_type": "M",
        "place": "test event",
        "source": source,
        "status": "external",
        "updated_at": now(),
    }
    with connect() as db:
        db.execute(
            f"INSERT INTO events({','.join(event)}) VALUES ({','.join('?' for _ in event)})",
            list(event.values()),
        )
    return event


def test_cenc_beijing_time_and_manual_review_preserved(database, monkeypatch):
    record = {
        "id": "CD.1",
        "time": "2026-10-02 03:04:05",
        "latitude": 38.5,
        "longitude": 114.2,
        "depth": 8,
        "magnitude": 2,
        "location": "河北",
    }
    assert cenc_record(record)["origin_time"] == "2026-10-01T19:04:05Z"

    class Response:
        def json(self):
            return [record, {"bad": True}]

    monkeypatch.setattr("backend.broadcast_feeds.get", lambda *a, **kw: Response())
    assert sync_cenc()["skipped"] == 1
    with connect() as db:
        db.execute(
            "UPDATE events SET magnitude=3,status='reviewed',version=2 WHERE id='cenc:CD.1'"
        )
    sync_cenc()
    assert rows("SELECT * FROM events")[0]["magnitude"] == 3
    with pytest.raises(ValueError):
        cenc_record({**record, "latitude": float("nan")})


def test_notices_baseline_restart_revisions_and_late_history(database):
    insert()
    observe_events(True)
    assert not feed(0)["notices"]
    insert("usgs:two", seconds=10, lon=140)
    observe_events()
    assert [x["id"] for x in feed(0)["notices"]] == ["usgs:two"]
    cursor = feed()["cursor"]
    with connect() as db:
        db.execute("UPDATE events SET magnitude=5,version=2 WHERE id='usgs:two'")
    observe_events(True)
    observe_events()
    insert("usgs:old", seconds=86400)
    insert("manual:recent", source="manual")
    observe_events()
    assert not feed(cursor)["notices"]
    assert len(feed(0)["notices"]) == 1
    # First ever China import is baseline, not hundreds of breaking reports.
    insert("cenc:first", source="CENC", lon=50)
    observe_events()
    assert len(feed(0)["notices"]) == 1
    insert("cenc:new", source="CENC", lon=60)
    observe_events()
    assert len(feed(cursor)["notices"]) == 1


def test_cross_source_dedup_keeps_original_catalog_and_handles_dateline(database):
    state("broadcast:source:USGS", True)
    state("broadcast:source:CENC", True)
    a = insert(lon=179.9)
    b = insert("cenc:same", "CENC", seconds=1, lon=-179.9)
    assert same_event(a, b)
    observe_events()
    assert len(feed(0)["notices"]) == 1
    assert len(feed()["events"]) == 1
    assert feed()["events"][0]["alternate_reports"][0]["source"] == "CENC"
    assert len(rows("SELECT * FROM events")) == 2


def test_grounded_model_budget_and_json_validation(database):
    e = insert()
    ctx = {
        "geology": "区域板块背景，不认定断层",
        "local_context": "文" * 10000,
        "science": "P波比S波快",
    }
    msgs, bound, output = messages_for(e, ctx)
    assert bound + output < 8000
    assert "网页文字" in msgs[0]["content"]
    assert (
        decode_brief(
            '```json\n{"analysis":"已知事实","geology":"区域背景","science":"科普"}\n```'
        )["analysis"]
        == "已知事实"
    )
    with pytest.raises(ValueError):
        decode_brief("只有一段不完整的回答")
    with pytest.raises(ValueError):
        decode_brief('{"analysis":"", "geology":"", "science":""}')
    revised = {**e, "magnitude": 5}
    assert fingerprint(e) != fingerprint(revised)


def test_bounded_queues_auth_and_real_async_worker(database, monkeypatch):
    event = insert()

    async def research(e):
        return {
            "geology": "无资料",
            "local_context": "",
            "science": "P波",
            "sources": [],
        }

    async def complete(*args):
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "analysis": "事实",
                                "geology": "未知",
                                "science": "波速不同",
                            }
                        )
                    }
                }
            ]
        }, "test-local"

    monkeypatch.setattr("backend.broadcast.research", research)
    monkeypatch.setattr("backend.broadcast.complete", complete)
    monkeypatch.setattr(
        "backend.broadcast.wave_bundle",
        lambda e: {"status": "unavailable", "waves": [], "errors": ["no real data"]},
    )
    with TestClient(app) as client:
        assert client.get("/api/broadcast/events/missing/brief").status_code == 404
        assert (
            client.get("/api/broadcast/events/usgs:one/brief").json()["status"]
            == "idle"
        )
        client.post("/api/broadcast/events/usgs:one/brief")
        client.post("/api/broadcast/events/usgs:one/waves")
        import time

        until = time.time() + 3
        while time.time() < until:
            result = client.get("/api/broadcast/events/usgs:one/brief").json()
            wave = client.get("/api/broadcast/events/usgs:one/waves").json()
            if result["status"] == "ready" and wave["status"] == "unavailable":
                break
            time.sleep(0.02)
        assert result["status"] == "ready" and result["provider"] == "local"
        assert wave["waves"] == []
        monkeypatch.setattr(settings, "api_token", "private-test")
        assert client.get("/api/broadcast/feed").status_code == 200
        assert client.post("/api/broadcast/events/usgs:one/brief").status_code == 200

    async def queues():
        service = BroadcastService()
        for i in range(8):
            await service.brief({**event, "id": str(i)}, True)
        assert (await service.brief({**event, "id": "overflow"}, True))[
            "status"
        ] == "deferred"
        assert service.ai_queue.qsize() == 8

    asyncio.run(queues())


def test_concurrent_metadata_transactions_do_not_deadlock(database):
    from concurrent.futures import ThreadPoolExecutor

    def write(i):
        state("concurrent:" + str(i), {"value": i})
        return state("concurrent:" + str(i))["value"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(write, i) for i in range(96)]
        assert [f.result(timeout=5) for f in futures] == list(range(96))


def test_science_topics_are_distinct_persistent_and_bounded(database):
    from backend.broadcast_context import science_for, SCIENCE

    events = [{"id": f"topic:{i}"} for i in range(12)]
    topics = [science_for(e)[0] for e in events]
    assert len(set(topics)) == len(SCIENCE) == 12
    assert [science_for(e)[0] for e in reversed(events)] == list(reversed(topics))
    # Revising a magnitude keeps the selected educational topic.
    assert science_for({**events[0], "magnitude": 7})[0] == topics[0]
    for i in range(12, 215):
        science_for({"id": f"topic:{i}"})
    with connect() as db:
        stored = json.loads(
            db.execute(
                "SELECT value FROM state WHERE key='broadcast:science-topics:v2'"
            ).fetchone()[0]
        )
    assert len(stored) == 200
    assert len({item[1] for item in stored[-12:]}) == 12


def test_science_citation_is_not_replaced_by_regional_web_result(database, monkeypatch):
    from backend.broadcast_context import research, science_for

    event = insert()
    expected_url = science_for(event)[2]

    async def web_json(client, url, params=None):
        if "usgs.gov" in url:
            return {"features": []}
        return {
            "query": {
                "pages": {
                    "1": {
                        "title": "Example island",
                        "extract": "An island with mountainous geology.",
                        "fullurl": "https://en.wikipedia.org/wiki/Example",
                    }
                }
            }
        }

    monkeypatch.setattr("backend.broadcast_context.web_json", web_json)
    context = asyncio.run(research(event))
    science_source = next(
        source for source in context["sources"] if source["kind"] == "science"
    )
    assert science_source["url"] == expected_url
    assert any(
        source["url"].startswith("https://en.wikipedia.org")
        for source in context["sources"]
    )


def test_broadcast_model_switch_separates_cache_and_skips_obsolete_queue(
    database, monkeypatch
):
    from backend.broadcast import model_profile, brief_key, save
    from backend.runtime_settings import (
        RuntimeConfig,
        UpdateConfig,
        save as save_settings,
    )

    event = insert()
    config = RuntimeConfig()
    config.system.broadcast_llm_provider = "local"
    config.system.cloud_llm_base_url = "https://model.example/v1"
    config.system.cloud_llm_model = "cloud-test"
    save_settings(UpdateConfig(revision=0, config=config), "test-admin")
    local_key = brief_key(event, model_profile())
    save(
        local_key, {"status": "ready", "provider": "local", "analysis": "local cached"}
    )
    calls = []

    async def research(e):
        return {
            "geology": "区域背景",
            "local_context": "",
            "science": "P波",
            "science_title": "P 波与 S 波",
            "sources": [],
        }

    async def complete(messages, output, provider):
        calls.append(provider)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "analysis": "online facts",
                                "geology": "regional facts",
                                "science": "P wave facts",
                            }
                        )
                    }
                }
            ]
        }, "cloud-test"

    monkeypatch.setattr("backend.broadcast.research", research)
    monkeypatch.setattr("backend.broadcast.complete", complete)

    async def run():
        service = BroadcastService()
        assert (await service.brief(event))["analysis"] == "local cached"
        await service.brief({**event, "id": "obsolete-local"}, True)
        config.system.broadcast_llm_provider = "cloud"
        save_settings(UpdateConfig(revision=1, config=config), "test-admin")
        assert brief_key(event, model_profile()) != local_key
        assert (await service.brief(event))["status"] == "idle"
        service.start()
        await service.brief(event, True)
        await asyncio.wait_for(service.ai_queue.join(), 3)
        result = await service.brief(event)
        assert result["provider"] == "cloud" and result["model"] == "cloud-test"
        assert result["total_budget"] < 8000
        assert calls == ["cloud"]
        assert cached(local_key)["analysis"] == "local cached"
        assert "endpoint" not in result and "api_key" not in json.dumps(result)
        await service.stop()

    asyncio.run(run())


def test_public_notices_and_playlist_include_later_events_and_parameter_revisions(
    database,
):
    a = insert()
    observe_events(True)
    initial = feed()
    b = insert("usgs:later", seconds=-1, lon=140)
    observe_events()
    updated = feed(initial["cursor"])
    assert updated["events"][0]["id"] == b["id"]
    assert updated["notices"][0]["id"] == b["id"]
    with connect() as db:
        db.execute("UPDATE events SET magnitude=5.2,version=2 WHERE id=?", (b["id"],))
    observe_events()
    revised = feed(updated["cursor"])
    assert revised["events"][0]["magnitude"] == 5.2
    assert not revised["notices"]
