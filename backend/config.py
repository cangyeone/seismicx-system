from pathlib import Path
from typing import Literal
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SEISMICX_", env_file=ROOT / ".env", extra="ignore"
    )
    data_dir: Path = ROOT / "runtime"
    skill_dir: Path = ROOT / "external/seismicx-catalog"
    auto_sync: bool = True
    sync_seconds: int = 120
    catalog_poll_seconds: int = 30
    broadcast_ai_interval_seconds: int = 60
    broadcast_relay_url: str = ""
    model_relay_key: str = (
        ""  # Server-only credential; never part of public/admin config.
    )
    broadcast_llm_provider: Literal["local", "cloud"] = "local"
    api_token: str = ""  # Deprecated, deliberately grants no access.
    llm_base_url: str = "http://localhost:11434/v1"
    llm_model: str = "qwen3:4b"
    llm_api_key: str = ""
    llm_context_tokens: int = 7900
    llm_output_tokens: int = 1400
    seedlink_server: str = "geofon.gfz.de:18000"
    seedlink_shards: int = 1
    queue_capacity: int = 128
    waveform_retention_days: int = 7
    waveform_disk_limit_gb: float = 10
    platform_name: str = "SeismicX 边缘推理平台"
    inference_backend: str = "cpu"
    npu_model: Path = ROOT / "runtime/models/pnsn_b8_f16.bmodel"
    npu_library: Path = ROOT / "runtime/models/libseismicx_npu.so"
    edge_enabled: bool = False
    edge_interval_seconds: int = 60
    edge_window_seconds: int = 180
    edge_max_input_lag_seconds: int = 180
    edge_max_stations: int = 128
    edge_input_delay_seconds: int = 20
    edge_run_retention_hours: float = 12
    waveform_retention_hours: float = 24
    cloud_llm_base_url: str = ""
    cloud_llm_model: str = ""
    cloud_llm_api_key: str = ""


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
