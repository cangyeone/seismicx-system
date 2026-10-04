from datetime import datetime, timezone
import re
from typing import Literal
from pydantic import BaseModel, Field, field_validator, model_validator


def utc(value):
    # Python 3.10 accepts only 3/6 fractional digits; phase editors may send .2s.
    value = re.sub(
        r"(\d{2}:\d{2}:\d{2})\.(\d{1,6})(?=Z|[+-]|$)",
        lambda m: m[1] + "." + m[2].ljust(6, "0"),
        value,
    )
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("必须提供 UTC 或明确时区")
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class EventInput(BaseModel):
    origin_time: str
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    depth_km: float = Field(ge=0, le=800, allow_inf_nan=False)
    magnitude: float | None = Field(default=None, ge=-3, le=10, allow_inf_nan=False)
    magnitude_type: str = Field(default="ML", max_length=12)
    place: str = Field(default="人工录入地震", max_length=200)
    notes: str = Field(default="", max_length=2000)
    monitored: bool = True
    _utc = field_validator("origin_time")(utc)


class EventEdit(EventInput):
    version: int = Field(ge=1)
    status: Literal["candidate", "reviewed", "rejected", "external", "manual"] = (
        "reviewed"
    )
    reason: str = Field(min_length=2, max_length=500)


class StationInput(BaseModel):
    network: str = Field(pattern=r"^[A-Za-z0-9]{1,8}$")
    station: str = Field(pattern=r"^[A-Za-z0-9_-]{1,12}$")
    location: str = Field(default="", pattern=r"^[A-Za-z0-9]{0,2}$")
    channel: str = Field(default="BH?", pattern=r"^[A-Za-z0-9?*]{3}$")
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    elevation_m: float = Field(default=0, ge=-1000, le=10000)
    name: str = Field(default="", max_length=200)
    provider: Literal["EARTHSCOPE", "GEOFON", "SCEDC", "BGR", "INGV", "INFP"] = (
        "EARTHSCOPE"
    )
    enabled: bool = False


class PickInput(BaseModel):
    station_id: str = Field(min_length=3, max_length=40)
    phase: Literal["P", "S", "Pg", "Sg", "Pn", "Sn"]
    time: str
    reason: str = Field(min_length=2, max_length=500)
    version: int = Field(default=1, ge=1)
    _utc = field_validator("time")(utc)


class WindowInput(BaseModel):
    start: str
    end: str
    station_ids: list[str] = Field(min_length=1, max_length=32)
    event_id: str | None = None
    vp: float = Field(default=6.2, ge=3, le=9)
    vs: float = Field(default=3.5, ge=1.5, le=5)
    min_score: float = Field(default=0.35, ge=0.1, le=1)
    velocity_name: str = Field(
        default="homogeneous-regional-baseline", min_length=2, max_length=100
    )
    _utc = field_validator("start", "end")(utc)

    @model_validator(mode="after")
    def valid_window(self):
        seconds = (
            datetime.fromisoformat(self.end.replace("Z", "+00:00"))
            - datetime.fromisoformat(self.start.replace("Z", "+00:00"))
        ).total_seconds()
        if not 0 < seconds <= 1800:
            raise ValueError("单批时间窗必须在 0–1800 秒内；长时间监测请分批")
        if {"vp", "vs"} <= self.model_fields_set and self.vs >= self.vp:
            raise ValueError("Vs 必须小于 Vp")
        return self


class AnalysisInput(BaseModel):
    provider: Literal["local", "cloud"] = "local"
    question: str = Field(
        default="分析地震目录质量与活动性变化", min_length=2, max_length=1000
    )
    use_llm: bool = False
    days: int = Field(default=7, ge=1, le=3650)
    source: str = Field(default="all", max_length=40)


class ModelMessage(BaseModel):
    role: Literal["system", "user"]
    content: str = Field(max_length=7900)


class ModelRelayInput(BaseModel):
    messages: list[ModelMessage] = Field(min_length=2, max_length=2)
    output: int = Field(ge=1, le=1400)

    @model_validator(mode="after")
    def budget(self):
        if [m.role for m in self.messages] != ["system", "user"]:
            raise ValueError("需要一个系统消息和一个用户消息")
        if (
            sum(len(m.content.encode("utf-8")) + 32 for m in self.messages)
            + self.output
            >= 7900
        ):
            raise ValueError("模型请求超过上下文预算")
        return self


class LocationInput(BaseModel):
    vp: float = Field(default=6.2, ge=3, le=9)
    vs: float = Field(default=3.5, ge=1.5, le=5)
    velocity_name: str = Field(
        default="homogeneous-regional-baseline", min_length=2, max_length=100
    )


class MagnitudeInput(BaseModel):
    region: Literal["R11", "R12", "R13", "R14", "R15"] = "R13"
