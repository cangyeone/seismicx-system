"""Versioned settings shared by API, catalogue worker and continuous NPU worker."""

import json
import math
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from fastapi import HTTPException
from .config import settings
from .db import connect, state, audit, now


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Phase(StrictModel):
    p_threshold: float = Field(0.35, ge=0.1, le=1)
    s_threshold: float = Field(0.35, ge=0.1, le=1)


class Association(StrictModel):
    search_radius_deg: float = Field(0.5, ge=0.1, le=2)
    max_depth_km: float = Field(20, ge=2, le=100)
    grid_spacing_deg: float = Field(0.05, ge=0.02, le=0.5)
    depth_spacing_km: float = Field(2, ge=1, le=20)
    event_window_s: float = Field(5, ge=1, le=30)
    max_azimuth_gap_deg: float = Field(360, ge=90, le=360)
    min_p: int = Field(3, ge=1, le=32)
    min_s: int = Field(2, ge=0, le=32)
    min_total: int = Field(5, ge=4, le=64)
    min_both: int = Field(2, ge=0, le=32)
    max_origin_std_s: float = Field(0.5, ge=0.05, le=5)
    min_ps_separation_s: float = Field(0.1, ge=0, le=10)
    window_multiplier: float = Field(1.5, ge=0.5, le=5)
    jobs: int = Field(2, ge=1, le=4)

    @model_validator(mode="after")
    def coherent(self):
        if self.min_total < max(self.min_p + self.min_s, 2 * self.min_both):
            raise ValueError("总震相数须不小于 P+S 最少数及双震相台站数的两倍")
        nodes = (
            2 * math.ceil(self.search_radius_deg / self.grid_spacing_deg) + 1
        ) ** 2 * (math.ceil(self.max_depth_km / self.depth_spacing_km) + 1)
        if nodes > 50000:
            raise ValueError("关联搜索网格超过 50000 点，请增大步长或缩小搜索范围")
        return self


class Location(StrictModel):
    vp: float = Field(6.2, ge=3, le=9)
    vs: float = Field(3.5, ge=1.5, le=5)
    velocity_name: str = Field(
        "homogeneous-regional-baseline", min_length=1, max_length=100
    )
    min_picks: int = Field(4, ge=4, le=64)
    min_depth: float = Field(0, ge=0, le=99)
    max_depth: float = Field(30, ge=1, le=100)
    pad_degree: float = Field(0.2, ge=0.01, le=2)
    grid_lat: int = Field(15, ge=5, le=41)
    grid_lon: int = Field(15, ge=5, le=41)
    grid_depth: int = Field(9, ge=3, le=31)
    origin_time_pad: float = Field(30, ge=5, le=120)

    @model_validator(mode="after")
    def coherent(self):
        if self.vs >= self.vp:
            raise ValueError("Vs 必须小于 Vp")
        if self.min_depth >= self.max_depth:
            raise ValueError("最大深度必须大于最小深度")
        if self.grid_lat * self.grid_lon * self.grid_depth > 30000:
            raise ValueError("定位网格超过 30000 点，请减少网格数")
        return self


class System(StrictModel):
    platform_name: str = Field(
        default_factory=lambda: settings.platform_name, min_length=1, max_length=80
    )
    catalog_poll_seconds: int = Field(
        default_factory=lambda: settings.catalog_poll_seconds, ge=30, le=600
    )
    broadcast_ai_interval_seconds: int = Field(
        default_factory=lambda: settings.broadcast_ai_interval_seconds, ge=30, le=600
    )
    edge_interval_seconds: int = Field(
        default_factory=lambda: settings.edge_interval_seconds, ge=30, le=600
    )
    edge_window_seconds: int = Field(
        default_factory=lambda: settings.edge_window_seconds, ge=120, le=600
    )
    edge_max_input_lag_seconds: int = Field(
        default_factory=lambda: settings.edge_max_input_lag_seconds, ge=30, le=600
    )
    edge_max_stations: int = Field(
        default_factory=lambda: settings.edge_max_stations, ge=3, le=1024
    )
    edge_input_delay_seconds: int = Field(
        default_factory=lambda: settings.edge_input_delay_seconds, ge=5, le=120
    )
    broadcast_llm_provider: Literal["local", "cloud"] = Field(
        default_factory=lambda: settings.broadcast_llm_provider
    )
    llm_base_url: str = Field(
        default_factory=lambda: settings.llm_base_url, max_length=300
    )
    llm_model: str = Field(
        default_factory=lambda: settings.llm_model, min_length=1, max_length=100
    )
    llm_context_tokens: int = Field(
        default_factory=lambda: settings.llm_context_tokens, ge=2048, le=7900
    )
    llm_output_tokens: int = Field(
        default_factory=lambda: settings.llm_output_tokens, ge=256, le=1400
    )
    cloud_llm_base_url: str = Field(
        default_factory=lambda: settings.cloud_llm_base_url, max_length=300
    )
    cloud_llm_model: str = Field(
        default_factory=lambda: settings.cloud_llm_model, max_length=100
    )

    @model_validator(mode="after")
    def coherent(self):
        from urllib.parse import urlsplit

        for value in (self.llm_base_url, self.cloud_llm_base_url):
            if not value:
                continue
            parsed = urlsplit(value)
            if (
                parsed.scheme not in ("http", "https")
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("模型接口必须是无账号、密码及查询参数的 HTTP(S) URL")
        if self.broadcast_llm_provider == "cloud" and (
            not self.cloud_llm_base_url.strip() or not self.cloud_llm_model.strip()
        ):
            raise ValueError("选择在线演播模型前，请填写在线模型接口和名称")
        if self.edge_interval_seconds > self.edge_window_seconds - 30:
            raise ValueError("推理窗口必须至少比周期长 30 秒，以保持连续覆盖")
        if self.llm_output_tokens > self.llm_context_tokens // 2:
            raise ValueError("模型输出预算不能超过上下文的一半")
        return self


class RuntimeConfig(StrictModel):
    phase: Phase = Field(default_factory=Phase)
    association: Association = Field(default_factory=Association)
    location: Location = Field(default_factory=Location)
    system: System = Field(default_factory=System)


class UpdateConfig(StrictModel):
    revision: int = Field(ge=0)
    config: RuntimeConfig


def snapshot():
    stored = state("runtime:configuration")
    if stored:
        # Older saved configurations acquire new fields without changing their revision.
        return {
            **stored,
            "config": RuntimeConfig.model_validate(stored["config"]).model_dump(),
        }
    return {"revision": 0, "config": RuntimeConfig().model_dump(), "updated_at": None}


def refresh():
    result = snapshot()
    for key, value in result["config"]["system"].items():
        setattr(settings, key, value)
    return result


def save(data: UpdateConfig, username):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        found = db.execute(
            "SELECT value FROM state WHERE key='runtime:configuration'"
        ).fetchone()
        old = (
            json.loads(found[0])
            if found
            else {"revision": 0, "config": RuntimeConfig().model_dump()}
        )
        if old["revision"] != data.revision:
            raise HTTPException(409, "配置已被其他会话修改，请重新载入后保存")
        result = {
            "revision": old["revision"] + 1,
            "config": data.config.model_dump(),
            "updated_at": now(),
        }
        db.execute(
            "INSERT OR REPLACE INTO state VALUES ('runtime:configuration',?)",
            (json.dumps(result),),
        )
        audit(db, "settings", "runtime", old, result, "后台配置更新：" + username)
    refresh()
    return result


def task_config(data):
    result = dict(data)
    snap = result.get("_configuration") or snapshot()
    result["_configuration"] = snap
    loc, phase = snap["config"]["location"], snap["config"]["phase"]
    for key in ("vp", "vs", "velocity_name"):
        result.setdefault(key, loc[key])
    # A per-job lower bound can tighten the independent P/S thresholds.
    result.setdefault("min_score", min(phase.values()))
    Location.model_validate(
        {**loc, **{k: result[k] for k in ("vp", "vs", "velocity_name")}}
    )
    return result


def accepts_pick(pick, data):
    phase = data["_configuration"]["config"]["phase"]
    threshold = phase[
        "p_threshold" if pick["phase"].upper().startswith("P") else "s_threshold"
    ]
    return float(pick.get("score") or 0) >= max(threshold, data.get("min_score", 0.1))


def association_args(data):
    a = data["_configuration"]["config"]["association"]
    r = [
        a[k]
        for k in (
            "search_radius_deg",
            "max_depth_km",
            "grid_spacing_deg",
            "depth_spacing_km",
            "event_window_s",
            "max_azimuth_gap_deg",
        )
    ]
    s = [
        a[k]
        for k in (
            "min_p",
            "min_s",
            "min_total",
            "min_both",
            "max_origin_std_s",
            "min_ps_separation_s",
            "window_multiplier",
        )
    ]
    return [
        "--real-R",
        "/".join(map(str, r)),
        "--real-S",
        "/".join(map(str, s)),
        "--real-jobs",
        str(a["jobs"]),
    ]


def location_args(data):
    loc = data["_configuration"]["config"]["location"]
    return [
        arg
        for key in (
            "min_picks",
            "min_depth",
            "max_depth",
            "pad_degree",
            "grid_lat",
            "grid_lon",
            "grid_depth",
            "origin_time_pad",
        )
        for arg in ("--" + key.replace("_", "-"), str(loc[key]))
    ]
