"""Bounded, shared local-model reports for the public catalogue assistant."""

import asyncio
import time
import logging
from collections import OrderedDict
from .analysis import analyze
from .schemas import AnalysisInput
from .db import now
from .runtime_settings import refresh

REPORT_QUESTION = "分析当前目录的质量、震级分布与地震活动性变化。"
REPORT_DAYS = {1, 7, 30, 3650}
REPORT_SOURCES = {"all", "USGS", "CENC", "SeismicX", "manual"}


class CatalogReports:
    def __init__(self):
        self.entries = OrderedDict()
        self.queue = asyncio.Queue(maxsize=3)
        self.pending = set()
        self.last_start = -60.0
        self.worker = None

    def start(self):
        self.worker = asyncio.create_task(self.run())

    async def stop(self):
        self.worker.cancel()
        await asyncio.gather(self.worker, return_exceptions=True)

    def get(self, days, source, prepare=False):
        key = (days, source)
        entry = self.entries.get(key)
        if entry and (key in self.pending or entry["expires"] > time.monotonic()):
            return entry["data"]
        if not prepare:
            return {"status": "idle"}
        if self.queue.full():
            return {"status": "deferred", "message": "本地模型任务较多，稍后重试"}
        data = {"status": "queued", "message": "已排队，等待本地模型生成目录报告"}
        self.pending.add(key)
        self.entries[key] = {"expires": 0, "data": data}
        self.queue.put_nowait(key)
        return data

    async def run(self):
        while True:
            key = await self.queue.get()
            try:
                await asyncio.sleep(max(0, 30 - (time.monotonic() - self.last_start)))
                self.entries[key]["data"] = {
                    "status": "building",
                    "message": "本地小模型分析中，与震相检测共享 NPU",
                }
                self.last_start = time.monotonic()
                refresh()
                report = await analyze(
                    AnalysisInput(
                        days=key[0],
                        source=key[1],
                        use_llm=True,
                        provider="local",
                        question=REPORT_QUESTION,
                    )
                )
                self.entries[key] = {
                    "expires": time.monotonic() + 300,
                    "data": {
                        "status": "ready",
                        "generated_at": now(),
                        "report": report,
                    },
                }
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger(__name__).exception("Local catalog report failed")
                self.entries[key] = {
                    "expires": time.monotonic() + 30,
                    "data": {
                        "status": "failed",
                        "message": "本地模型暂不可用，请稍后重试；目录统计仍可查看",
                    },
                }
            finally:
                self.pending.discard(key)
                self.queue.task_done()
                # There are only 20 allowed keys; completed entries may be evicted.
                while len(self.entries) > 20:
                    old = next((k for k in self.entries if k not in self.pending), None)
                    if old is None:
                        break
                    del self.entries[old]
