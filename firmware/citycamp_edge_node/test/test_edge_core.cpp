// Host-side verification harness for edge_core.hpp (compiled by scripts/test_phase5_firmware.py).
//
//   test_edge_core --selftest      built-in unit tests (golden vectors, UART, median, Kalman,
//                                  classifier discrimination, standpipe sweep); exit 0 == pass
//   test_edge_core --vectors       line protocol on stdin -> results on stdout, diffed against
//                                  backend/edge_dsp.py by the Python driver
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "edge_core.hpp"
#include "node_profiles.hpp"

using edge::real;

static int g_fail = 0;
static int g_pass = 0;
#define CHECK(cond, msg)                                     \
  do {                                                       \
    if (cond) {                                              \
      ++g_pass;                                              \
    } else {                                                 \
      ++g_fail;                                              \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, msg); \
    }                                                        \
  } while (0)

static bool near(real a, real b, real tol) { return (a > b ? a - b : b - a) <= tol; }

// Deterministic LCG (no <random>, keeps the harness heap-free too).
static uint32_t g_lcg = 12345u;
static real urand() {
  g_lcg = g_lcg * 1103515245u + 12345u;
  return static_cast<real>((g_lcg >> 8) & 0xFFFFFF) / static_cast<real>(16777216.0);
}

static int selftest() {
  // 1. CLAUDE.md §10 golden vectors
  CHECK(edge::pack_payload(5115, -1, 127, 7, 4.20f) == 0xFFFFFFFFu, "golden 0xFFFFFFFF");
  CHECK(edge::pack_payload(5115, 127, 127, 7, 4.20f) == 0xFFDFFFFFu, "golden 0xFFDFFFFF");
  CHECK(edge::pack_payload(0, -128, 0, 0, 3.00f) == 0x00200000u, "golden 0x00200000");
  CHECK(edge::pack_payload(9999, 999, 999, 4, 9.9f) == edge::pack_payload(5115, 127, 127, 4, 4.2f), "saturation, never wrap");
  const edge::Decoded d = edge::unpack_payload(0xFFC036CFu);
  CHECK(d.depth_mm == 5115 && d.dh_dt_mm_min == 0 && d.cap_pct == 109 && d.anom_code == 4 && near(d.vbat_v, 4.2f, 1e-4f), "unpack EN-07 typhoon word");
  char hex[11], b64[9];
  edge::payload_hex(0x8A4F321Cu, hex);
  edge::payload_b64(0x8A4F321Cu, b64);
  CHECK(std::strcmp(hex, "0x8A4F321C") == 0, "hex formatting");
  CHECK(std::strcmp(b64, "ik8yHA==") == 0, "base64 formatting");

  // 2. A02YYUW UART checksum + blind zone
  const uint8_t ok[4] = {0xFF, 0x04, 0xD2, static_cast<uint8_t>((0xFF + 0x04 + 0xD2) & 0xFF)};
  const uint8_t bad[4] = {0xFF, 0x04, 0xD2, 0x00};
  const uint8_t blind[4] = {0xFF, 0x00, 0x14, static_cast<uint8_t>((0xFF + 0x14) & 0xFF)};
  const uint8_t far[4] = {0xFF, 0x11, 0xF8, static_cast<uint8_t>((0xFF + 0x11 + 0xF8) & 0xFF)};
  CHECK(edge::parse_a02yyuw_frame(ok).status == edge::UartStatus::Ok && edge::parse_a02yyuw_frame(ok).distance_mm == 1234, "uart ok 1234 mm");
  CHECK(edge::parse_a02yyuw_frame(bad).status == edge::UartStatus::BadChecksum, "uart bad checksum");
  CHECK(edge::parse_a02yyuw_frame(blind).status == edge::UartStatus::BlindZone, "uart 20 mm blind zone");
  CHECK(edge::parse_a02yyuw_frame(far).status == edge::UartStatus::OutOfRange, "uart 4600 mm out of range");
  edge::A02yyuwStream stream;
  const uint8_t noisy[] = {0x12, 0x00, 0xFF, 0x04, 0xD2, ok[3]};
  bool got = false;
  for (uint8_t b : noisy) got = stream.feed(b) || got;
  CHECK(got && edge::parse_a02yyuw_frame(stream.frame).distance_mm == 1234, "uart stream resync");

  // 3. median splash rejection + Kalman convergence under splashing
  const real burst[10] = {1000, 1001, 999, 1000, 450, 1002, 998, 1000, 1001, 999};
  const edge::BurstStats bs = edge::median_and_variance(burst, 10);
  CHECK(near(bs.d_med_mm, 1000, 1.0f), "median rejects splash");
  CHECK(bs.sigma_d2 > 1000, "raw variance keeps spike energy");
  edge::KalmanState kf = edge::kalman_init();
  real truth = 500;
  for (int k = 0; k < 120; ++k) {
    truth += 3;  // 6 mm/min at dt = 0.5 min
    const real z = truth + (urand() - 0.5f) * 16 + (urand() < 0.05f ? -300 : 0);
    edge::kalman_step(kf, z, near(z, truth, 50) ? 64 : 40000, 0.5f);
  }
  CHECK(near(kf.h, truth, 20), "kalman tracks depth through splashes");
  CHECK(near(kf.v, 6, 4), "kalman tracks dh/dt (sigma ~1.8 mm/min)");

  // 4. hydraulics: circular paradox
  const edge::ConduitGeom circ{edge::Shape::Circular, 1.0f, 1.0f, 0, 0.013f, 0.02f};
  const edge::QMax qm = edge::q_max(circ);
  CHECK(near(qm.y_ratio, 0.938f, 0.002f), "Q_max at h/D 0.938");
  CHECK(near(qm.q / edge::q_full(circ), 1.076f, 0.003f), "Q_max = 1.076 Q_full");

  // 5. classifier: flash surge vs trash blockage
  auto cls = [](real h, real v, real s2) {
    return edge::classify_quantized(edge::quantize_features(h, v, std::log1p(s2), 0.5f), true, 0.5f, 4.0f, false);
  };
  CHECK(cls(0.45f, 40, 400) == edge::ANOMALY_FLASH_SURGE, "flash surge: steep dh/dt + chop");
  CHECK(cls(0.72f, 0.5f, 9) == edge::ANOMALY_TRASH_BLOCKAGE, "blockage: deep, flat, quiet");
  CHECK(cls(0.72f, 0.5f, 400) == edge::ANOMALY_NORMAL, "deep but choppy is not ponding");
  CHECK(cls(1.05f, 0, 5) == edge::ANOMALY_SURCHARGED, "h >= D surcharged");
  CHECK(edge::classify_quantized(edge::quantize_features(0.2f, 0, 1, 0.2f), false, 0, 3.2f, false) == edge::ANOMALY_LOW_BATTERY, "low battery");
  CHECK(edge::classify_quantized(edge::quantize_features(1.2f, 0, 1, 0.2f), false, 0, 3.2f, false) == edge::ANOMALY_SURCHARGED, "battery never masks surcharge");

  // 6. bench standpipe sweep EN-01 (0.6 m RCPC): 0 -> 85 cm crosses 75 % and ends surcharged
  const int i01 = edge::find_node_profile("EN-01");
  CHECK(i01 == 0, "profile lookup EN-01");
  // Capacity rises with level except the closed-conduit paradox dip between h/D 0.938
  // (Q_max = 1.076 Q_full) and the crown (100 %): allow that dip, nothing larger.
  real last_cap = -1;
  real worst_dip = 0;
  edge::KalmanState kp = edge::kalman_init();
  edge::CycleResult res{};
  for (int mm = 0; mm <= 850; mm += 10) {
    real raw[10];
    for (real& r : raw) r = static_cast<real>(1000 - mm) * edge::SPEED_OF_SOUND_REF / edge::speed_of_sound(14);
    kp = edge::kalman_init();
    const edge::CycleInputs in{raw, 10, 14, 1.0f / 60.0f, 4.1f, false, true, true, 1000};
    res = edge::run_cycle(edge::NODE_PROFILES[i01], kp, in);
    if (last_cap - res.cap_pct > worst_dip) worst_dip = last_cap - res.cap_pct;
    last_cap = res.cap_pct;
  }
  CHECK(worst_dip <= 8.0f, "standpipe sweep only dips by the Q_max paradox (<= 8 points)");
  CHECK(res.anomaly == edge::ANOMALY_SURCHARGED && res.cap_pct > 110, "85 cm in a 1 m standpipe -> >110 % surcharged");
  CHECK(res.fsm.wake_s == 1, "bench demo streams every second");
  CHECK(near(edge::lora_time_on_air_ms(7), 51.456f, 0.01f), "LoRa SF7 time-on-air 51.5 ms");
  CHECK(edge::lora_time_on_air_ms(10) < edge::DWELL_LIMIT_MS, "SF10 within AS923 400 ms dwell");

  std::printf("selftest: %d passed, %d failed (%s precision)\n", g_pass, g_fail, sizeof(real) == 8 ? "double" : "float");
  return g_fail == 0 ? 0 : 1;
}

// ---------------------------------------------------------------- vector protocol
static double next_d(char*& p) { return std::strtod(p, &p); }
static long next_l(char*& p) { return std::strtol(p, &p, 10); }

static edge::CycleResult cycle_from(char*& p, edge::KalmanState& kf, edge::CycleInputs& in, real* raw, int& idx) {
  idx = static_cast<int>(next_l(p));
  const long n = next_l(p);
  for (long i = 0; i < n && i < 16; ++i) raw[i] = static_cast<real>(next_d(p));
  in.raw_mm = raw;
  in.n = static_cast<std::size_t>(n);
  in.temp_c = static_cast<real>(next_d(p));
  in.dt_min = static_cast<real>(next_d(p));
  in.vbat_v = static_cast<real>(next_d(p));
  in.sensor_fault = next_l(p) != 0;
  in.bench_demo = next_l(p) != 0;
  in.standpipe = next_l(p) != 0;
  in.pipe_height_mm = static_cast<real>(next_d(p));
  kf.h = static_cast<real>(next_d(p));
  kf.v = static_cast<real>(next_d(p));
  kf.p00 = static_cast<real>(next_d(p));
  kf.p01 = static_cast<real>(next_d(p));
  kf.p11 = static_cast<real>(next_d(p));
  kf.initialized = static_cast<uint8_t>(next_l(p));
  return edge::run_cycle(edge::NODE_PROFILES[idx], kf, in);
}

static int vectors() {
  static char line[4096];
  while (std::fgets(line, sizeof(line), stdin)) {
    char cmd[16] = {0};
    int off = 0;
    if (std::sscanf(line, "%15s%n", cmd, &off) != 1) continue;
    char* p = line + off;
    if (!std::strcmp(cmd, "PACK")) {
      const double dmm = next_d(p), dh = next_d(p), cap = next_d(p);
      const long an = next_l(p);
      const double vb = next_d(p);
      std::printf("0x%08lX\n", static_cast<unsigned long>(edge::pack_payload(static_cast<real>(dmm), static_cast<real>(dh), static_cast<real>(cap), static_cast<uint8_t>(an), static_cast<real>(vb))));
    } else if (!std::strcmp(cmd, "B64")) {
      char b[9];
      edge::payload_b64(static_cast<uint32_t>(std::strtoul(p, &p, 10)), b);
      std::printf("%s\n", b);
    } else if (!std::strcmp(cmd, "THERM")) {
      const double dr = next_d(p), t = next_d(p);
      std::printf("%.17g\n", static_cast<double>(edge::thermal_compensate(static_cast<real>(dr), static_cast<real>(t))));
    } else if (!std::strcmp(cmd, "STATS")) {
      real s[16];
      const long n = next_l(p);
      for (long i = 0; i < n && i < 16; ++i) s[i] = static_cast<real>(next_d(p));
      const edge::BurstStats b = edge::median_and_variance(s, static_cast<std::size_t>(n));
      std::printf("%.17g %.17g %.17g\n", static_cast<double>(b.d_med_mm), static_cast<double>(b.sigma_d2), static_cast<double>(b.turbulence));
    } else if (!std::strcmp(cmd, "KALMAN")) {
      edge::KalmanState kf = edge::kalman_init();
      const long n = next_l(p);
      for (long i = 0; i < n; ++i) {
        const double z = next_d(p), s2 = next_d(p), dt = next_d(p);
        edge::kalman_step(kf, static_cast<real>(z), static_cast<real>(s2), static_cast<real>(dt));
      }
      std::printf("%.17g %.17g %.17g %.17g %.17g\n", static_cast<double>(kf.h), static_cast<double>(kf.v), static_cast<double>(kf.p00), static_cast<double>(kf.p01), static_cast<double>(kf.p11));
    } else if (!std::strcmp(cmd, "HYD")) {
      edge::ConduitGeom g{};
      g.shape = static_cast<edge::Shape>(next_l(p));
      g.rise_m = static_cast<real>(next_d(p));
      g.span_m = static_cast<real>(next_d(p));
      g.haunch_m = static_cast<real>(next_d(p));
      g.manning_n = static_cast<real>(next_d(p));
      g.slope = static_cast<real>(next_d(p));
      const real y = static_cast<real>(next_d(p));
      const edge::SectionProps sp = edge::section_props(g, y);
      const edge::QMax qm = edge::q_max(g);
      const edge::Hydraulics h = edge::hydraulics_at_depth(g, y);
      std::printf("%.17g %.17g %.17g %.17g %.17g %.17g %.17g %.17g %.17g %.17g %d %.17g %.17g %d\n", static_cast<double>(sp.a), static_cast<double>(sp.p), static_cast<double>(sp.t),
                  static_cast<double>(edge::manning_q(g, y)), static_cast<double>(edge::q_full(g)), static_cast<double>(qm.q), static_cast<double>(qm.y_ratio),
                  static_cast<double>(h.flow_cms), static_cast<double>(h.velocity_ms), static_cast<double>(h.froude), h.has_froude ? 1 : 0,
                  static_cast<double>(h.specific_energy_m), static_cast<double>(h.capacity_pct), h.pressurized ? 1 : 0);
    } else if (!std::strcmp(cmd, "CLS")) {
      const double h = next_d(p), v = next_d(p), s = next_d(p), e = next_d(p);
      const long hasfr = next_l(p);
      const double fr = next_d(p), vb = next_d(p);
      const long fault = next_l(p);
      const edge::QuantFeatures f = edge::quantize_features(static_cast<real>(h), static_cast<real>(v), static_cast<real>(s), static_cast<real>(e));
      std::printf("%u %d %d %d %d\n", static_cast<unsigned>(edge::classify_quantized(f, hasfr != 0, static_cast<real>(fr), static_cast<real>(vb), fault != 0)), f.q_h, f.q_v, f.q_s, f.q_e);
    } else if (!std::strcmp(cmd, "UART")) {
      uint8_t f[4];
      for (uint8_t& b : f) b = static_cast<uint8_t>(next_l(p));
      const edge::UartReading r = edge::parse_a02yyuw_frame(f);
      std::printf("%u %.17g\n", static_cast<unsigned>(r.status), static_cast<double>(r.distance_mm));
    } else if (!std::strcmp(cmd, "FSM")) {
      const double h = next_d(p), v = next_d(p);
      const long code = next_l(p), bench = next_l(p);
      const edge::FsmDecision f = edge::fsm_next(static_cast<real>(h), static_cast<real>(v), static_cast<uint8_t>(code), bench != 0);
      std::printf("%u %lu %lu %.17g\n", static_cast<unsigned>(f.state), static_cast<unsigned long>(f.wake_s), static_cast<unsigned long>(f.uplink_s), static_cast<double>(f.current_ua));
    } else if (!std::strcmp(cmd, "TOA")) {
      std::printf("%.17g\n", static_cast<double>(edge::lora_time_on_air_ms(static_cast<int>(next_l(p)))));
    } else if (!std::strcmp(cmd, "STAND")) {
      const double w = next_d(p), ph = next_d(p), r = next_d(p);
      std::printf("%.17g\n", static_cast<double>(edge::standpipe_scaled_depth_mm(static_cast<real>(w), static_cast<real>(ph), static_cast<real>(r))));
    } else if (!std::strcmp(cmd, "CYCLE") || !std::strcmp(cmd, "EDGETX")) {
      edge::KalmanState kf{};
      edge::CycleInputs in{};
      real raw[16];
      int idx = 0;
      const edge::CycleResult r = cycle_from(p, kf, in, raw, idx);
      if (!std::strcmp(cmd, "EDGETX")) {
        static char js[2048];
        edge::format_edge_tx(js, sizeof(js), edge::NODE_PROFILES[idx], in, r, 1, "host-test");
        std::printf("[EDGE_TX] %s\n", js);
      } else {
        std::printf("%.17g %.17g %.17g %.17g %.17g %.17g %.17g %.17g %.17g %.17g %u %u %lu %lu 0x%08lX %u %.17g %.17g %.17g %.17g %.17g\n",
                    static_cast<double>(r.d_med_mm), static_cast<double>(r.sigma_d2), static_cast<double>(r.turbulence), static_cast<double>(r.measured_depth_mm),
                    static_cast<double>(r.raw_depth_mm), static_cast<double>(r.depth_mm), static_cast<double>(r.dh_dt_mm_min), static_cast<double>(r.h_over_d),
                    static_cast<double>(r.he_m), static_cast<double>(r.cap_pct), static_cast<unsigned>(r.anomaly), static_cast<unsigned>(r.fsm.state),
                    static_cast<unsigned long>(r.fsm.wake_s), static_cast<unsigned long>(r.fsm.uplink_s), static_cast<unsigned long>(r.payload), static_cast<unsigned>(r.flags),
                    static_cast<double>(kf.h), static_cast<double>(kf.v), static_cast<double>(kf.p00), static_cast<double>(kf.p01), static_cast<double>(kf.p11));
      }
    } else {
      std::printf("ERR unknown %s\n", cmd);
    }
  }
  return 0;
}

int main(int argc, char** argv) {
  if (argc > 1 && !std::strcmp(argv[1], "--vectors")) return vectors();
  return selftest();
}
