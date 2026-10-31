// =============================================================================
// City Camp Lagoon Edge-AI twin: UNIVERSAL HC-SR04 NODE (Phase 8)
// One Arduino IDE sketch for BOTH boards, no external libraries:
//   * ESP32-S3 (any ESP32 core board)  USB serial + Wi-Fi HTTP uplink to the FastAPI backend
//   * Arduino Uno (AVR)                 USB serial only
//
// Pipeline (mirrors backend/edge_dsp.py::run_cycle, bench-standpipe branch; checked bit-for-bit
// on the host by scripts/test_phase5_firmware.py):
//   HC-SR04 echo at 10 Hz -> distance at the 343.2 m/s reference -> thermal compensation ->
//   10-sample window, median of 5-point sliding medians + variance sigma_d2 -> fill on the bench
//   scale (100 % = 74 % of TANK_HEIGHT_MM) scaled to the map node's depth -> 1D Kalman
//   (dt x60: 1 bench-second = 1 storm-minute) -> INT8 classifier -> 32-bit uplink word (CLAUDE.md §10).
//
// LEDs:  < 45 % green  |  45-79 % yellow  |  >= 80 % red blinking at 3 Hz (the 3D map's alarm)
// USB:   115200 baud, every 200 ms
//          [EDGE_TX] {"device_eui":"EN-08","dist_mm":..,"fill_pct":..,"payload_hex":"0x..",...}
//          DIST_MM:<mm>        (plain line for any generic parser; the web rig prefers EDGE_TX)
// Wi-Fi: ESP32 only, when WIFI_SSID is set: a background task POSTs every 500 ms to
//          http://SERVER_IP:8000/api/v1/ingest/distance
//        so a battery-powered ESP32-S3 drives the 3D map with no cable. Every 5 s the USB console
//        prints LINK_STATUS:... with the Wi-Fi state and the last HTTP result.
//        Copy node_config.example.h to node_config.h (git-ignored) for your Wi-Fi and PC address.
// Missed echoes: a sample with no echo repeats the last good one; after ECHO_FAULT_MISSES in a row
//   the frame is flagged SENSOR_FAULT so the map never shows a dead sensor's last value as live.
//   With no echo since boot nothing can be measured: SENSOR_FAULT:NO_ECHO is printed instead.
// Black box (Phase 9C, blackbox.h): every 5th report (1 Hz) the 32-bit frame is logged.
//   Tier 1  SPI microSD: /telemetry_log.bin (12-byte records: t_ms, seq, word, big-endian) and
//           /telemetry_log.csv (readable: time, distance, fill, depth, rate, anomaly, payload).
//           Boot prints SD_STATUS:OK_SPI_CARD.
//   Tier 2  if SD.begin() fails, or a later write fails (loose jumper), the node switches at once to
//           its internal ring of the last frames and prints SD_STATUS:OK_FLASH_FAILSAFE. It never
//           halts. ESP32: 256-frame RAM ring mirrored to NVS flash every 64 frames, and the card is
//           retried every SD_RETRY_MS. Uno: 255-frame EEPROM ring (1 KB). (SD.begin()'s own timeout
//           on a missing card is library-dependent.)
//   Console: DUMP_SD_LOG streams the ring as [SD_DUMP] lines + [SD_DUMP_END] {frames, crc32,
//            tier}; SD_STATUS reprints the tier. The web app (Black-box SD recovery) sends it.
//   SD wiring (ESP32-S3, set explicitly so every board variant agrees): CS GPIO10, MOSI GPIO11,
//   SCK GPIO12, MISO GPIO13. VCC: 5 V on modules with a regulator, 3V3 on bare card sockets.
//   Uno: SD is off by default (hardware SPI needs D10, which is ECHO here); set BLACKBOX_SD 1 and
//   move ECHO to D7 (ECHO_PIN) to use a card on D8 (SD_CS_PIN); the EEPROM ring always works.
//
// WIRING. Read these notes first (ESP32-S3 + HW-131 guide: docs/HARDWARE_BENCH_DEMO_GUIDE.md §7):
//   1. ESP32-S3 GPIOs are NOT 5 V tolerant. This rig powers the HC-SR04 from the HW-131 3.3 V rail,
//      so ECHO is a 3.3 V signal and goes straight to GPIO18. If the sensor is ever moved to 5 V,
//      ECHO needs a divider: ECHO -> 1 k -> GPIO18, and GPIO18 -> 2 k -> GND.
//   2. A bare LED straight on a GPIO has no current limit. Use LED modules with built-in
//      resistors (common in sensor kits), or put a 220-330 ohm resistor in series.
//   3. The ESP32-S3 runs from the HW-131 3.3 V rail into its 3V3 pin. Never put 5 V on that pin.
//      The SD module takes the 5 V rail. All grounds must be common.
//            ESP32-S3   Arduino Uno
//   TRIG       GPIO5        D9
//   ECHO       GPIO18       D10
//   LED green  GPIO7        D4
//   LED yellow GPIO8        D5
//   LED red    GPIO9        D6
// Mount the sensor face-down above the tank, TANK_HEIGHT_MM from its face to the tank floor.
// =============================================================================
#include <Arduino.h>
#include <math.h>
#if defined(ESP32)
#include <WiFi.h>
#include <HTTPClient.h>
#endif
#include "blackbox.h"
#include "edge_crypto.h"
#if !defined(UNIVERSAL_HOST_BUILD) && __has_include("node_config.h")
#include "node_config.h"          // your Wi-Fi + PC address, see node_config.example.h
#endif

// ---------------------------------------------------------------- user configuration
#ifndef DEVICE_EUI
#define DEVICE_EUI "EN-08"        // map sensor this rig represents (EN-01 .. EN-10)
#endif
#ifndef TANK_HEIGHT_MM
#define TANK_HEIGHT_MM 300.0      // sensor face -> tank floor
#endif
#ifndef NODE_FULL_SCALE_M
#define NODE_FULL_SCALE_M 2.0     // full-scale depth D of that map node (EN-08 rack opening 2.0 m)
#endif
#ifndef AIR_TEMP_C
#define AIR_TEMP_C 24.0           // no DS18B20 on this build: room temperature
#endif
#define VBAT_V 4.05               // fixed nominal: no battery ADC on this build, so not a measurement
#define SAMPLE_PERIOD_MS 100UL    // 10 Hz ultrasonic reads
#define REPORT_EVERY 2            // print / uplink every 2nd sample (5 Hz)
#ifndef WIFI_SSID
#define WIFI_SSID ""              // set to enable the ESP32 Wi-Fi uplink
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif
#ifndef SERVER_IP
#define SERVER_IP "192.168.1.100" // PC running `npm start` (FastAPI on port 8000)
#endif
#define SERVER_PORT 8000
#ifndef UPLINK_SCOPE
#define UPLINK_SCOPE "single_node" // or "full_catchment"
#endif
#define POST_PERIOD_MS 500
#define HTTP_TIMEOUT_MS 1500
#define WIFI_RETRY_MS 15000UL     // association can take several seconds: do not restart it sooner
#define LINK_STATUS_MS 5000UL
#ifndef WIFI_TX_POWER
#define WIFI_TX_POWER WIFI_POWER_8_5dBm  // lower TX current peaks: a 9 V cell through a linear regulator sags at full power
#endif
#define ECHO_FAULT_MISSES 10      // 1 s of consecutive missed echoes at 10 Hz
#ifndef BLACKBOX_SD
#if defined(ESP32)
#define BLACKBOX_SD 1             // SPI microSD logging (tier 1)
#else
#define BLACKBOX_SD 0             // Uno: see the SD wiring note above
#endif
#endif
#define BLACKBOX_EVERY 5          // log every 5th report: 1 frame per second
#define SD_RETRY_MS 30000UL       // ESP32: re-mount a card that failed or dropped out
#ifndef EDGE_CRYPTO
#define EDGE_CRYPTO 0             // 1: [EDGE_TX] carries cipher_hex / tag_hex / nonce instead of payload_hex (edge_crypto.h)
#endif

// ---------------------------------------------------------------- pins
#if defined(ESP32)
#define TRIG_PIN 5
#define ECHO_PIN 18
#define LED_GREEN 7
#define LED_YELLOW 8
#define LED_RED 9
#define SD_CS_PIN 10
#define SD_MOSI_PIN 11
#define SD_SCK_PIN 12
#define SD_MISO_PIN 13
#else
#define TRIG_PIN 9
#ifndef ECHO_PIN
#define ECHO_PIN 10
#endif
#define LED_GREEN 4
#define LED_YELLOW 5
#define LED_RED 6
#define SD_CS_PIN 8
#endif

#if BLACKBOX_SD
#include <SPI.h>
#include <SD.h>
#endif
#if defined(ESP32)
#include <Preferences.h>
#include <time.h>
#else
#include <EEPROM.h>
#endif

#ifdef UNIVERSAL_USE_DOUBLE
typedef double real_t;
#else
typedef float real_t;
#endif

// ---------------------------------------------------------------- edge pipeline (edge_dsp.py)
namespace edge {
const real_t SPEED_OF_SOUND_REF = 343.2;
const real_t MIN_DIST_MM = 20.0;
const real_t MAX_RANGE_MM = 4500.0;
const int BURST_LEN = 10;
const int MEDIAN_WIN = 5;
const real_t KF_Q = 9.0;
const real_t KF_R_BASE = 25.0;
const real_t KF_ALPHA = 0.5;
const real_t KF_P0_H = 400.0;
const real_t KF_P0_V = 100.0;
const real_t KF_MIN_DT_MIN = 1e-3;
const real_t FULL_BORE_FRACTION = 0.74;
const real_t BENCH_TIME_COMPRESSION = 60.0;
const int H_SURCHARGE_Q = 100;
const int H_BLOCKAGE_Q = 60;
const int V_FLASH_Q = 15;
const int S_CALM_Q = 58;
const int S_CHOP_Q = 74;
const real_t VBAT_LOW = 3.30;
const real_t ALARM_PCT = 80.0;
const real_t ELEVATED_PCT = 45.0;

static const char *const ANOMALY_NAMES[8] = {"NORMAL", "FLASH_SURGE", "TRASH_BLOCKAGE", "SUPERCRITICAL",
                                             "SURCHARGED", "SENSOR_FAULT", "LOW_BATTERY", "RESERVED"};

#if defined(__AVR__)
#define EDGE_LOG1P(x) log((real_t)1.0 + (x))  // avr-libc has no log1p
#else
#define EDGE_LOG1P(x) log1p(x)
#endif

inline long round_half_up(real_t x) { return (long)floor(x + (real_t)0.5); }
inline long clampl(long v, long lo, long hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline real_t clampr(real_t v, real_t lo, real_t hi) { return v < lo ? lo : (v > hi ? hi : v); }

inline real_t thermal_compensate(real_t d_raw_mm, real_t temp_c) {
  return d_raw_mm * ((real_t)331.3 + (real_t)0.606 * temp_c) / SPEED_OF_SOUND_REF;
}

inline void sort_small(real_t *v, int n) {
  for (int i = 1; i < n; ++i) {
    real_t x = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > x) {
      v[j + 1] = v[j];
      --j;
    }
    v[j + 1] = x;
  }
}

inline real_t median_of(const real_t *s, int n) {
  real_t t[BURST_LEN];
  for (int i = 0; i < n; ++i) t[i] = s[i];
  sort_small(t, n);
  return (n % 2) ? t[n / 2] : (real_t)0.5 * (t[n / 2 - 1] + t[n / 2]);
}

/** median of the 5-point sliding medians, population variance, ln(1 + variance) */
inline void median_and_variance(const real_t *s, int n, real_t *med, real_t *var, real_t *turb) {
  if (n < MEDIAN_WIN) {
    *med = median_of(s, n);
  } else {
    real_t meds[BURST_LEN];
    int m = 0;
    for (int i = 0; i + MEDIAN_WIN <= n; ++i) meds[m++] = median_of(s + i, MEDIAN_WIN);
    *med = median_of(meds, m);
  }
  real_t mean = 0;
  for (int i = 0; i < n; ++i) mean += s[i];
  mean /= n;
  real_t v = 0;
  for (int i = 0; i < n; ++i) v += (s[i] - mean) * (s[i] - mean);
  *var = v / n;
  *turb = EDGE_LOG1P(*var);
}

struct Kalman {
  real_t h, v, p00, p01, p11;
  bool initialized;
};

inline void kalman_reset(Kalman *k) {
  k->h = 0;
  k->v = 0;
  k->p00 = KF_P0_H;
  k->p01 = 0;
  k->p11 = KF_P0_V;
  k->initialized = false;
}

inline void kalman_step(Kalman *k, real_t z, real_t sigma2, real_t dt_min) {
  if (!k->initialized) {
    k->h = z;
    k->v = 0;
    k->p00 = KF_P0_H;
    k->p01 = 0;
    k->p11 = KF_P0_V;
    k->initialized = true;
    return;
  }
  real_t dt = dt_min > KF_MIN_DT_MIN ? dt_min : KF_MIN_DT_MIN;
  real_t h_p = k->h + k->v * dt;
  real_t v_p = k->v;
  real_t p00 = k->p00 + dt * ((real_t)2.0 * k->p01 + dt * k->p11) + KF_Q * dt * dt * dt / (real_t)3.0;
  real_t p01 = k->p01 + dt * k->p11 + KF_Q * dt * dt / (real_t)2.0;
  real_t p11 = k->p11 + KF_Q * dt;
  real_t r = KF_R_BASE + KF_ALPHA * sigma2;
  real_t s = p00 + r;
  real_t k0 = p00 / s;
  real_t k1 = p01 / s;
  real_t innov = z - h_p;
  k->h = h_p + k0 * innov;
  k->v = v_p + k1 * innov;
  k->p00 = ((real_t)1.0 - k0) * p00;
  k->p01 = ((real_t)1.0 - k0) * p01;
  k->p11 = p11 - k1 * p01;
}

/** 32-bit uplink word, saturating, round-half-up (CLAUDE.md §10) */
inline uint32_t pack_payload(real_t depth_mm, real_t dh_dt, real_t cap_pct, int anom, real_t vbat) {
  uint32_t depth = (uint32_t)clampl(round_half_up(depth_mm / (real_t)5.0), 0, 1023);
  uint32_t dh = (uint32_t)(clampl(round_half_up(dh_dt), -128, 127) & 0xFF);
  uint32_t cap = (uint32_t)clampl(round_half_up(cap_pct), 0, 127);
  uint32_t vb = (uint32_t)clampl(round_half_up((vbat - (real_t)3.0) / (real_t)0.08), 0, 15);
  return (depth << 22) | (dh << 14) | (cap << 7) | ((uint32_t)(anom & 7) << 4) | vb;
}

/** INT8 decision surface: SURCHARGED > TRASH_BLOCKAGE > FLASH_SURGE > LOW_BATTERY > NORMAL */
inline int classify(real_t h_over_d, real_t dh_dt, real_t turbulence, real_t vbat) {
  long q_h = clampl(round_half_up(h_over_d * (real_t)100.0), 0, 127);
  long q_v = clampl(round_half_up(dh_dt), -128, 127);
  long q_s = clampl(round_half_up(turbulence * (real_t)16.0), 0, 127);
  if (q_h >= H_SURCHARGE_Q) return 4;
  if (q_h > H_BLOCKAGE_Q && (q_v < 0 ? -q_v : q_v) < V_FLASH_Q && q_s < S_CALM_Q) return 2;
  if (q_v >= V_FLASH_Q && q_s >= S_CHOP_Q) return 1;
  if (vbat < VBAT_LOW) return 6;
  return 0;
}

struct Result {
  real_t dist_mm, sigma_d2, turbulence, raw_depth_mm, depth_mm, dh_dt_mm_min, h_over_d, cap_pct;
  int anomaly_code;
  uint32_t payload;
};

/** Rolling 10-sample window; until full, the oldest sample pads the front (TS HardwareRig). */
struct Window {
  real_t s[BURST_LEN];
  int n;
};

inline void window_push(Window *w, real_t d) {
  if (w->n < BURST_LEN) {
    w->s[w->n++] = d;
  } else {
    for (int i = 1; i < BURST_LEN; ++i) w->s[i - 1] = w->s[i];
    w->s[BURST_LEN - 1] = d;
  }
}

inline void window_burst(const Window *w, real_t *out) {
  int pad = BURST_LEN - w->n;
  for (int i = 0; i < BURST_LEN; ++i) out[i] = i < pad ? w->s[0] : w->s[i - pad];
}

/** One cycle: run_cycle(geom=None, standpipe=True, pipe_height=tank). Mutates the Kalman state. */
inline Result cycle(Kalman *k, const real_t *burst_raw_mm, real_t temp_c, real_t dt_min, real_t tank_mm, real_t full_scale_m,
                    real_t vbat) {
  Result r;
  real_t comp[BURST_LEN];
  for (int i = 0; i < BURST_LEN; ++i) comp[i] = thermal_compensate(burst_raw_mm[i], temp_c);
  real_t d_med, var, turb;
  median_and_variance(comp, BURST_LEN, &d_med, &var, &turb);
  if (d_med > MAX_RANGE_MM) d_med = MAX_RANGE_MM;
  real_t full_bore = tank_mm * FULL_BORE_FRACTION;
  real_t water = clampr(tank_mm - d_med, 0, tank_mm);
  real_t z = water / full_bore * full_scale_m * (real_t)1000.0;
  real_t raw_water = clampr(tank_mm - comp[BURST_LEN - 1], 0, tank_mm);
  r.raw_depth_mm = raw_water / full_bore * full_scale_m * (real_t)1000.0;
  kalman_step(k, z, var, dt_min * BENCH_TIME_COMPRESSION);
  r.depth_mm = k->h > 0 ? k->h : 0;
  r.dh_dt_mm_min = k->v;
  r.h_over_d = r.depth_mm / (real_t)1000.0 / full_scale_m;
  r.cap_pct = (r.h_over_d < (real_t)1.27 ? r.h_over_d : (real_t)1.27) * (real_t)100.0;
  r.anomaly_code = classify(r.h_over_d, r.dh_dt_mm_min, turb, vbat);
  r.payload = pack_payload(r.depth_mm, r.dh_dt_mm_min, r.cap_pct, r.anomaly_code, vbat);
  r.dist_mm = d_med;
  r.sigma_d2 = var;
  r.turbulence = turb;
  return r;
}

/** run_cycle(sensor_fault=True): the top classifier priority, values otherwise unchanged. */
inline void mark_sensor_fault(Result *r, real_t vbat) {
  r->anomaly_code = 5;
  r->payload = pack_payload(r->depth_mm, r->dh_dt_mm_min, r->cap_pct, 5, vbat);
}

inline void hex32(uint32_t w, char *out) {  // "0x" + 8 upper-case hex digits
  static const char H[] = "0123456789ABCDEF";
  out[0] = '0';
  out[1] = 'x';
  for (int i = 0; i < 8; ++i) out[2 + i] = H[(w >> (28 - 4 * i)) & 0xF];
  out[10] = 0;
}
}  // namespace edge

// ---------------------------------------------------------------- state
static edge::Kalman g_kal;
static edge::Window g_win;
static edge::Result g_last;
static bool g_have = false;
static unsigned long g_last_sample = 0;
static unsigned long g_last_cycle = 0;
static unsigned long g_seq = 0;
static int g_since_report = 0;
static unsigned int g_missed_echoes = 0;

/** HC-SR04 round trip -> one-way mm at the 343.2 m/s reference (thermal comp happens later). */
static real_t read_hcsr04_mm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (us == 0) return -1;
  return (real_t)us * edge::SPEED_OF_SOUND_REF / (real_t)2000.0;  // (m/s -> mm/us) / 2 ways
}

static void update_leds(unsigned long now) {
  real_t pct = g_have ? g_last.cap_pct : 0;
  bool red = pct >= edge::ALARM_PCT;
  bool yellow = !red && pct >= edge::ELEVATED_PCT;
  bool blink_on = ((now / 167UL) % 2UL) == 0UL;  // 3 Hz: 1/6 s on, 1/6 s off
  digitalWrite(LED_GREEN, (!red && !yellow) ? HIGH : LOW);
  digitalWrite(LED_YELLOW, yellow ? HIGH : LOW);
  digitalWrite(LED_RED, (red && blink_on) ? HIGH : LOW);
}

static void print_kv(const char *key, real_t v, int decimals, bool comma = true) {
  Serial.print("\"");
  Serial.print(key);
  Serial.print("\":");
  Serial.print(v, decimals);
  if (comma) Serial.print(",");
}

#if EDGE_CRYPTO
static edgecrypto::Keys g_keys;
#endif

static void print_edge_tx(const edge::Result &r) {
  char hex[11];
  Serial.print("[EDGE_TX] {\"device_eui\":\"" DEVICE_EUI "\",");
  print_kv("dist_mm", r.dist_mm, 1);
  print_kv("fill_pct", r.cap_pct, 1);
#if EDGE_CRYPTO
  // Sealed frame (Phase 9D): nonce = the rolling sequence number; the plain payload never leaves.
  uint32_t tag = 0;
  const uint32_t cipher = edgecrypto::seal(g_keys, r.payload, (uint32_t)g_seq, DEVICE_EUI, &tag);
  edge::hex32(cipher, hex);
  Serial.print("\"cipher_hex\":\"");
  Serial.print(hex);
  edge::hex32(tag, hex);
  Serial.print("\",\"tag_hex\":\"");
  Serial.print(hex);
  Serial.print("\",\"nonce\":");
  Serial.print((unsigned long)g_seq);
  Serial.print(",");
#else
  edge::hex32(r.payload, hex);
  Serial.print("\"payload_hex\":\"");
  Serial.print(hex);
  Serial.print("\",");
#endif
  print_kv("kalman_filtered_depth_mm", r.depth_mm, 1);
  print_kv("raw_unfiltered_depth_mm", r.raw_depth_mm, 1);
  print_kv("dh_dt_mm_min", r.dh_dt_mm_min, 2);
  print_kv("sigma_d2_mm2", r.sigma_d2, 2);
  print_kv("turbulence_index", r.turbulence, 4);
  print_kv("h_over_d", r.h_over_d, 4);
  print_kv("tank_height_mm", (real_t)TANK_HEIGHT_MM, 0);
  Serial.print("\"anomaly_class\":\"");
  Serial.print(edge::ANOMALY_NAMES[r.anomaly_code & 7]);
  Serial.print("\",\"seq\":");
  Serial.print(g_seq);
  Serial.println(",\"fw\":\"universal-hcsr04-1.0\"}");
  Serial.print("DIST_MM:");
  Serial.println(r.dist_mm, 0);
}

// ---------------------------------------------------------------- ESP32 Wi-Fi uplink task
#if defined(ESP32)
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
static edge::Result g_snap;
static unsigned long g_snap_seq = 0;
static volatile int g_http_code = 0;        // last POST: 200 ok, < 0 PC unreachable, 0 none yet
static volatile unsigned long g_post_ok = 0;
static volatile unsigned long g_post_fail = 0;

static int http_post(const char *path, const char *body, size_t len) {
  char url[96];
  snprintf(url, sizeof(url), "http://%s:%d%s", SERVER_IP, SERVER_PORT, path);
  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(url)) return -1;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST((uint8_t *)body, len);
  http.end();
  return code;
}

static void uplink_task(void *) {
  unsigned long sent = 0;
  unsigned long last_try = millis();
  bool clock_started = false;
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      if (millis() - last_try > WIFI_RETRY_MS) {
        last_try = millis();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      }
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }
    if (!clock_started) {
      clock_started = true;
      configTime(0, 0, "pool.ntp.org", "time.google.com");  // wall clock (UTC) for the SD log
    }
    edge::Result r;
    unsigned long seq;
    portENTER_CRITICAL(&g_mux);
    r = g_snap;
    seq = g_snap_seq;
    portEXIT_CRITICAL(&g_mux);
    if (seq != sent) {
      sent = seq;
      char hex[11];
      edge::hex32(r.payload, hex);
      char body[460];
      int n = snprintf(body, sizeof(body),
                       "{\"device_eui\":\"%s\",\"transport\":\"WIFI\",\"payload_hex\":\"%s\",\"dist_mm\":%.1f,\"tank_height_mm\":%.0f,"
                       "\"fill_pct\":%.1f,\"scope\":\"%s\",\"kalman_filtered_depth_mm\":%.1f,"
                       "\"raw_unfiltered_depth_mm\":%.1f,\"dh_dt_mm_min\":%.2f,\"sigma_d2_mm2\":%.2f,"
                       "\"turbulence_index\":%.4f,\"h_over_d\":%.4f,\"temperature_c\":%.1f,\"bench_demo\":true}",
                       DEVICE_EUI, hex, (double)r.dist_mm, (double)TANK_HEIGHT_MM, (double)r.cap_pct, UPLINK_SCOPE,
                       (double)r.depth_mm, (double)r.raw_depth_mm, (double)r.dh_dt_mm_min, (double)r.sigma_d2,
                       (double)r.turbulence, (double)r.h_over_d, (double)AIR_TEMP_C);
      if (n > 0 && n < (int)sizeof(body)) {
        const int code = http_post("/api/v1/ingest/distance", body, (size_t)n);
        g_http_code = code;
        if (code == 200) g_post_ok = g_post_ok + 1;
        else g_post_fail = g_post_fail + 1;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(POST_PERIOD_MS));
  }
}

/** Printed from loop() so it never interleaves with [EDGE_TX]. Keep "<number> mm/cm" out of these
 *  lines: the web serial parser reads that pattern as a distance. */
static void print_link_status() {
  char line[120];
  const int st = WiFi.status();
  if (st == WL_CONNECTED) {
    IPAddress ip = WiFi.localIP();
    const int code = g_http_code;
    snprintf(line, sizeof(line), "LINK_STATUS:WIFI_UP ip=%u.%u.%u.%u rssi=%d http=%d ok=%lu fail=%lu", ip[0], ip[1], ip[2], ip[3],
             (int)WiFi.RSSI(), code, (unsigned long)g_post_ok, (unsigned long)g_post_fail);
    Serial.println(line);
    if (code < 0) Serial.println("# PC unreachable: check SERVER_IP, that npm start is running, and that both are on one network");
    else if (code == 404) Serial.println("# backend rejected DEVICE_EUI: use EN-01 .. EN-10");
  } else {
    snprintf(line, sizeof(line), "LINK_STATUS:WIFI_DOWN wifi_status=%d ssid=%s", st, WIFI_SSID);
    Serial.println(line);
    if (st == WL_NO_SSID_AVAIL) Serial.println("# network not found: the ESP32-S3 joins 2.4 GHz only, check the SSID");
    else if (st == WL_CONNECT_FAILED) Serial.println("# join failed: check WIFI_PASSWORD");
  }
}
#endif

// ---------------------------------------------------------------- black box (Phase 9C)
#if defined(ESP32)
static blackbox::RamRing<256> g_ring;
static Preferences g_nvs;
static uint16_t g_since_mirror = 0;

/** Internal-flash mirror of the ring (words + head + count; millis are not kept across a reboot). */
static void flash_mirror() {
  g_nvs.putBytes("words", g_ring.words, sizeof g_ring.words);
  g_nvs.putUShort("head", g_ring.head);
  g_nvs.putUShort("n", g_ring.n);
}

static void flash_restore() {
  uint16_t n = g_nvs.getUShort("n", 0);
  if (n == 0 || n > 256) return;
  if (g_nvs.getBytes("words", g_ring.words, sizeof g_ring.words) != sizeof g_ring.words) return;
  g_ring.head = (uint16_t)(g_nvs.getUShort("head", 0) % 256);
  g_ring.n = n;
  for (uint16_t i = 0; i < 256; ++i) {
    g_ring.times[i] = 0;
    g_ring.seqs[i] = 0;
  }
}
#else
/** 255-frame ring in the Uno's 1 KB EEPROM: byte 0 magic, 1 head, 2 count, words from byte 4. */
struct EepromRing {
  static const uint16_t CAP = 255;
  uint32_t last_t = 0;
  uint32_t last_seq = 0;
  void begin() {
    if (EEPROM.read(0) != 0xB9) {
      EEPROM.update(0, 0xB9);
      EEPROM.update(1, 0);
      EEPROM.update(2, 0);
    }
  }
  void push(uint32_t w, uint32_t t_ms, uint32_t s) {
    uint8_t h = EEPROM.read(1);
    for (int b = 0; b < 4; ++b) EEPROM.update(4 + 4 * h + b, (uint8_t)(w >> (24 - 8 * b)));
    EEPROM.update(1, (uint8_t)((h + 1) % CAP));
    uint8_t n = EEPROM.read(2);
    if (n < CAP) EEPROM.update(2, (uint8_t)(n + 1));
    last_t = t_ms;
    last_seq = s;
  }
  uint16_t count() const { return EEPROM.read(2); }
  uint16_t slot(uint16_t i) const { return (uint16_t)((EEPROM.read(1) + CAP - count() + i) % CAP); }
  uint32_t word(uint16_t i) const {
    uint16_t k = slot(i);
    uint32_t w = 0;
    for (int b = 0; b < 4; ++b) w = (w << 8) | EEPROM.read(4 + 4 * k + b);
    return w;
  }
  // EEPROM keeps words only: times and sequence numbers are rebuilt from the 1 Hz logging cadence.
  uint32_t t_ms(uint16_t i) const {
    uint32_t back = (uint32_t)(count() - 1 - i) * (uint32_t)(SAMPLE_PERIOD_MS * REPORT_EVERY * BLACKBOX_EVERY);
    return last_t > back ? last_t - back : 0;
  }
  uint32_t seq(uint16_t i) const {
    uint32_t back = (uint32_t)(count() - 1 - i) * BLACKBOX_EVERY;
    return last_seq > back ? last_seq - back : 0;
  }
};
static EepromRing g_ring;
#endif

static bool g_sd_ok = false;
static int g_since_log = 0;

static const char *blackbox_tier() { return g_sd_ok ? "SPI_SD" : "FLASH_FAILSAFE"; }

static void print_sd_status() { Serial.println(g_sd_ok ? "SD_STATUS:OK_SPI_CARD" : "SD_STATUS:OK_FLASH_FAILSAFE"); }

#if BLACKBOX_SD
#if defined(ESP32)
#define BB_APPEND FILE_APPEND
#else
#define BB_APPEND FILE_WRITE
#endif
/** UTC seconds for the CSV; 0 until NTP has synced (without Wi-Fi: never, use t_ms). */
static uint32_t unix_now() {
#if defined(ESP32)
  const time_t t = time(nullptr);
  return t > 1700000000 ? (uint32_t)t : 0;
#else
  return 0;
#endif
}

/** Appends one frame to both SD files; false on any failure (card pulled, loose wire, full). */
static bool sd_append(uint32_t t_ms, uint32_t seq, const edge::Result &r) {
  const uint32_t word = r.payload;
  uint8_t rec[12];
  const uint32_t v[3] = {t_ms, seq, word};
  for (int j = 0; j < 3; ++j)
    for (int b = 0; b < 4; ++b) rec[4 * j + b] = (uint8_t)(v[j] >> (24 - 8 * b));
  File bin = SD.open("/telemetry_log.bin", BB_APPEND);
  if (!bin) return false;
  size_t wrote = bin.write(rec, sizeof rec);
  bin.close();
  if (wrote != sizeof rec) return false;
  File csv = SD.open("/telemetry_log.csv", BB_APPEND);
  if (!csv) return false;
  char hx[11];
  blackbox::hex32(word, hx);
  if (csv.size() == 0) csv.println("t_ms,unix_time,seq,dist_mm,fill_pct,depth_mm,dh_dt_mm_min,anomaly,payload_hex");
  csv.print((unsigned long)t_ms);
  csv.print(",");
  csv.print((unsigned long)unix_now());
  csv.print(",");
  csv.print((unsigned long)seq);
  csv.print(",");
  csv.print(r.dist_mm, 1);
  csv.print(",");
  csv.print(r.cap_pct, 1);
  csv.print(",");
  csv.print(r.depth_mm, 1);
  csv.print(",");
  csv.print(r.dh_dt_mm_min, 2);
  csv.print(",");
  csv.print(edge::ANOMALY_NAMES[r.anomaly_code & 7]);
  csv.print(",");
  csv.println(hx);
  csv.close();
  return true;
}

#if defined(ESP32)
static unsigned long g_last_sd_try = 0;

/** A power sag or loose jumper must not end logging for the rest of the run. */
static void sd_retry(unsigned long now) {
  if (g_sd_ok || now - g_last_sd_try < SD_RETRY_MS) return;
  g_last_sd_try = now;
  SD.end();
  g_sd_ok = SD.begin(SD_CS_PIN);
  if (g_sd_ok) print_sd_status();
}
#endif
#endif

static void blackbox_log(unsigned long now) {
  if (++g_since_log < BLACKBOX_EVERY) return;
  g_since_log = 0;
  g_ring.push(g_last.payload, (uint32_t)now, (uint32_t)g_seq);  // the ring mirrors every tier
#if defined(ESP32)
  if (++g_since_mirror >= 64) {
    g_since_mirror = 0;
    flash_mirror();
  }
#endif
#if BLACKBOX_SD
  if (g_sd_ok && !sd_append((uint32_t)now, (uint32_t)g_seq, g_last)) {
    g_sd_ok = false;  // fail over to the internal ring at once, never halt
    print_sd_status();
  }
#if defined(ESP32)
  sd_retry(now);
#endif
#endif
}

static void blackbox_begin() {
#if defined(ESP32)
  g_nvs.begin("blackbox", false);
  flash_restore();
#else
  g_ring.begin();
#endif
#if BLACKBOX_SD
#if defined(ESP32)
  SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);  // the default pins differ per board variant
#endif
  g_sd_ok = SD.begin(SD_CS_PIN);
#endif
  print_sd_status();
}

// Console commands (one per line): DUMP_SD_LOG, SD_STATUS.
static char g_cmd[24];
static uint8_t g_cmd_n = 0;

static void handle_command(const char *c) {
  if (strcmp(c, "DUMP_SD_LOG") == 0) blackbox::dump(Serial, g_ring, blackbox_tier());
  else if (strcmp(c, "SD_STATUS") == 0) print_sd_status();
}

static void poll_commands() {
  while (Serial.available() > 0) {
    int c = Serial.read();
    if (c < 0) break;
    if (c == '\n' || c == '\r') {
      g_cmd[g_cmd_n] = '\0';
      if (g_cmd_n) handle_command(g_cmd);
      g_cmd_n = 0;
    } else if (g_cmd_n < sizeof g_cmd - 1) {
      g_cmd[g_cmd_n++] = (char)c;
    }
  }
}

// ---------------------------------------------------------------- Arduino entry points
void setup() {
  Serial.begin(115200);
#if defined(ESP32) && ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);  // on battery no USB host is listening: printing must never stall sampling
#endif
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  edge::kalman_reset(&g_kal);
  g_win.n = 0;
  Serial.println("# City Camp twin universal HC-SR04 node, [EDGE_TX] + DIST_MM @ 115200");
  blackbox_begin();
#if EDGE_CRYPTO
  g_keys.init();
#endif
#if defined(ESP32)
  if (WIFI_SSID[0] != '\0') {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    WiFi.setTxPower(WIFI_TX_POWER);
    xTaskCreatePinnedToCore(uplink_task, "uplink", 8192, nullptr, 1, nullptr, 0);
    Serial.println("# Wi-Fi uplink enabled -> http://" SERVER_IP ":8000/api/v1/ingest/distance");
  }
#endif
}

void loop() {
  unsigned long now = millis();
  poll_commands();
  update_leds(now);
#if defined(ESP32)
  static unsigned long last_link = 0;
  if (WIFI_SSID[0] != '\0' && now - last_link >= LINK_STATUS_MS) {
    last_link = now;
    print_link_status();
  }
#endif
  if (now - g_last_sample < SAMPLE_PERIOD_MS) return;
  g_last_sample = now;

  real_t d = read_hcsr04_mm();
  if (d < 0) {
    ++g_missed_echoes;
    if (g_win.n == 0) {  // no echo yet: nothing to repeat
      if (g_missed_echoes % 20 == 1) Serial.println("SENSOR_FAULT:NO_ECHO check TRIG, ECHO and HC-SR04 power");
      return;
    }
    d = g_win.s[g_win.n - 1];  // missed echo: repeat the last good sample
  } else {
    g_missed_echoes = 0;
  }
  d = edge::clampr(d, edge::MIN_DIST_MM, (real_t)TANK_HEIGHT_MM);
  edge::window_push(&g_win, d);
  real_t burst[edge::BURST_LEN];
  edge::window_burst(&g_win, burst);
  real_t dt_min = g_last_cycle == 0 ? (real_t)(1.0 / 60.0) : (real_t)(now - g_last_cycle) / (real_t)60000.0;
  g_last_cycle = now;
  g_last = edge::cycle(&g_kal, burst, (real_t)AIR_TEMP_C, dt_min, (real_t)TANK_HEIGHT_MM, (real_t)NODE_FULL_SCALE_M, (real_t)VBAT_V);
  if (g_missed_echoes >= ECHO_FAULT_MISSES) edge::mark_sensor_fault(&g_last, (real_t)VBAT_V);
  g_have = true;

  if (++g_since_report < REPORT_EVERY) return;
  g_since_report = 0;
  ++g_seq;
  print_edge_tx(g_last);
  blackbox_log(now);
#if defined(ESP32)
  portENTER_CRITICAL(&g_mux);
  g_snap = g_last;
  g_snap_seq = g_seq;
  portEXIT_CRITICAL(&g_mux);
#endif
}
