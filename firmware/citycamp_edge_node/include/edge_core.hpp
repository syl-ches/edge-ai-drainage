// edge_core.hpp — City Camp Lagoon Edge-AI node: portable C++17 DSP + hydraulics core.
//
// Header-only, zero heap (no new/malloc/STL containers), static/stack buffers only.
// Compiles for the Seeed XIAO ESP32-S3 (Arduino / ESP-IDF, float) and on any desktop
// g++/clang++ for host verification (define EDGE_CORE_USE_DOUBLE for exact parity runs).
//
// This is a line-by-line port of backend/edge_dsp.py (the reference). Every constant and
// every rounding rule below must stay identical; scripts/test_phase5_firmware.py diff-tests
// the two implementations on thousands of vectors. Payload layout: CLAUDE.md §10.
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace edge {

#ifdef EDGE_CORE_USE_DOUBLE
using real = double;
#else
using real = float;
#endif

// ---------------------------------------------------------------- constants (== edge_dsp.py)
constexpr real G = 9.80665;
constexpr real SPEED_OF_SOUND_REF = 343.2;
constexpr real BLIND_ZONE_MM = 30.0;
constexpr real MAX_RANGE_MM = 4500.0;
constexpr std::size_t BURST_LEN = 10;
constexpr std::size_t MEDIAN_WIN = 5;
constexpr std::size_t MAX_BURST = 16;

constexpr real KF_Q = 9.0;  // dh/dt noise ~1.8 mm/min; flags a 40 mm/min surge in ~1.7 min
constexpr real KF_R_BASE = 25.0;
constexpr real KF_ALPHA = 0.5;
constexpr real KF_P0_H = 400.0;
constexpr real KF_P0_V = 100.0;
constexpr real KF_MIN_DT_MIN = 1e-3;

constexpr real Q_H_SCALE = 100.0;
constexpr real Q_S_SCALE = 16.0;
constexpr real Q_E_SCALE = 16.0;
constexpr int H_SURCHARGE_Q = 100;
constexpr int H_BLOCKAGE_Q = 60;
constexpr int V_FLASH_Q = 15;
constexpr int S_CALM_Q = 58;
constexpr int S_CHOP_Q = 74;
constexpr int H_SUPER_Q = 5;
constexpr real VBAT_LOW_V = 3.30;

constexpr real STANDPIPE_FULL_BORE_FRACTION = 0.74;
constexpr real BENCH_TIME_COMPRESSION = 60.0;  // standpipe: 1 bench second == 1 storm minute
constexpr int QMAX_SCAN_STEPS = 2000;
constexpr int LORAWAN_OVERHEAD_BYTES = 13;
constexpr int LORA_FPORT = 10;
constexpr real DWELL_LIMIT_MS = 400.0;
constexpr real ADR_MARGIN_DB = 5.0;

enum Anomaly : uint8_t {
  ANOMALY_NORMAL = 0,
  ANOMALY_FLASH_SURGE = 1,
  ANOMALY_TRASH_BLOCKAGE = 2,
  ANOMALY_SUPERCRITICAL = 3,
  ANOMALY_SURCHARGED = 4,
  ANOMALY_SENSOR_FAULT = 5,
  ANOMALY_LOW_BATTERY = 6,
};

inline const char* anomaly_name(uint8_t code) {
  static const char* const names[8] = {"NORMAL", "FLASH_SURGE", "TRASH_BLOCKAGE", "SUPERCRITICAL",
                                        "SURCHARGED", "SENSOR_FAULT", "LOW_BATTERY", "RESERVED"};
  return names[code & 0x7];
}

enum FsmState : uint8_t { STATE_DRY = 0, STATE_ACTIVE_RAIN = 1, STATE_CRITICAL_SURGE = 2 };
constexpr uint32_t FSM_WAKE_S[3] = {900, 120, 15};
constexpr uint32_t FSM_UPLINK_S[3] = {3600, 300, 60};
constexpr real FSM_CURRENT_UA[3] = {65.0, 1400.0, 8200.0};
constexpr uint32_t FSM_BENCH_PERIOD_S = 1;
constexpr real FSM_CRITICAL_H = 0.75;
constexpr real FSM_ACTIVE_H = 0.05;
constexpr real FSM_ACTIVE_DHDT = 2.0;

inline const char* fsm_name(uint8_t s) {
  static const char* const names[3] = {"STATE_DRY", "STATE_ACTIVE_RAIN", "STATE_CRITICAL_SURGE"};
  return names[s < 3 ? s : 0];
}

// ---------------------------------------------------------------- helpers
template <class T>
constexpr T clampv(T v, T lo, T hi) { return v < lo ? lo : (v > hi ? hi : v); }

inline int32_t round_half_up(real x) { return static_cast<int32_t>(std::floor(x + static_cast<real>(0.5))); }

// ================================================================ 32-bit payload codec
inline uint32_t pack_payload(real depth_mm, real dh_dt_mm_min, real cap_pct, uint8_t anom_code, real vbat_v) {
  const uint32_t depth = static_cast<uint32_t>(clampv<int32_t>(round_half_up(depth_mm / static_cast<real>(5.0)), 0, 0x3FF));
  const uint32_t dh = static_cast<uint32_t>(clampv<int32_t>(round_half_up(dh_dt_mm_min), -128, 127)) & 0xFFu;
  const uint32_t cap = static_cast<uint32_t>(clampv<int32_t>(round_half_up(cap_pct), 0, 0x7F));
  const uint32_t vb = static_cast<uint32_t>(clampv<int32_t>(round_half_up((vbat_v - static_cast<real>(3.0)) / static_cast<real>(0.08)), 0, 0xF));
  return (depth << 22) | (dh << 14) | (cap << 7) | (static_cast<uint32_t>(anom_code & 0x7) << 4) | vb;
}

struct Decoded {
  int32_t depth_mm;
  int32_t dh_dt_mm_min;
  int32_t cap_pct;
  uint8_t anom_code;
  real vbat_v;
};

inline Decoded unpack_payload(uint32_t w) {
  const int32_t dh = static_cast<int32_t>((w >> 14) & 0xFF);
  return Decoded{static_cast<int32_t>(((w >> 22) & 0x3FF) * 5), (dh & 0x80) ? dh - 256 : dh,
                 static_cast<int32_t>((w >> 7) & 0x7F), static_cast<uint8_t>((w >> 4) & 0x7),
                 static_cast<real>(3.0) + static_cast<real>(w & 0xF) * static_cast<real>(0.08)};
}

/// "0xXXXXXXXX" (needs 11 bytes).
inline void payload_hex(uint32_t w, char out[11]) { std::snprintf(out, 11, "0x%08lX", static_cast<unsigned long>(w)); }

/// Big-endian 4 bytes -> 8-char base64 (needs 9 bytes).
inline void payload_b64(uint32_t w, char out[9]) {
  static const char* const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const uint8_t b[4] = {static_cast<uint8_t>(w >> 24), static_cast<uint8_t>(w >> 16), static_cast<uint8_t>(w >> 8), static_cast<uint8_t>(w)};
  out[0] = T[b[0] >> 2];
  out[1] = T[((b[0] & 0x03) << 4) | (b[1] >> 4)];
  out[2] = T[((b[1] & 0x0F) << 2) | (b[2] >> 6)];
  out[3] = T[b[2] & 0x3F];
  out[4] = T[b[3] >> 2];
  out[5] = T[(b[3] & 0x03) << 4];
  out[6] = '=';
  out[7] = '=';
  out[8] = '\0';
}

inline void payload_bytes_be(uint32_t w, uint8_t out[4]) {
  out[0] = static_cast<uint8_t>(w >> 24);
  out[1] = static_cast<uint8_t>(w >> 16);
  out[2] = static_cast<uint8_t>(w >> 8);
  out[3] = static_cast<uint8_t>(w);
}

// ================================================================ A02YYUW UART + thermal compensation
enum class UartStatus : uint8_t { Ok = 0, BadHeader = 1, BadChecksum = 2, BlindZone = 3, OutOfRange = 4 };

struct UartReading {
  UartStatus status;
  real distance_mm;
};

/// Validate one 4-byte frame: 0xFF, DATA_H, DATA_L, SUM == (0xFF + H + L) & 0xFF.
inline UartReading parse_a02yyuw_frame(const uint8_t f[4]) {
  if (f[0] != 0xFF) return {UartStatus::BadHeader, 0};
  if (static_cast<uint8_t>((f[0] + f[1] + f[2]) & 0xFF) != f[3]) return {UartStatus::BadChecksum, 0};
  const real d = static_cast<real>((static_cast<uint16_t>(f[1]) << 8) | f[2]);
  if (d < BLIND_ZONE_MM) return {UartStatus::BlindZone, d};
  if (d > MAX_RANGE_MM) return {UartStatus::OutOfRange, d};
  return {UartStatus::Ok, d};
}

/// Byte-stream re-synchroniser for the UART: feed() bytes, returns true when `frame` holds 4 bytes.
class A02yyuwStream {
 public:
  bool feed(uint8_t byte) {
    if (n_ == 0 && byte != 0xFF) return false;  // hunt for the header
    frame[n_++] = byte;
    if (n_ < 4) return false;
    n_ = 0;
    return true;
  }
  uint8_t frame[4] = {0, 0, 0, 0};

 private:
  std::size_t n_ = 0;
};

inline real speed_of_sound(real temp_c) { return static_cast<real>(331.3) + static_cast<real>(0.606) * temp_c; }

/// d_comp = d_raw * (331.3 + 0.606 T) / 343.2
inline real thermal_compensate(real d_raw_mm, real temp_c) { return d_raw_mm * speed_of_sound(temp_c) / SPEED_OF_SOUND_REF; }

// ================================================================ 5-point sliding median + raw variance
inline void insertion_sort(real* a, std::size_t n) {
  for (std::size_t i = 1; i < n; ++i) {
    const real v = a[i];
    std::size_t j = i;
    while (j > 0 && a[j - 1] > v) {
      a[j] = a[j - 1];
      --j;
    }
    a[j] = v;
  }
}

inline real median_of(const real* src, std::size_t n) {
  real tmp[MAX_BURST];
  for (std::size_t i = 0; i < n; ++i) tmp[i] = src[i];
  insertion_sort(tmp, n);
  return (n % 2) ? tmp[n / 2] : static_cast<real>(0.5) * (tmp[n / 2 - 1] + tmp[n / 2]);
}

struct BurstStats {
  real d_med_mm;
  real sigma_d2;
  real turbulence;  // ln(1 + sigma_d^2)
};

/// Median of the 5-point sliding-window medians (splash-rejected) + population variance.
inline BurstStats median_and_variance(const real* s, std::size_t n) {
  if (n > MAX_BURST) n = MAX_BURST;
  real med;
  if (n < MEDIAN_WIN) {
    med = median_of(s, n);
  } else {
    real meds[MAX_BURST];
    const std::size_t m = n - MEDIAN_WIN + 1;
    for (std::size_t i = 0; i < m; ++i) meds[i] = median_of(s + i, MEDIAN_WIN);
    med = median_of(meds, m);
  }
  real mean = 0;
  for (std::size_t i = 0; i < n; ++i) mean += s[i];
  mean /= static_cast<real>(n);
  real var = 0;
  for (std::size_t i = 0; i < n; ++i) var += (s[i] - mean) * (s[i] - mean);
  var /= static_cast<real>(n);
  return {med, var, std::log1p(var)};
}

// ================================================================ 1D adaptive Kalman filter
/// Plain-old-data so the firmware can place it in RTC_DATA_ATTR memory across deep sleep.
struct KalmanState {
  real h;
  real v;
  real p00;
  real p01;
  real p11;
  uint8_t initialized;
};

inline KalmanState kalman_init() { return KalmanState{0, 0, KF_P0_H, 0, KF_P0_V, 0}; }

inline void kalman_step(KalmanState& st, real z_mm, real sigma2, real dt_min) {
  if (!st.initialized) {
    st = KalmanState{z_mm, 0, KF_P0_H, 0, KF_P0_V, 1};
    return;
  }
  const real dt = dt_min > KF_MIN_DT_MIN ? dt_min : KF_MIN_DT_MIN;
  const real h_p = st.h + st.v * dt;
  const real v_p = st.v;
  const real p00 = st.p00 + dt * (static_cast<real>(2.0) * st.p01 + dt * st.p11) + KF_Q * dt * dt * dt / static_cast<real>(3.0);
  const real p01 = st.p01 + dt * st.p11 + KF_Q * dt * dt / static_cast<real>(2.0);
  const real p11 = st.p11 + KF_Q * dt;
  const real r = KF_R_BASE + KF_ALPHA * sigma2;
  const real s = p00 + r;
  const real k0 = p00 / s;
  const real k1 = p01 / s;
  const real innov = z_mm - h_p;
  st.h = h_p + k0 * innov;
  st.v = v_p + k1 * innov;
  st.p00 = (static_cast<real>(1.0) - k0) * p00;
  st.p01 = (static_cast<real>(1.0) - k0) * p01;
  st.p11 = p11 - k1 * p01;
}

// ================================================================ multi-shape steep-slope hydraulics
enum class Shape : uint8_t { Circular = 0, RectClosed = 1, Arch = 2 };

struct ConduitGeom {
  Shape shape;
  real rise_m;
  real span_m;
  real haunch_m;
  real manning_n;
  real slope;
};

struct SectionProps {
  real a;
  real p;
  real t;
};

inline SectionProps section_props(const ConduitGeom& g, real y) {
  const real H = g.rise_m, b = g.span_m, hh = g.haunch_m;
  const real zero = 0, two = 2;
  y = clampv(y, zero, H);
  if (g.shape == Shape::Circular) {
    const real theta = two * std::acos(clampv(static_cast<real>(1.0) - two * y / H, static_cast<real>(-1.0), static_cast<real>(1.0)));
    return {H * H / static_cast<real>(8.0) * (theta - std::sin(theta)), H * theta / two, H * std::sin(theta / two)};
  }
  if (g.shape == Shape::RectClosed) {
    const real sq2 = std::sqrt(two);
    const real bot = y < hh ? y : hh;
    const real mid_hi = y < (H - hh) ? y : (H - hh);
    const real mid = (mid_hi - hh) > zero ? (mid_hi - hh) : zero;
    const real top = (y - (H - hh)) > zero ? (y - (H - hh)) : zero;
    const real area = b * y - two * (hh * bot - bot * bot / two) - top * top;
    const real width = b - two * ((hh - y) > zero ? (hh - y) : zero) - two * top;
    const real closure = clampv((y - static_cast<real>(0.98) * H) / (static_cast<real>(0.02) * H), zero, static_cast<real>(1.0));
    const real perim = (b - two * hh) + two * (sq2 * bot + mid + sq2 * top) + closure * (b - two * hh);
    return {area, perim, width};
  }
  // ARCH: vertical walls + semicircular crown
  const real rc = b / two;
  const real hw = H - rc;
  const real yr = y < hw ? y : hw;
  const real z = clampv(y - hw, zero, rc);
  const real root = std::sqrt((rc * rc - z * z) > zero ? (rc * rc - z * z) : zero);
  const real area = b * yr + z * root + rc * rc * std::asin(z / rc);
  const real perim = b + two * yr + two * rc * std::asin(z / rc);
  const real width = (y <= hw) ? b : two * root;
  return {area, perim, width};
}

/// S = sin(atan(S0)) — steep-slope energy gradient.
inline real steep_slope(real s0) { return std::sin(std::atan(s0)); }

inline real manning_q(const ConduitGeom& g, real y) {
  const SectionProps sp = section_props(g, y);
  if (sp.a <= 0 || sp.p <= 0) return 0;
  const real s = steep_slope(g.slope > static_cast<real>(1e-4) ? g.slope : static_cast<real>(1e-4));
  return sp.a * std::pow(sp.a / sp.p, static_cast<real>(2.0) / static_cast<real>(3.0)) * std::sqrt(s) / g.manning_n;
}

inline real q_full(const ConduitGeom& g) { return manning_q(g, g.rise_m); }

struct QMax {
  real q;
  real y_ratio;
};

/// Closed-conduit capacity paradox: Q peaks below the crown (circle: h/D 0.938, 1.076 Q_full).
inline QMax q_max(const ConduitGeom& g) {
  QMax best{0, 0};
  for (int i = 0; i <= QMAX_SCAN_STEPS; ++i) {
    const real y = g.rise_m * static_cast<real>(i) / static_cast<real>(QMAX_SCAN_STEPS);
    const real q = manning_q(g, y);
    if (q > best.q) best = {q, y / g.rise_m};
  }
  return best;
}

struct Hydraulics {
  real flow_cms;
  real velocity_ms;
  real froude;
  bool has_froude;
  real specific_energy_m;
  real capacity_pct;
  bool pressurized;
};

inline Hydraulics hydraulics_at_depth(const ConduitGeom& g, real depth_m) {
  const real D = g.rise_m;
  const real qf = q_full(g);
  const real two_g = static_cast<real>(2.0) * G;
  if (depth_m >= D) {
    const SectionProps sp = section_props(g, D);
    const real v = qf / sp.a;
    const real cap = (depth_m / D < static_cast<real>(1.27) ? depth_m / D : static_cast<real>(1.27)) * static_cast<real>(100.0);
    return {qf, v, 0, false, D + v * v / two_g, cap, true};
  }
  const real y = depth_m > 0 ? depth_m : 0;
  const SectionProps sp = section_props(g, y);
  const real q = manning_q(g, y);
  const real v = sp.a > static_cast<real>(1e-9) ? q / sp.a : 0;
  const real fr = (sp.a > static_cast<real>(1e-9) && sp.t > static_cast<real>(1e-6)) ? v / std::sqrt(G * sp.a / sp.t) : 0;
  const real ratio_q = qf > 0 ? q / qf : 0;
  real cap = (ratio_q > y / D ? ratio_q : y / D) * static_cast<real>(100.0);
  if (cap > static_cast<real>(127.0)) cap = 127.0;
  return {q, v, fr, true, y + v * v / two_g, cap, false};
}

// ================================================================ INT8 TinyML anomaly classifier
struct QuantFeatures {
  int16_t q_h;  // h/D        x100   (int8 range)
  int16_t q_v;  // dh/dt      mm/min
  int16_t q_s;  // ln(1+s^2)  x16
  int16_t q_e;  // He [m]     x16
};

inline QuantFeatures quantize_features(real h_over_d, real dh_dt, real turbulence, real he_m) {
  return QuantFeatures{static_cast<int16_t>(clampv<int32_t>(round_half_up(h_over_d * Q_H_SCALE), 0, 127)),
                       static_cast<int16_t>(clampv<int32_t>(round_half_up(dh_dt), -128, 127)),
                       static_cast<int16_t>(clampv<int32_t>(round_half_up(turbulence * Q_S_SCALE), 0, 127)),
                       static_cast<int16_t>(clampv<int32_t>(round_half_up(he_m * Q_E_SCALE), 0, 127))};
}

/// Integer decision surface. Priority: FAULT > SURCHARGED > TRASH_BLOCKAGE > FLASH_SURGE >
/// SUPERCRITICAL > LOW_BATTERY > NORMAL (battery never masks a hydraulic alarm).
inline uint8_t classify_quantized(const QuantFeatures& f, bool has_froude, real froude, real vbat_v, bool sensor_fault) {
  if (sensor_fault) return ANOMALY_SENSOR_FAULT;
  if (f.q_h >= H_SURCHARGE_Q) return ANOMALY_SURCHARGED;
  const int abs_v = f.q_v < 0 ? -f.q_v : f.q_v;
  if (f.q_h > H_BLOCKAGE_Q && abs_v < V_FLASH_Q && f.q_s < S_CALM_Q) return ANOMALY_TRASH_BLOCKAGE;
  if (f.q_v >= V_FLASH_Q && f.q_s >= S_CHOP_Q) return ANOMALY_FLASH_SURGE;
  if (has_froude && froude > static_cast<real>(1.0) && f.q_h >= H_SUPER_Q) return ANOMALY_SUPERCRITICAL;
  if (vbat_v < VBAT_LOW_V) return ANOMALY_LOW_BATTERY;
  return ANOMALY_NORMAL;
}

// ================================================================ FSM, standpipe, LoRaWAN
struct FsmDecision {
  uint8_t state;
  uint32_t wake_s;
  uint32_t uplink_s;
  real current_ua;
};

inline FsmDecision fsm_next(real h_over_d, real dh_dt, uint8_t code, bool bench_demo) {
  uint8_t s;
  if (code == ANOMALY_FLASH_SURGE || code == ANOMALY_TRASH_BLOCKAGE || code == ANOMALY_SURCHARGED || h_over_d >= FSM_CRITICAL_H ||
      dh_dt >= static_cast<real>(V_FLASH_Q)) {
    s = STATE_CRITICAL_SURGE;
  } else if (h_over_d >= FSM_ACTIVE_H || std::fabs(dh_dt) >= FSM_ACTIVE_DHDT || code == ANOMALY_SUPERCRITICAL) {
    s = STATE_ACTIVE_RAIN;
  } else {
    s = STATE_DRY;
  }
  if (bench_demo) return {s, FSM_BENCH_PERIOD_S, FSM_BENCH_PERIOD_S, FSM_CURRENT_UA[s]};
  return {s, FSM_WAKE_S[s], FSM_UPLINK_S[s], FSM_CURRENT_UA[s]};
}

/// Bench PVC standpipe: 740/1000 mm of water == h/D 1.00 of the represented conduit.
inline real standpipe_scaled_depth_mm(real water_mm, real pipe_height_mm, real conduit_rise_m) {
  const real full_bore = pipe_height_mm * STANDPIPE_FULL_BORE_FRACTION;
  return (water_mm > 0 ? water_mm : 0) / full_bore * conduit_rise_m * static_cast<real>(1000.0);
}

/// Semtech AN1200.13 LoRa time-on-air (BW 125 kHz, CR 4/5, 8-symbol preamble, explicit header, CRC).
inline real lora_time_on_air_ms(int sf, int app_payload_bytes = 4) {
  const int pl = app_payload_bytes + LORAWAN_OVERHEAD_BYTES;
  const real t_sym = static_cast<real>(1 << sf) / static_cast<real>(125000.0) * static_cast<real>(1000.0);
  const int de = sf >= 11 ? 1 : 0;
  const int num = 8 * pl - 4 * sf + 28 + 16;
  const int den = 4 * (sf - 2 * de);
  const int ceil_div = (num + den - 1) / den;
  const int n_payload = 8 + (ceil_div > 0 ? ceil_div * 5 : 0);
  return (static_cast<real>(8.0) + static_cast<real>(4.25)) * t_sym + static_cast<real>(n_payload) * t_sym;
}

/// Lowest SF (7..10) meeting SNR + 5 dB margin within the AS923 400 ms dwell limit.
inline int adr_select_sf(real snr_db) {
  static const real req[4] = {-7.5, -10.0, -12.5, -15.0};
  for (int sf = 7; sf <= 10; ++sf) {
    if (snr_db >= req[sf - 7] + ADR_MARGIN_DB && lora_time_on_air_ms(sf) <= DWELL_LIMIT_MS) return sf;
  }
  return 10;
}

// ================================================================ one complete wake cycle
struct NodeConfig {
  const char* sensor_id;  // "EN-01".."EN-10"
  const char* device_eui; // 16 hex chars
  bool has_geom;
  ConduitGeom geom;
  real full_scale_m;      // D for h/D (conduit rise, lagoon 6.5 m, rack 2.0 m)
  real mount_mm;          // transducer -> depth datum distance
};

struct CycleInputs {
  const real* raw_mm;     // raw A02YYUW distances (uncompensated)
  std::size_t n;
  real temp_c;
  real dt_min;
  real vbat_v;
  bool sensor_fault;
  bool bench_demo;
  bool standpipe;
  real pipe_height_mm;
};

enum SatFlags : uint8_t { SAT_DEPTH = 1, SAT_DHDT = 2, SAT_CAP = 4, FLAG_BLIND = 8, FLAG_BELOW_RANGE = 16 };

struct CycleResult {
  real d_med_mm;
  real sigma_d2;
  real turbulence;
  real measured_depth_mm;
  real raw_depth_mm;
  real depth_mm;
  real dh_dt_mm_min;
  real h_over_d;
  Hydraulics hyd;  // valid when cfg.has_geom
  real he_m;
  real cap_pct;
  QuantFeatures features;
  uint8_t anomaly;
  FsmDecision fsm;
  uint32_t payload;
  uint8_t flags;
};

inline CycleResult run_cycle(const NodeConfig& cfg, KalmanState& kf, const CycleInputs& in) {
  CycleResult r{};
  const real dt_min = in.standpipe ? in.dt_min * BENCH_TIME_COMPRESSION : in.dt_min;
  real comp[MAX_BURST];
  const std::size_t n = in.n > MAX_BURST ? MAX_BURST : in.n;
  for (std::size_t i = 0; i < n; ++i) comp[i] = thermal_compensate(in.raw_mm[i], in.temp_c);
  const BurstStats bs = median_and_variance(comp, n);
  real d_med = bs.d_med_mm;
  if (d_med <= BLIND_ZONE_MM + static_cast<real>(1.0)) r.flags |= FLAG_BLIND;
  if (d_med > MAX_RANGE_MM) {
    r.flags |= FLAG_BELOW_RANGE;
    d_med = MAX_RANGE_MM;
  }
  const real last = comp[n - 1];
  const real zero = 0;
  if (in.standpipe) {
    const real water = clampv(in.pipe_height_mm - d_med, zero, in.pipe_height_mm);
    r.measured_depth_mm = standpipe_scaled_depth_mm(water, in.pipe_height_mm, cfg.full_scale_m);
    r.raw_depth_mm = standpipe_scaled_depth_mm(clampv(in.pipe_height_mm - last, zero, in.pipe_height_mm), in.pipe_height_mm, cfg.full_scale_m);
  } else {
    r.measured_depth_mm = clampv(cfg.mount_mm - d_med, zero, cfg.mount_mm - BLIND_ZONE_MM);
    r.raw_depth_mm = clampv(cfg.mount_mm - last, zero, cfg.mount_mm);
  }
  kalman_step(kf, r.measured_depth_mm, bs.sigma_d2, dt_min);
  r.d_med_mm = d_med;
  r.sigma_d2 = bs.sigma_d2;
  r.turbulence = bs.turbulence;
  r.depth_mm = kf.h > 0 ? kf.h : 0;
  r.dh_dt_mm_min = kf.v;
  r.h_over_d = r.depth_mm / static_cast<real>(1000.0) / cfg.full_scale_m;
  if (cfg.has_geom) {
    r.hyd = hydraulics_at_depth(cfg.geom, r.depth_mm / static_cast<real>(1000.0));
    r.he_m = r.hyd.specific_energy_m;
    r.cap_pct = r.hyd.capacity_pct;
  } else {
    r.hyd = Hydraulics{0, 0, 0, false, 0, 0, false};
    r.he_m = r.depth_mm / static_cast<real>(1000.0);
    r.cap_pct = (r.h_over_d < static_cast<real>(1.27) ? r.h_over_d : static_cast<real>(1.27)) * static_cast<real>(100.0);
  }
  r.features = quantize_features(r.h_over_d, r.dh_dt_mm_min, r.turbulence, r.he_m);
  r.anomaly = classify_quantized(r.features, cfg.has_geom && r.hyd.has_froude, r.hyd.froude, in.vbat_v, in.sensor_fault);
  r.fsm = fsm_next(r.h_over_d, r.dh_dt_mm_min, r.anomaly, in.bench_demo);
  r.payload = pack_payload(r.depth_mm, r.dh_dt_mm_min, r.cap_pct, r.anomaly, in.vbat_v);
  if (r.depth_mm > static_cast<real>(5115.0)) r.flags |= SAT_DEPTH;
  if (r.dh_dt_mm_min > static_cast<real>(127.0) || r.dh_dt_mm_min < static_cast<real>(-128.0)) r.flags |= SAT_DHDT;
  if (r.cap_pct > static_cast<real>(127.0)) r.flags |= SAT_CAP;
  return r;
}

// ================================================================ [EDGE_TX] JSON frame (no heap)
/// Writes one telemetry line consumed by scripts/serial_bridge.py and
/// POST /api/v1/ingest/lorawan. Returns chars written (truncated output is still valid JSON-free).
inline int format_edge_tx(char* buf, std::size_t cap, const NodeConfig& cfg, const CycleInputs& in, const CycleResult& r,
                          uint32_t seq, const char* fw_version) {
  char hex[11];
  char b64[9];
  payload_hex(r.payload, hex);
  payload_b64(r.payload, b64);
  char burst[16 * 10];
  int bl = 0;
  const std::size_t n = in.n > MAX_BURST ? MAX_BURST : in.n;
  for (std::size_t i = 0; i < n && bl < static_cast<int>(sizeof(burst)) - 10; ++i) {
    bl += std::snprintf(burst + bl, sizeof(burst) - static_cast<std::size_t>(bl), "%s%.1f", i ? "," : "",
                        static_cast<double>(in.raw_mm[i]));
  }
  burst[bl] = '\0';
  char sat[96];
  int sl = 0;
  sat[0] = '\0';
  const char* names[5] = {"depth_mm", "dh_dt_mm_min", "cap_pct", "blind_zone", "below_range"};
  for (int k = 0; k < 5; ++k) {
    if (r.flags & (1u << k)) sl += std::snprintf(sat + sl, sizeof(sat) - static_cast<std::size_t>(sl), "%s\"%s\"", sl ? "," : "", names[k]);
  }
  char hyd[160];
  if (cfg.has_geom && !r.hyd.pressurized) {
    std::snprintf(hyd, sizeof(hyd), "\"flow_cms\":%.4f,\"velocity_ms\":%.3f,\"froude_number\":%.3f", static_cast<double>(r.hyd.flow_cms),
                  static_cast<double>(r.hyd.velocity_ms), static_cast<double>(r.hyd.froude));
  } else if (cfg.has_geom) {
    std::snprintf(hyd, sizeof(hyd), "\"flow_cms\":%.4f,\"velocity_ms\":%.3f,\"froude_number\":null", static_cast<double>(r.hyd.flow_cms),
                  static_cast<double>(r.hyd.velocity_ms));
  } else {
    std::snprintf(hyd, sizeof(hyd), "\"flow_cms\":null,\"velocity_ms\":null,\"froude_number\":null");
  }
  return std::snprintf(
      buf, cap,
      "{\"device_eui\":\"%s\",\"device_eui_hex\":\"%s\",\"payload_hex\":\"%s\",\"payload_b64\":\"%s\",\"fport\":%d,"
      "\"raw_burst_mm\":[%s],\"raw_unfiltered_depth_mm\":%.1f,\"median_depth_mm\":%.1f,\"kalman_filtered_depth_mm\":%.1f,"
      "\"dh_dt_mm_min\":%.2f,\"sigma_d2_mm2\":%.2f,\"turbulence_index\":%.4f,\"h_over_d\":%.4f,\"capacity_pct\":%.1f,"
      "%s,\"specific_energy_m\":%.3f,\"anomaly_class\":\"%s\",\"anomaly_code\":%u,\"fsm_state\":\"%s\",\"next_wake_s\":%lu,"
      "\"temperature_c\":%.2f,\"vbat_v\":%.2f,\"saturated_fields\":[%s],\"bench_demo\":%s,"
      "\"standpipe\":{\"enabled\":%s,\"pipe_height_mm\":%.0f},\"seq\":%lu,\"fw\":\"%s\"}",
      cfg.sensor_id, cfg.device_eui, hex, b64, LORA_FPORT, burst, static_cast<double>(r.raw_depth_mm), static_cast<double>(r.measured_depth_mm),
      static_cast<double>(r.depth_mm), static_cast<double>(r.dh_dt_mm_min), static_cast<double>(r.sigma_d2), static_cast<double>(r.turbulence),
      static_cast<double>(r.h_over_d), static_cast<double>(r.cap_pct), hyd, static_cast<double>(r.he_m), anomaly_name(r.anomaly),
      static_cast<unsigned>(r.anomaly), fsm_name(r.fsm.state), static_cast<unsigned long>(r.fsm.wake_s), static_cast<double>(in.temp_c),
      static_cast<double>(in.vbat_v), sat, in.bench_demo ? "true" : "false", in.standpipe ? "true" : "false",
      static_cast<double>(in.pipe_height_mm), static_cast<unsigned long>(seq), fw_version);
}

}  // namespace edge
