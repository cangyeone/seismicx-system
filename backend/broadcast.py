"""Bounded broadcast preparation. API reads stay responsive during NPU inference."""

import asyncio
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone
import httpx
from .config import settings
from .db import rows, one, connect, now
from .broadcast_feeds import distance
from .broadcast_context import research, messages_for, decode_brief
from .analysis import complete
from .runtime_settings import refresh


def fingerprint(event):
    fields = {
        k: event.get(k)
        for k in (
            "id",
            "origin_time",
            "latitude",
            "longitude",
            "depth_km",
            "magnitude",
            "magnitude_type",
            "place",
            "source",
            "status",
            "version",
        )
    }
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()[:24]


def model_profile():
    refresh()
    provider = settings.broadcast_llm_provider
    return {
        "provider": provider,
        "model": settings.cloud_llm_model
        if provider == "cloud"
        else settings.llm_model,
        "endpoint": settings.cloud_llm_base_url
        if provider == "cloud"
        else settings.llm_base_url,
        "context": settings.llm_context_tokens,
        "output": settings.llm_output_tokens,
    }


def brief_key(event, profile):
    # Never expose endpoint configuration; different providers/models cannot share prose.
    stamp = hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest()[
        :16
    ]
    return "brief-v3:" + stamp + ":" + fingerprint(event)


def cached(key):
    item = one("SELECT payload FROM broadcast_cache WHERE cache_key=?", (key,))
    return json.loads(item["payload"]) if item else None


def save(key, payload):
    with connect() as db:
        db.execute(
            "INSERT OR REPLACE INTO broadcast_cache VALUES (?,?,?)",
            (key, json.dumps(payload, ensure_ascii=False), now()),
        )
    return payload


def wave_bundle(event):
    from .sources import waveforms_view
    from concurrent.futures import ThreadPoolExecutor, as_completed

    origin = datetime.fromisoformat(event["origin_time"].replace("Z", "+00:00"))
    start = (origin - timedelta(seconds=20)).isoformat().replace("+00:00", "Z")
    # Ten minutes includes many regional/teleseismic P arrivals. Far arrivals may fall outside.
    end_time = min(
        origin + timedelta(seconds=580),
        datetime.now(timezone.utc) - timedelta(seconds=25),
    )
    if end_time <= origin:
        return {
            "status": "pending",
            "waves": [],
            "errors": ["地震刚发生，等待震后波形到达"],
            "retry_at": time.time() + 60,
        }
    end = end_time.isoformat().replace("+00:00", "Z")
    stations = rows("SELECT * FROM stations")
    for station in stations:
        station["distance_km"] = distance(event, station)
    # Use geographically separated distance rows; do not pile up collocated channels.
    selected, seen = [], set()
    for station in sorted(stations, key=lambda s: s["distance_km"]):
        code = (station["network"], station["station"])
        if code not in seen:
            selected.append(station)
            seen.add(code)
        if len(selected) == 4:
            break
    waves, errors = [], []

    def fetch(station):
        wave = waveforms_view(station, start, end)
        wave["traces"] = [t for t in wave["traces"] if t["id"].endswith("Z")][:1]
        if not wave["traces"] or not any(
            p[1] is not None for p in wave["traces"][0]["points"]
        ):
            raise ValueError("该时段无可用垂直分量")
        return {**wave, "distance_km": station["distance_km"]}

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(fetch, s): s for s in selected}
        for future in as_completed(futures):
            station = futures[future]
            try:
                waves.append(future.result())
            except Exception:
                errors.append(station["id"] + "：公开源暂未提供该时段垂直分量")
    return {
        "status": "ready" if waves else "unavailable",
        "waves": sorted(waves, key=lambda w: w["distance_km"])[:3],
        "errors": errors,
        "start": start,
        "end": end,
        "origin_time": event["origin_time"],
        "fetched_at": now(),
        "retry_at": time.time()
        + (600 if not waves or (end_time - origin).total_seconds() < 580 else 86400),
        "note": "真实记录，按实际震中距与相对发震时间绘制；不表示已确认该事件震相。每道独立归一化，单位 counts。",
    }


class BroadcastService:
    def __init__(self):
        self.ai_queue = asyncio.Queue(maxsize=8)
        self.wave_queue = asyncio.Queue(maxsize=6)
        self.ai_pending = set()
        self.wave_pending = set()
        self.last_ai = 0.0
        self.tasks = []

    def start(self):
        self.tasks = [
            asyncio.create_task(self.ai_worker()),
            asyncio.create_task(self.wave_worker()),
        ]

    async def stop(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    async def brief(self, event, prepare=False):
        profile = model_profile()
        provider = profile["provider"]
        if provider == "local" and settings.broadcast_relay_url:
            # Local workstation reuses the box's grounded brief and shared NPU lock.
            try:
                async with httpx.AsyncClient(timeout=8, trust_env=False) as client:
                    result = await client.request(
                        "POST" if prepare else "GET",
                        settings.broadcast_relay_url.rstrip("/")
                        + "/api/broadcast/events/"
                        + event["id"]
                        + "/brief",
                    )
                    result.raise_for_status()
                    return result.json()
            except Exception:
                return {
                    "status": "unavailable",
                    "error": "开发板本地模型服务暂不可达；保留目录事实",
                    "provider": provider,
                }
        key = brief_key(event, profile)
        result = cached(key)
        if key in self.ai_pending:
            return result or {"status": "queued", "provider": provider}
        retry = not result or (
            result.get("status") == "unavailable"
            and result.get("retry_at", 0) < time.time()
        )
        if prepare and retry:
            try:
                self.ai_queue.put_nowait((key, dict(event), profile))
                self.ai_pending.add(key)
                return result or {"status": "queued", "provider": provider}
            except asyncio.QueueFull:
                return {
                    "status": "deferred",
                    "error": "解读队列已满，稍后重试",
                    "provider": provider,
                }
        # A process restart may leave a building status in the persistent cache.
        if prepare and result and result.get("status") == "building":
            with connect() as db:
                db.execute("DELETE FROM broadcast_cache WHERE cache_key=?", (key,))
            return await self.brief(event, True)
        return result or {"status": "idle", "provider": provider}

    def waves(self, event, prepare=False):
        key = "wave:" + fingerprint(event)
        result = cached(key)
        retry = not result or result.get("retry_at", 0) < time.time()
        if prepare and retry and key not in self.wave_pending:
            try:
                self.wave_queue.put_nowait((key, dict(event)))
                self.wave_pending.add(key)
            except asyncio.QueueFull:
                return result or {
                    "status": "deferred",
                    "waves": [],
                    "errors": ["波形准备队列已满"],
                }
        return result or {
            "status": "queued" if key in self.wave_pending else "idle",
            "waves": [],
            "errors": [],
        }

    async def ai_worker(self):
        while True:
            key, event, profile = await self.ai_queue.get()
            provider = profile["provider"]
            context = None
            try:
                if model_profile() != profile:
                    continue
                context = await research(event)
                save(
                    key,
                    {"status": "building", "context": context, "provider": provider},
                )
                delay = max(
                    0,
                    max(30, settings.broadcast_ai_interval_seconds)
                    - (time.monotonic() - self.last_ai),
                )
                await asyncio.sleep(delay)
                if model_profile() != profile:
                    continue
                messages, bound, output = messages_for(event, context)
                self.last_ai = time.monotonic()
                payload, model = await complete(messages, output, provider)
                prose = decode_brief(payload["choices"][0]["message"]["content"])
                save(
                    key,
                    {
                        "status": "ready",
                        "provider": provider,
                        "model": model,
                        **prose,
                        "context": context,
                        "input_token_upper_bound": bound,
                        "max_output_tokens": output,
                        "total_budget": bound + output,
                        "usage": payload.get("usage"),
                        "generated_at": now(),
                        "notice": "AI 辅助解读，请以目录事实与原始资料为准；不作地震预测。",
                    },
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                save(
                    key,
                    {
                        "status": "unavailable",
                        "provider": provider,
                        "context": context,
                        "error": (
                            "在线模型暂未生成有效解读"
                            if provider == "cloud"
                            else "本地模型暂未生成有效解读"
                        ),
                        "retry_at": time.time() + 300,
                        "generated_at": now(),
                    },
                )
                # Keep diagnostic classes, never endpoint credentials or response bodies.
                from .db import state

                state("broadcast:ai_error", {"type": type(exc).__name__, "at": now()})
            finally:
                self.ai_pending.discard(key)
                self.ai_queue.task_done()

    async def wave_worker(self):
        while True:
            key, event = await self.wave_queue.get()
            try:
                result = await asyncio.to_thread(wave_bundle, event)
                save(key, result)
            except asyncio.CancelledError:
                raise
            except Exception:
                save(
                    key,
                    {
                        "status": "unavailable",
                        "waves": [],
                        "errors": ["事件波形暂不可用"],
                        "retry_at": time.time() + 600,
                    },
                )
            finally:
                self.wave_pending.discard(key)
                self.wave_queue.task_done()
