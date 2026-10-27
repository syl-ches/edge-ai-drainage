"""
Edge-AI DSP reference implementation (Python) for the City Camp manhole nodes.

This module is the *reference* the C++ firmware core (firmware/citycamp_edge_node/include/
edge_core.hpp) must match bit-for-bit on integers and to float precision on reals. Every
constant below has a twin in edge_core.hpp; scripts/test_phase5_firmware.py diff-tests them.

Pipeline per wake cycle (CLAUDE.md §10):
  10 Hz raw burst (A02YYUW UART) -> thermal speed-of-sound compensation
  -> 5-point sliding median + raw window variance sigma_d^2 -> turbulence ln(1 + sigma_d^2)
  -> 1D adaptive Kalman [h, dh/dt] with R = R_base + alpha * sigma_d^2
  -> steep-slope multi-shape Manning hydraulics (Q, V, Fr, He, capacity)
  -> INT8-quantised anomaly classifier -> 3-tier sleep FSM -> 32-bit big-endian payload.
"""
from __future__ import annotations

import base64
import math
import random
from dataclasses import dataclass, field

G = 9.80665

# --- A02YYUW + DS18B20 -------------------------------------------------------
SPEED_OF_SOUND_REF = 343.2          # m/s the A02YYUW assumes internally (~20 C air)
BLIND_ZONE_MM = 30.0                # bistatic near-field blind zone
MAX_RANGE_MM = 4500.0               # specified max range
BURST_LEN = 10                      # 10 samples @ 10 Hz per wake
MEDIAN_WIN = 5                      # 5-point sliding median (500 ms window)

# --- Adaptive Kalman ([h mm, dh/dt mm/min]) -----------------------------------
KF_Q = 9.0                          # process noise spectral density (mm^2/min^3): dh/dt noise
                                    # sigma ~1.8 mm/min, flags a 40 mm/min surge in ~1.7 min
KF_R_BASE = 25.0                    # base measurement variance (mm^2), ~5 mm sigma
KF_ALPHA = 0.5                      # R_adaptive = R_base + alpha * sigma_d^2
KF_P0_H = 400.0
KF_P0_V = 100.0
KF_MIN_DT_MIN = 1e-3

# --- INT8 classifier quantisation (features -> int8) ---------------------------
Q_H_SCALE = 100.0                   # h/D       -> q_h  (1 LSB = 1 %), 0..127
Q_S_SCALE = 16.0                    # ln(1+s^2) -> q_s  (1 LSB = 1/16), 0..127
Q_E_SCALE = 16.0                    # He [m]    -> q_e  (1 LSB = 1/16 m), 0..127
H_SURCHARGE_Q = 100                 # h/D >= 1.00
H_BLOCKAGE_Q = 60                   # h/D >  0.60
V_FLASH_Q = 15                      # dh/dt >= 15 mm/min (and |dh/dt| < 15 for ponding)
S_CALM_Q = 58                       # ln(1+s^2) < 3.625  (sigma < ~6 mm: quiescent backwater)
S_CHOP_Q = 74                       # ln(1+s^2) >= 4.625 (sigma > ~10 mm: surge chop)
H_SUPER_Q = 5                       # minimum depth for a meaningful Froude flag
VBAT_LOW_V = 3.30

ANOMALY_CODES = {"NORMAL": 0, "FLASH_SURGE": 1, "TRASH_BLOCKAGE": 2, "SUPERCRITICAL": 3,
                 "SURCHARGED": 4, "SENSOR_FAULT": 5, "LOW_BATTERY": 6}
ANOMALY_NAMES = {v: k for k, v in ANOMALY_CODES.items()}

# --- Adaptive sleep FSM ---------------------------------------------------------
FSM_STATES = ("STATE_DRY", "STATE_ACTIVE_RAIN", "STATE_CRITICAL_SURGE")
FSM_WAKE_S = (900, 120, 15)
FSM_UPLINK_S = (3600, 300, 60)
FSM_CURRENT_UA = (65.0, 1400.0, 8200.0)
FSM_BENCH_PERIOD_S = 1              # BENCH_DEMO_MODE: stream every second in every state
FSM_CRITICAL_H = 0.75
FSM_ACTIVE_H = 0.05
FSM_ACTIVE_DHDT = 2.0

# --- Bench-top PVC standpipe scaling ------------------------------------------
STANDPIPE_FULL_BORE_FRACTION = 0.74  # 740 mm of a 1 m pipe == h/D 1.00 (85 cm -> 115 %)
BENCH_TIME_COMPRESSION = 60.0        # standpipe mode: 1 bench second counts as 1 storm minute

# --- LoRaWAN AS923-3 ----------------------------------------------------------
AS923_3_CHANNELS_MHZ = (916.6, 916.8, 917.0, 917.2, 917.4, 917.6, 917.8, 918.0)
LORAWAN_OVERHEAD_BYTES = 13          # MHDR(1)+DevAddr(4)+FCtrl(1)+FCnt(2)+FPort(1)+MIC(4)
LORA_FPORT = 10
DWELL_LIMIT_MS = 400.0
SF_REQUIRED_SNR_DB = {7: -7.5, 8: -10.0, 9: -12.5, 10: -15.0}
ADR_MARGIN_DB = 5.0


def round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


# =============================================================================
# 32-bit payload codec (CLAUDE.md §10) — identical to the generator / TS codec
# =============================================================================
def pack_payload(depth_mm: float, dh_dt_mm_min: float, cap_pct: float, anom_code: int, vbat_v: float) -> int:
    if not 0 <= int(anom_code) <= 7:
        raise ValueError("anom_code must fit in 3 bits")
    depth = clamp(round_half_up(depth_mm / 5.0), 0, 0x3FF)
    dh = clamp(round_half_up(dh_dt_mm_min), -128, 127) & 0xFF
    cap = clamp(round_half_up(cap_pct), 0, 0x7F)
    vb = clamp(round_half_up((vbat_v - 3.00) / 0.08), 0, 0xF)
    return (depth << 22) | (dh << 14) | (cap << 7) | (int(anom_code) << 4) | vb


def unpack_payload(word: int) -> dict:
    word &= 0xFFFFFFFF
    dh = (word >> 14) & 0xFF
    anom = (word >> 4) & 0x7
    return dict(depth_mm=((word >> 22) & 0x3FF) * 5, dh_dt_mm_min=dh - 256 if dh & 0x80 else dh,
                cap_pct=(word >> 7) & 0x7F, anom_code=anom, anomaly_class=ANOMALY_NAMES.get(anom, "RESERVED"),
                vbat_v=round(3.00 + (word & 0xF) * 0.08, 2))


def payload_hex(word: int) -> str:
    return f"0x{word & 0xFFFFFFFF:08X}"


def payload_b64(word: int) -> str:
    return base64.b64encode((word & 0xFFFFFFFF).to_bytes(4, "big")).decode("ascii")


def parse_payload(hex_or_b64: str) -> int:
    s = hex_or_b64.strip()
    if s.lower().startswith("0x") or (len(s) == 8 and all(c in "0123456789abcdefABCDEF" for c in s)):
        return int(s, 16) & 0xFFFFFFFF
    raw = base64.b64decode(s)
    if len(raw) != 4:
        raise ValueError("payload must be exactly 4 bytes")
    return int.from_bytes(raw, "big")


def saturated_fields(depth_mm: float, dh_dt: float, cap_pct: float) -> list[str]:
    return [n for n, f in (("depth_mm", depth_mm > 5115.0), ("dh_dt_mm_min", dh_dt > 127.0 or dh_dt < -128.0),
                           ("cap_pct", cap_pct > 127.0)) if f]


# =============================================================================
# A02YYUW UART frame + thermal compensation
# =============================================================================
UART_OK, UART_BAD_HEADER, UART_BAD_CHECKSUM, UART_BLIND_ZONE, UART_OUT_OF_RANGE = range(5)


def parse_a02yyuw_frame(frame: bytes) -> tuple[int, float]:
    """Return (status, distance_mm) for a 4-byte frame 0xFF, DATA_H, DATA_L, SUM."""
    if len(frame) != 4 or frame[0] != 0xFF:
        return UART_BAD_HEADER, 0.0
    if (frame[0] + frame[1] + frame[2]) & 0xFF != frame[3]:
        return UART_BAD_CHECKSUM, 0.0
    d = float((frame[1] << 8) | frame[2])
    if d < BLIND_ZONE_MM:
        return UART_BLIND_ZONE, d
    if d > MAX_RANGE_MM:
        return UART_OUT_OF_RANGE, d
    return UART_OK, d


def make_a02yyuw_frame(distance_mm: float) -> bytes:
    d = int(clamp(round_half_up(distance_mm), 0, 0xFFFF))
    h, l = d >> 8, d & 0xFF
    return bytes([0xFF, h, l, (0xFF + h + l) & 0xFF])


def speed_of_sound(temp_c: float) -> float:
    return 331.3 + 0.606 * temp_c


def thermal_compensate(d_raw_mm: float, temp_c: float) -> float:
    """d_comp = d_raw * (331.3 + 0.606 T) / 343.2."""
    return d_raw_mm * speed_of_sound(temp_c) / SPEED_OF_SOUND_REF


# =============================================================================
# 5-point sliding median + raw variance
# =============================================================================
def _median(vals: list[float]) -> float:
    s = sorted(vals)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def median_and_variance(samples: list[float]) -> tuple[float, float, float]:
    """Splash-rejected distance, raw window variance sigma_d^2 (population) and ln(1+sigma_d^2).

    d_med is the median of the 5-point sliding-window medians across the burst, so isolated
    splash echoes (and up to two adjacent ones) never reach the Kalman filter.
    """
    n = len(samples)
    if n < MEDIAN_WIN:
        med = _median(samples)
    else:
        med = _median([_median(samples[i:i + MEDIAN_WIN]) for i in range(n - MEDIAN_WIN + 1)])
    mean = sum(samples) / n
    var = sum((x - mean) ** 2 for x in samples) / n
    return med, var, math.log1p(var)


# =============================================================================
# 1D adaptive Kalman filter
# =============================================================================
@dataclass
class KalmanState:
    h: float = 0.0
    v: float = 0.0
    p00: float = KF_P0_H
    p01: float = 0.0
    p11: float = KF_P0_V
    initialized: bool = False


def kalman_step(st: KalmanState, z_mm: float, sigma2: float, dt_min: float) -> KalmanState:
    if not st.initialized:
        st.h, st.v, st.p00, st.p01, st.p11, st.initialized = z_mm, 0.0, KF_P0_H, 0.0, KF_P0_V, True
        return st
    dt = max(dt_min, KF_MIN_DT_MIN)
    # predict (constant-velocity model, continuous white-acceleration noise)
    h_p = st.h + st.v * dt
    v_p = st.v
    p00 = st.p00 + dt * (2.0 * st.p01 + dt * st.p11) + KF_Q * dt * dt * dt / 3.0
    p01 = st.p01 + dt * st.p11 + KF_Q * dt * dt / 2.0
    p11 = st.p11 + KF_Q * dt
    # update with turbulence-adaptive R
    r = KF_R_BASE + KF_ALPHA * sigma2
    s = p00 + r
    k0 = p00 / s
    k1 = p01 / s
    innov = z_mm - h_p
    st.h = h_p + k0 * innov
    st.v = v_p + k1 * innov
    st.p00 = (1.0 - k0) * p00
    st.p01 = (1.0 - k0) * p01
    st.p11 = p11 - k1 * p01
    return st


# =============================================================================
# Multi-shape steep-slope hydraulics (closed form, same geometry as the generator)
# =============================================================================
SHAPES = ("CIRCULAR", "RECT_CLOSED", "ARCH")
QMAX_SCAN_STEPS = 2000


@dataclass(frozen=True)
class ConduitGeom:
    shape: str
    rise_m: float
    span_m: float
    haunch_m: float = 0.0
    manning_n: float = 0.013
    slope: float = 0.01


def section_props(g: ConduitGeom, y: float) -> tuple[float, float, float]:
    """Area A (m2), wetted perimeter P (m), top width T (m) at depth y (m)."""
    H, b, hh = g.rise_m, g.span_m, g.haunch_m
    y = clamp(y, 0.0, H)
    if g.shape == "CIRCULAR":
        theta = 2.0 * math.acos(clamp(1.0 - 2.0 * y / H, -1.0, 1.0))
        return H * H / 8.0 * (theta - math.sin(theta)), H * theta / 2.0, H * math.sin(theta / 2.0)
    if g.shape == "RECT_CLOSED":
        bot = min(y, hh)
        mid = max(min(y, H - hh) - hh, 0.0)
        top = max(y - (H - hh), 0.0)
        area = b * y - 2.0 * (hh * bot - bot * bot / 2.0) - top * top
        width = b - 2.0 * max(hh - y, 0.0) - 2.0 * top
        closure = clamp((y - 0.98 * H) / (0.02 * H), 0.0, 1.0)
        perim = (b - 2.0 * hh) + 2.0 * (math.sqrt(2.0) * bot + mid + math.sqrt(2.0) * top) + closure * (b - 2.0 * hh)
        return area, perim, width
    if g.shape == "ARCH":
        rc = b / 2.0
        hw = H - rc
        yr = min(y, hw)
        z = clamp(y - hw, 0.0, rc)
        area = b * yr + z * math.sqrt(max(rc * rc - z * z, 0.0)) + rc * rc * math.asin(z / rc)
        perim = b + 2.0 * yr + 2.0 * rc * math.asin(z / rc)
        width = b if y <= hw else 2.0 * math.sqrt(max(rc * rc - z * z, 0.0))
        return area, perim, width
    raise ValueError(g.shape)


def steep_slope(s0: float) -> float:
    return math.sin(math.atan(s0))


def manning_q(g: ConduitGeom, y: float) -> float:
    a, p, _ = section_props(g, y)
    if a <= 0.0 or p <= 0.0:
        return 0.0
    return a * (a / p) ** (2.0 / 3.0) * math.sqrt(steep_slope(max(g.slope, 1e-4))) / g.manning_n


def q_full(g: ConduitGeom) -> float:
    return manning_q(g, g.rise_m)


def q_max(g: ConduitGeom) -> tuple[float, float]:
    """(Q_max, y/D at Q_max) by fixed 2000-step scan (the firmware uses the identical scan)."""
    best_q, best_y = 0.0, 0.0
    for i in range(QMAX_SCAN_STEPS + 1):
        y = g.rise_m * i / QMAX_SCAN_STEPS
        q = manning_q(g, y)
        if q > best_q:
            best_q, best_y = q, y
    return best_q, best_y / g.rise_m


@dataclass
class HydraulicState:
    flow_cms: float
    velocity_ms: float
    froude: float | None
    specific_energy_m: float
    capacity_pct: float
    pressurized: bool


def hydraulics_at_depth(g: ConduitGeom, depth_m: float) -> HydraulicState:
    """Normal-depth hydraulics from a measured depth (manhole level may exceed the crown)."""
    D = g.rise_m
    qf = q_full(g)
    if depth_m >= D:
        a, _, _ = section_props(g, D)
        v = qf / a
        return HydraulicState(qf, v, None, D + v * v / (2 * G), min(depth_m / D, 1.27) * 100.0, True)
    y = max(depth_m, 0.0)
    a, _, t = section_props(g, y)
    q = manning_q(g, y)
    v = q / a if a > 1e-9 else 0.0
    fr = v / math.sqrt(G * a / t) if a > 1e-9 and t > 1e-6 else 0.0
    cap = max(q / qf if qf > 0 else 0.0, y / D) * 100.0
    return HydraulicState(q, v, fr, y + v * v / (2 * G), min(cap, 127.0), False)


# =============================================================================
# INT8-quantised TinyML anomaly classifier
# =============================================================================
@dataclass(frozen=True)
class QuantFeatures:
    q_h: int
    q_v: int
    q_s: int
    q_e: int


def quantize_features(h_over_d: float, dh_dt: float, turbulence: float, he_m: float) -> QuantFeatures:
    return QuantFeatures(
        q_h=clamp(round_half_up(h_over_d * Q_H_SCALE), 0, 127),
        q_v=clamp(round_half_up(dh_dt), -128, 127),
        q_s=clamp(round_half_up(turbulence * Q_S_SCALE), 0, 127),
        q_e=clamp(round_half_up(he_m * Q_E_SCALE), 0, 127),
    )


def classify_quantized(f: QuantFeatures, froude: float | None, vbat_v: float, sensor_fault: bool) -> int:
    """Integer decision surface (priority order): FAULT > SURCHARGED > TRASH_BLOCKAGE >
    FLASH_SURGE > SUPERCRITICAL > LOW_BATTERY > NORMAL. LOW_BATTERY never masks a hydraulic
    alarm because the 3-bit field carries one class only."""
    if sensor_fault:
        return 5
    if f.q_h >= H_SURCHARGE_Q:
        return 4
    if f.q_h > H_BLOCKAGE_Q and abs(f.q_v) < V_FLASH_Q and f.q_s < S_CALM_Q:
        return 2
    if f.q_v >= V_FLASH_Q and f.q_s >= S_CHOP_Q:
        return 1
    if froude is not None and froude > 1.0 and f.q_h >= H_SUPER_Q:
        return 3
    if vbat_v < VBAT_LOW_V:
        return 6
    return 0


def class_scores(f: QuantFeatures, froude: float | None) -> dict[str, float]:
    """Soft margins (0..1) per class from the same quantised features (HUD display only)."""
    sig = lambda x: 1.0 / (1.0 + math.exp(-x))  # noqa: E731
    fr = froude if froude is not None else 0.0
    return {
        "SURCHARGED": round(sig((f.q_h - H_SURCHARGE_Q) / 4.0), 3),
        "TRASH_BLOCKAGE": round(sig((f.q_h - H_BLOCKAGE_Q) / 6.0) * sig((V_FLASH_Q - abs(f.q_v)) / 3.0)
                                * sig((S_CALM_Q - f.q_s) / 6.0), 3),
        "FLASH_SURGE": round(sig((f.q_v - V_FLASH_Q) / 3.0) * sig((f.q_s - S_CHOP_Q) / 6.0), 3),
        "SUPERCRITICAL": round(sig((fr - 1.0) / 0.1) * sig((f.q_h - H_SUPER_Q) / 2.0), 3),
    }


# =============================================================================
# Sleep FSM, standpipe scaling, LoRaWAN link
# =============================================================================
def fsm_next(h_over_d: float, dh_dt: float, anomaly_code: int, bench_demo: bool = False) -> tuple[int, int, int, float]:
    """(state index, wake_s, uplink_s, current_uA)."""
    if anomaly_code in (1, 2, 4) or h_over_d >= FSM_CRITICAL_H or dh_dt >= V_FLASH_Q:
        s = 2
    elif h_over_d >= FSM_ACTIVE_H or abs(dh_dt) >= FSM_ACTIVE_DHDT or anomaly_code == 3:
        s = 1
    else:
        s = 0
    if bench_demo:
        return s, FSM_BENCH_PERIOD_S, FSM_BENCH_PERIOD_S, FSM_CURRENT_UA[s]
    return s, FSM_WAKE_S[s], FSM_UPLINK_S[s], FSM_CURRENT_UA[s]


def standpipe_scaled_depth_mm(water_mm: float, pipe_height_mm: float, conduit_rise_m: float) -> float:
    """Map a bench standpipe water column onto the target conduit depth (740/1000 mm == h/D 1)."""
    full_bore_mm = pipe_height_mm * STANDPIPE_FULL_BORE_FRACTION
    return max(water_mm, 0.0) / full_bore_mm * conduit_rise_m * 1000.0


def lora_time_on_air_ms(sf: int, app_payload_bytes: int = 4, bw_hz: float = 125e3, cr: int = 1,
                        preamble: int = 8, explicit_header: bool = True, crc: bool = True) -> float:
    """Semtech AN1200.13 time-on-air for a LoRaWAN uplink (PHY payload = app + 13 B)."""
    pl = app_payload_bytes + LORAWAN_OVERHEAD_BYTES
    t_sym = (2 ** sf) / bw_hz * 1000.0
    de = 1 if (sf >= 11 and bw_hz <= 125e3) else 0
    ih = 0 if explicit_header else 1
    num = 8 * pl - 4 * sf + 28 + (16 if crc else 0) - 20 * ih
    n_payload = 8 + max(math.ceil(num / (4 * (sf - 2 * de))) * (cr + 4), 0)
    return (preamble + 4.25) * t_sym + n_payload * t_sym


def lora_link(distance_m: float, obstruction_db: float, seq: int, rng: random.Random) -> dict:
    """Log-distance link budget (n = 2.9, hilly urban Baguio) + ADR SF choice under the
    AS923 400 ms dwell-time limit."""
    d = max(distance_m, 10.0)
    path_loss = 31.7 + 10.0 * 2.9 * math.log10(d)        # 31.7 dB = FSPL @ 1 m, 917 MHz
    rssi = 14.0 + 2.0 - path_loss - obstruction_db + rng.gauss(0.0, 2.0)
    snr = clamp(rssi + 117.0, -20.0, 10.0)                 # noise floor -174 + 51 + NF 6 = -117 dBm
    sf = 10
    for cand in (7, 8, 9, 10):
        if snr >= SF_REQUIRED_SNR_DB[cand] + ADR_MARGIN_DB and lora_time_on_air_ms(cand) <= DWELL_LIMIT_MS:
            sf = cand
            break
    return dict(region="AS923-3", channel_mhz=AS923_3_CHANNELS_MHZ[seq % len(AS923_3_CHANNELS_MHZ)],
                spreading_factor=sf, data_rate=f"DR{12 - sf}", time_on_air_ms=round(lora_time_on_air_ms(sf), 1),
                rssi_dbm=round(rssi, 1), snr_db=round(snr, 1), fport=LORA_FPORT)


# =============================================================================
# Virtual edge node (closed-loop fleet member)
# =============================================================================
@dataclass
class EdgeNodeConfig:
    sensor_id: str
    device_eui: str
    hardware: str
    full_scale_m: float                 # D used for h/D (conduit rise, lagoon 6.5 m, rack 2.0 m)
    mount_mm: float                     # transducer -> depth datum distance
    geom: ConduitGeom | None            # None for storage / rack
    gateway_distance_m: float
    obstruction_db: float
    vbat_v: float


@dataclass
class EdgeNode:
    cfg: EdgeNodeConfig
    kalman: KalmanState = field(default_factory=KalmanState)
    rng: random.Random = field(default_factory=random.Random)
    seq: int = 0

    def synthesize_burst(self, true_depth_mm: float, turbulence: float, temp_c: float) -> list[float]:
        """Raw A02YYUW distances: cold-water sound-speed bias, surface chop, splash spikes."""
        d_true = self.cfg.mount_mm - true_depth_mm
        sigma_wave = 1.5 + 25.0 * turbulence
        p_spike = 0.25 * turbulence * turbulence
        phase = self.rng.uniform(0, 2 * math.pi)
        out = []
        for k in range(BURST_LEN):
            d = d_true + sigma_wave * math.sin(phase + k * 1.9) + self.rng.gauss(0.0, 2.0)
            if self.rng.random() < p_spike:
                d -= self.rng.uniform(120.0, 600.0)           # droplet / splash echo
            d_raw = d * SPEED_OF_SOUND_REF / speed_of_sound(temp_c)
            out.append(clamp(d_raw, BLIND_ZONE_MM, MAX_RANGE_MM + 500.0))
        return out

    def step(self, true_depth_mm: float, turbulence: float, temp_c: float, dt_min: float) -> dict:
        self.seq += 1
        raw = self.synthesize_burst(true_depth_mm, turbulence, temp_c)
        r = run_cycle(self.cfg, self.kalman, raw, temp_c, dt_min)
        return dict(
            sensor_id=self.cfg.sensor_id, device_eui=self.cfg.device_eui, origin="VIRTUAL",
            temperature_c=round(temp_c, 2), raw_burst_mm=[round(x, 1) for x in raw],
            raw_unfiltered_depth_mm=round(r["raw_depth_mm"], 1), median_depth_mm=round(r["measured_depth_mm"], 1),
            kalman_filtered_depth_mm=round(r["depth_mm"], 1), true_depth_mm=round(true_depth_mm, 1),
            dh_dt_mm_min=round(r["dh_dt_mm_min"], 2), sigma_d2_mm2=round(r["sigma_d2"], 2),
            turbulence_index=round(r["turbulence"], 4), h_over_d=round(r["h_over_d"], 4),
            flow_cms=None if r["flow_cms"] is None else round(r["flow_cms"], 4),
            velocity_ms=None if r["velocity_ms"] is None else round(r["velocity_ms"], 3),
            froude_number=None if r["froude"] is None else round(r["froude"], 3),
            specific_energy_m=round(r["he_m"], 3), capacity_pct=round(r["cap_pct"], 1),
            anomaly_class=ANOMALY_NAMES[r["anomaly_code"]], anomaly_code=r["anomaly_code"],
            anomaly_scores=class_scores(r["features"], r["froude"]), saturated_fields=r["saturated"],
            vbat_v=self.cfg.vbat_v, payload_hex=payload_hex(r["payload"]), payload_b64=payload_b64(r["payload"]),
            payload_uint32=r["payload"], fsm_state=FSM_STATES[r["fsm_state"]], current_ua=r["current_ua"],
            next_wake_s=r["wake_s"], uplink_interval_s=r["uplink_s"],
            lora=lora_link(self.cfg.gateway_distance_m, self.cfg.obstruction_db, self.seq, self.rng),
        )


# =============================================================================
# One complete wake cycle — the exact sequence firmware/.../edge_core.hpp::run_cycle runs
# =============================================================================
def run_cycle(cfg: EdgeNodeConfig, kalman: KalmanState, raw_mm: list[float], temp_c: float, dt_min: float,
              sensor_fault: bool = False, bench_demo: bool = False, standpipe: bool = False,
              pipe_height_mm: float = 1000.0, vbat_v: float | None = None) -> dict:
    """raw burst -> thermal comp -> median/variance -> (standpipe scaling) -> Kalman -> hydraulics
    -> INT8 classifier -> FSM -> payload. Pure function of its inputs + the Kalman state.
    `vbat_v` is the measured battery voltage (firmware: ADC); defaults to the profile nominal."""
    vbat = cfg.vbat_v if vbat_v is None else vbat_v
    if standpipe:
        dt_min *= BENCH_TIME_COMPRESSION     # water poured into a 1 m pipe rises cm/s, manholes mm/min
    comp = [thermal_compensate(d, temp_c) for d in raw_mm]
    d_med, var, turb = median_and_variance(comp)
    flags: list[str] = []
    if d_med <= BLIND_ZONE_MM + 1.0:
        flags.append("blind_zone")
    if d_med > MAX_RANGE_MM:
        flags.append("below_range")
        d_med = MAX_RANGE_MM
    last = comp[-1]
    if standpipe:
        water = clamp(pipe_height_mm - d_med, 0.0, pipe_height_mm)
        z = standpipe_scaled_depth_mm(water, pipe_height_mm, cfg.full_scale_m)
        raw_depth = standpipe_scaled_depth_mm(clamp(pipe_height_mm - last, 0.0, pipe_height_mm),
                                              pipe_height_mm, cfg.full_scale_m)
    else:
        z = clamp(cfg.mount_mm - d_med, 0.0, cfg.mount_mm - BLIND_ZONE_MM)
        raw_depth = clamp(cfg.mount_mm - last, 0.0, cfg.mount_mm)
    kalman_step(kalman, z, var, dt_min)
    depth = max(kalman.h, 0.0)
    dh_dt = kalman.v
    h_over_d = depth / 1000.0 / cfg.full_scale_m
    if cfg.geom is not None:
        hyd = hydraulics_at_depth(cfg.geom, depth / 1000.0)
        flow, vel, fr, he, cap = hyd.flow_cms, hyd.velocity_ms, hyd.froude, hyd.specific_energy_m, hyd.capacity_pct
    else:
        flow = vel = fr = None
        he = depth / 1000.0
        cap = min(h_over_d, 1.27) * 100.0
    feats = quantize_features(h_over_d, dh_dt, turb, he)
    code = classify_quantized(feats, fr, vbat, sensor_fault)
    state, wake, uplink, current = fsm_next(h_over_d, dh_dt, code, bench_demo)
    word = pack_payload(depth, dh_dt, cap, code, vbat)
    return dict(d_med_mm=d_med, sigma_d2=var, turbulence=turb, measured_depth_mm=z, raw_depth_mm=raw_depth,
                depth_mm=depth, dh_dt_mm_min=dh_dt, h_over_d=h_over_d, flow_cms=flow, velocity_ms=vel,
                froude=fr, he_m=he, cap_pct=cap, features=feats, anomaly_code=code, fsm_state=state,
                wake_s=wake, uplink_s=uplink, current_ua=current, payload=word,
                saturated=saturated_fields(depth, dh_dt, cap) + flags)


FLAG_NAMES = ("depth_mm", "dh_dt_mm_min", "cap_pct", "blind_zone", "below_range")


def edge_tx_record(cfg: EdgeNodeConfig, raw_mm: list[float], temp_c: float, vbat_v: float, bench_demo: bool,
                   standpipe: bool, pipe_height_mm: float, res: dict, seq: int, fw: str) -> dict:
    """Python mirror of edge_core.hpp::format_edge_tx — the [EDGE_TX] JSON the firmware prints."""
    word = res["payload"]
    has_geom = cfg.geom is not None
    pressurized = has_geom and res["froude"] is None
    return {
        "device_eui": cfg.sensor_id, "device_eui_hex": cfg.device_eui,
        "payload_hex": payload_hex(word), "payload_b64": payload_b64(word), "fport": LORA_FPORT,
        "raw_burst_mm": [round(x, 1) for x in raw_mm],
        "raw_unfiltered_depth_mm": round(res["raw_depth_mm"], 1), "median_depth_mm": round(res["measured_depth_mm"], 1),
        "kalman_filtered_depth_mm": round(res["depth_mm"], 1), "dh_dt_mm_min": round(res["dh_dt_mm_min"], 2),
        "sigma_d2_mm2": round(res["sigma_d2"], 2), "turbulence_index": round(res["turbulence"], 4),
        "h_over_d": round(res["h_over_d"], 4), "capacity_pct": round(res["cap_pct"], 1),
        "flow_cms": round(res["flow_cms"], 4) if has_geom else None,
        "velocity_ms": round(res["velocity_ms"], 3) if has_geom else None,
        "froude_number": None if (not has_geom or pressurized) else round(res["froude"], 3),
        "specific_energy_m": round(res["he_m"], 3),
        "anomaly_class": ANOMALY_NAMES[res["anomaly_code"]], "anomaly_code": res["anomaly_code"],
        "fsm_state": FSM_STATES[res["fsm_state"]], "next_wake_s": res["wake_s"],
        "temperature_c": round(temp_c, 2), "vbat_v": round(vbat_v, 2),
        "saturated_fields": [n for n in FLAG_NAMES if n in res["saturated"]],
        "bench_demo": bench_demo, "standpipe": {"enabled": standpipe, "pipe_height_mm": round(pipe_height_mm)},
        "seq": seq, "fw": fw,
    }
