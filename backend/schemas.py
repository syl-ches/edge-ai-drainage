"""Pydantic v2 models: request bodies and the WS /ws/live frame contract.

TwinFrame mirrors src/types/live.ts field-for-field; the backend test suite validates real
frames against it so the two stay in lock-step.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

AnomalyClass = Literal["NORMAL", "FLASH_SURGE", "TRASH_BLOCKAGE", "SUPERCRITICAL", "SURCHARGED",
                       "SENSOR_FAULT", "LOW_BATTERY"]
FsmState = Literal["STATE_DRY", "STATE_ACTIVE_RAIN", "STATE_CRITICAL_SURGE"]


class LoraLink(BaseModel):
    region: Literal["AS923-3"]
    channel_mhz: float
    spreading_factor: int = Field(ge=7, le=12)
    data_rate: str
    time_on_air_ms: float
    rssi_dbm: float
    snr_db: float
    fport: int


class LiveSensor(BaseModel):
    sensor_id: str
    device_eui: str
    origin: Literal["VIRTUAL", "HARDWARE"]
    temperature_c: float
    raw_burst_mm: list[float]
    raw_unfiltered_depth_mm: float
    median_depth_mm: float
    kalman_filtered_depth_mm: float
    true_depth_mm: float
    dh_dt_mm_min: float
    sigma_d2_mm2: float
    turbulence_index: float
    h_over_d: float
    flow_cms: float | None
    velocity_ms: float | None
    froude_number: float | None
    specific_energy_m: float | None
    capacity_pct: float
    anomaly_class: AnomalyClass
    anomaly_code: int = Field(ge=0, le=7)
    anomaly_scores: dict[str, float]
    saturated_fields: list[str]
    vbat_v: float
    payload_hex: str = Field(pattern=r"^0x[0-9A-F]{8}$")
    payload_b64: str
    payload_uint32: int = Field(ge=0, le=0xFFFFFFFF)
    fsm_state: FsmState
    current_ua: float
    next_wake_s: int
    uplink_interval_s: int
    lora: LoraLink
    blockage_pct: float | None = None


class FusionVerdict(BaseModel):
    root_cause: Literal["NOMINAL", "CONFIRMED_TRASH_RACK_OCCLUSION", "DOWNSTREAM_ROCK_CHOKE_BACKWATER",
                        "DEBRIS_ACCUMULATING_NO_BACKWATER", "INTAKE_SURCHARGE_OVERFLOW"]
    severity: Literal["INFO", "WARNING", "CRITICAL"]
    action: str
    confidence: float
    evidence: list[str]
    suppressed_false_alarm: bool


class NowcastHorizon(BaseModel):
    minutes: int
    rainfall_mm_hr: float
    lagoon_depth_m: float
    surcharge_probability_pct: float
    time_to_overflow_min: float | None
    surcharged_conduits: int


class FewsStation(BaseModel):
    station: str
    elevation_m: float
    rainfall_mm_hr: float


class Nowcast(BaseModel):
    generated_at: str
    basin_rainfall_mm_hr: float
    fews: list[FewsStation]
    subcatchments: dict[str, float]
    horizons: list[NowcastHorizon]


class Scenario(BaseModel):
    rainfall_mm_hr: float
    trash_rack_blockage_pct: float


class LagoonSummary(BaseModel):
    depth_m: float
    surface_elev_m: float
    time_to_overflow_min: float | None
    bottleneck: str
    orifice_head_loss_m: float


class HardwareOverride(BaseModel):
    sensor_id: str
    age_s: float


class TwinFrame(BaseModel):
    type: Literal["twin_frame"]
    seq: int
    ts: str
    mode: Literal["PLAYBACK", "SCENARIO", "HARDWARE"]
    storm_clock_s: float
    storm_period_s: float
    scenario: Scenario
    lagoon: LagoonSummary
    sensors: dict[str, LiveSensor]
    fusion: FusionVerdict
    nowcast: Nowcast
    hardware_override: HardwareOverride | None


# ------------------------------------------------------------------ requests
class ScenarioRequest(BaseModel):
    mode: Literal["PLAYBACK", "SCENARIO"] = "SCENARIO"
    rainfall_mm_hr: float | None = Field(default=None, ge=0, le=250)
    trash_rack_blockage_pct: float | None = Field(default=None, ge=0, le=95)


class DecodeRequest(BaseModel):
    payload_hex: str | None = None
    payload_b64: str | None = None


class IngestRequest(BaseModel):
    """Accepts three shapes on one endpoint:
    1. Direct (Wi-Fi HTTP POST / USB serial bridge):
       {"device_eui": "EN-08", "payload_hex": "0x...", ...diagnostics}
    2. Base64:  {"device_eui": "02BA6C1000000008", "payload_b64": "..."}
    3. The Things Stack v3 uplink webhook:
       {"end_device_ids": {"dev_eui": "..."}, "uplink_message": {"frm_payload": "...", "f_port": 10,
        "rx_metadata": [{"rssi": -97, "snr": 7.5}]}}
    """
    model_config = ConfigDict(extra="allow")

    device_eui: str | None = None
    sensor_id: str | None = None
    payload_hex: str | None = None
    payload_b64: str | None = None
    end_device_ids: dict[str, Any] | None = None
    uplink_message: dict[str, Any] | None = None
