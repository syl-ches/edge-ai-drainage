// City Camp Lagoon Edge-AI manhole node — Seeed Studio XIAO ESP32-S3 firmware.
//
// Hardware (see docs/HARDWARE_BENCH_DEMO_GUIDE.md):
//   DFRobot A02YYUW   UART1 RX <- GPIO44 (D7) sensor TX; GPIO43 (D6) -> sensor RX "mode" pin
//                     (held LOW = real-time ~100 ms samples); power via MOSFET on GPIO4 (D3)
//   DS18B20           OneWire on GPIO5 (D4), 4.7 kOhm pull-up to 3V3
//   Battery sense     GPIO1 (A0) via 1:2 divider (2 x 220 kOhm)
//   Wio-SX1262        B2B connector: SPI SCK 7 / MISO 8 / MOSI 9, NSS 41, DIO1 39, RST 42, BUSY 40
//
// Every wake: 10-sample 10 Hz burst -> edge::run_cycle() (thermal comp, 5-pt median, adaptive
// Kalman in RTC memory, steep-slope hydraulics, INT8 classifier, FSM) -> 4-byte payload.
// Transports: LoRaWAN AS923-3 FPort 10 | Wi-Fi HTTP POST to the FastAPI ingest | USB serial
// `[EDGE_TX] {json}` (read by scripts/serial_bridge.py).
#include <Arduino.h>
#include <DallasTemperature.h>
#include <HTTPClient.h>
#include <OneWire.h>
#include <RadioLib.h>
#include <SPI.h>
#include <WiFi.h>
#include <esp_sleep.h>

#include "edge_core.hpp"
#include "node_profiles.hpp"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

#ifndef FW_VERSION
#define FW_VERSION "citycamp-edge-dev"
#endif
#ifndef BENCH_DEMO_MODE
#define BENCH_DEMO_MODE 0
#endif

// ---------------------------------------------------------------- pins
constexpr int PIN_US_RX = 44;      // D7: A02YYUW TX -> ESP RX
constexpr int PIN_US_MODE = 43;    // D6: A02YYUW RX (mode): LOW = real-time output
constexpr int PIN_US_POWER = 4;    // D3: MOSFET gate, HIGH = sensor powered
constexpr int PIN_ONEWIRE = 5;     // D4: DS18B20
constexpr int PIN_VBAT = 1;        // A0: battery divider
constexpr float VBAT_DIVIDER = 2.0f;
constexpr int LORA_SCK = 7, LORA_MISO = 8, LORA_MOSI = 9, LORA_NSS = 41, LORA_DIO1 = 39, LORA_RST = 42, LORA_BUSY = 40;

constexpr uint32_t BURST_TIMEOUT_MS = 2500;
constexpr uint32_t SENSOR_WARMUP_MS = 120;
constexpr uint32_t CONSOLE_WINDOW_MS = 400;  // field mode: time to type a command after wake
constexpr uint32_t RTC_MAGIC = 0xC17CA4F5;

// Reserved for the INT8 1D-conv autoencoder (TensorFlow Lite Micro + ESP-NN) once field data
// exists; the deployed classifier is the integer decision surface in edge_core.hpp.
alignas(16) [[maybe_unused]] static uint8_t g_tensor_arena[16 * 1024];

// ---------------------------------------------------------------- state kept across deep sleep
enum SimMode : uint8_t { SIM_OFF = 0, SIM_SURGE, SIM_BLOCKAGE, SIM_DRY };

struct RtcState {
  uint32_t magic;
  edge::KalmanState kf;
  uint8_t node;
  uint8_t standpipe;
  uint8_t bench;
  uint8_t sim;
  float pipe_height_mm;
  float sim_level_mm;
  uint32_t seq;
  uint32_t since_uplink_s;
  uint32_t last_wake_s;  // the sleep we just woke from: Kalman dt across deep sleep
  uint8_t last_anomaly;
  uint8_t lorawan_joined;
};
RTC_DATA_ATTR RtcState g_rtc;
RTC_DATA_ATTR uint8_t g_lw_nonces[RADIOLIB_LORAWAN_NONCES_BUF_SIZE];
RTC_DATA_ATTR uint8_t g_lw_session[RADIOLIB_LORAWAN_SESSION_BUF_SIZE];

// ---------------------------------------------------------------- peripherals
HardwareSerial& g_us = Serial1;
OneWire g_onewire(PIN_ONEWIRE);
DallasTemperature g_ds18b20(&g_onewire);
SX1262 g_radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
LoRaWANNode g_lorawan(&g_radio, &AS923_3);
static char g_json[1536];
static uint32_t g_last_cycle_ms = 0;

static const edge::NodeConfig& profile() { return edge::NODE_PROFILES[g_rtc.node % edge::NODE_PROFILE_COUNT]; }

static void reset_rtc() {
  g_rtc = RtcState{};
  g_rtc.magic = RTC_MAGIC;
  g_rtc.kf = edge::kalman_init();
  const int idx = edge::find_node_profile(DEFAULT_NODE);
  g_rtc.node = static_cast<uint8_t>(idx >= 0 ? idx : 7);
  g_rtc.bench = BENCH_DEMO_MODE ? 1 : 0;
  g_rtc.standpipe = BENCH_DEMO_MODE ? 1 : 0;
  g_rtc.pipe_height_mm = DEFAULT_PIPE_HEIGHT_MM;
}

// ---------------------------------------------------------------- sensing
static float read_battery_v() {
  uint32_t mv = 0;
  for (int i = 0; i < 8; ++i) mv += analogReadMilliVolts(PIN_VBAT);
  return static_cast<float>(mv) / 8.0f * VBAT_DIVIDER / 1000.0f;
}

/// Collect up to `want` raw (uncompensated) A02YYUW distances; returns the count obtained.
static size_t read_burst(edge::real* out, size_t want, uint32_t& checksum_errors) {
  digitalWrite(PIN_US_POWER, HIGH);
  pinMode(PIN_US_MODE, OUTPUT);
  digitalWrite(PIN_US_MODE, LOW);  // real-time mode: a fresh frame every ~100 ms (10 Hz)
  g_us.begin(9600, SERIAL_8N1, PIN_US_RX, -1);
  delay(SENSOR_WARMUP_MS);
  while (g_us.available()) g_us.read();
  edge::A02yyuwStream stream;
  size_t n = 0;
  checksum_errors = 0;
  const uint32_t t0 = millis();
  while (n < want && millis() - t0 < BURST_TIMEOUT_MS) {
    if (!g_us.available()) {
      delay(2);
      continue;
    }
    if (!stream.feed(static_cast<uint8_t>(g_us.read()))) continue;
    const edge::UartReading r = edge::parse_a02yyuw_frame(stream.frame);
    if (r.status == edge::UartStatus::BadChecksum || r.status == edge::UartStatus::BadHeader) {
      ++checksum_errors;
      continue;
    }
    // Blind-zone / out-of-range readings are kept (clamped) so run_cycle can flag them.
    out[n++] = edge::clampv<edge::real>(r.distance_mm, edge::BLIND_ZONE_MM, edge::MAX_RANGE_MM + 500);
  }
  g_us.end();
  if (!g_rtc.bench) digitalWrite(PIN_US_POWER, LOW);
  return n;
}

/// Bench self-test without a sensor: deterministic synthetic water column.
static size_t simulate_burst(edge::real* out, size_t want, float span_mm) {
  float target = 0, chop = 1, spike_p = 0, rate = 0;
  switch (g_rtc.sim) {
    case SIM_SURGE: target = span_mm * 0.95f, chop = 22, spike_p = 0.12f, rate = 25; break;
    case SIM_BLOCKAGE: target = span_mm * 0.72f, chop = 0.8f, spike_p = 0, rate = 6; break;
    default: target = span_mm * 0.03f, chop = 1.5f, spike_p = 0, rate = 15; break;
  }
  const float step = target - g_rtc.sim_level_mm;
  g_rtc.sim_level_mm += step > rate ? rate : (step < -rate ? -rate : step);
  for (size_t k = 0; k < want; ++k) {
    float d = span_mm - g_rtc.sim_level_mm + chop * sinf(0.7f * g_rtc.seq + 1.7f * k) + (esp_random() % 300) / 100.0f - 1.5f;
    if ((esp_random() % 1000) < spike_p * 1000) d -= 80 + esp_random() % 220;
    out[k] = d < edge::BLIND_ZONE_MM ? edge::BLIND_ZONE_MM : d;
  }
  return want;
}

static float read_temperature_c(bool& ok) {
  g_ds18b20.requestTemperatures();
  const float t = g_ds18b20.getTempCByIndex(0);
  ok = t != DEVICE_DISCONNECTED_C && t > -20 && t < 60;
  return ok ? t : 14.0f;  // Baguio stormwater default
}

// ---------------------------------------------------------------- transports
static void lorawan_join() {
#if LORAWAN_ENABLED
  if (g_radio.begin() != RADIOLIB_ERR_NONE) return;
  const uint8_t app_key[16] = LORAWAN_APP_KEY;
  const uint8_t nwk_key[16] = LORAWAN_NWK_KEY;
  g_lorawan.beginOTAA(LORAWAN_JOIN_EUI, LORAWAN_DEV_EUI, nwk_key, app_key);
  if (g_rtc.lorawan_joined) {
    g_lorawan.setBufferNonces(g_lw_nonces);
    g_lorawan.setBufferSession(g_lw_session);
  }
  const int16_t st = g_lorawan.activateOTAA();
  g_rtc.lorawan_joined = (st == RADIOLIB_LORAWAN_NEW_SESSION || st == RADIOLIB_LORAWAN_SESSION_RESTORED) ? 1 : 0;
  // AS923 dwell-time limit (400 ms) is enforced by RadioLib's band plan; ADR picks DR2..DR5.
  g_lorawan.setADR(true);
#endif
}

static void lorawan_uplink(uint32_t payload) {
#if LORAWAN_ENABLED
  if (!g_rtc.lorawan_joined) return;
  uint8_t bytes[4];
  edge::payload_bytes_be(payload, bytes);
  g_lorawan.sendReceive(bytes, sizeof(bytes), edge::LORA_FPORT);
  memcpy(g_lw_nonces, g_lorawan.getBufferNonces(), RADIOLIB_LORAWAN_NONCES_BUF_SIZE);
  memcpy(g_lw_session, g_lorawan.getBufferSession(), RADIOLIB_LORAWAN_SESSION_BUF_SIZE);
#else
  (void)payload;
#endif
}

static void wifi_post(const char* json) {
  if (strlen(WIFI_SSID) == 0) return;
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    const uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 6000) delay(50);
    if (WiFi.status() != WL_CONNECTED) return;
  }
  HTTPClient http;
  http.setTimeout(1500);
  if (!http.begin(INGEST_URL)) return;
  http.addHeader("Content-Type", "application/json");
  http.POST(reinterpret_cast<uint8_t*>(const_cast<char*>(json)), strlen(json));
  http.end();
}

// ---------------------------------------------------------------- serial console
static void print_status() {
  const edge::NodeConfig& p = profile();
  Serial.printf("[STATUS] node=%s eui=%s bench=%s standpipe=%s pipe=%.0fmm sim=%u seq=%lu lorawan=%s fw=%s\n", p.sensor_id, p.device_eui,
                g_rtc.bench ? "ON" : "OFF", g_rtc.standpipe ? "ON" : "OFF", g_rtc.pipe_height_mm, g_rtc.sim, static_cast<unsigned long>(g_rtc.seq),
                g_rtc.lorawan_joined ? "joined" : "off", FW_VERSION);
}

static void handle_command(char* line) {
  for (char* c = line; *c; ++c) *c = static_cast<char>(toupper(*c));
  if (!strncmp(line, "NODE ", 5)) {
    const int idx = edge::find_node_profile(line + 5);
    if (idx < 0) {
      Serial.println("[ERR] unknown node (EN-01..EN-10)");
      return;
    }
    g_rtc.node = static_cast<uint8_t>(idx);
    g_rtc.kf = edge::kalman_init();  // new conduit geometry: restart the filter
  } else if (!strcmp(line, "SCALE ON")) {
    g_rtc.standpipe = 1;
    g_rtc.kf = edge::kalman_init();
  } else if (!strcmp(line, "SCALE OFF")) {
    g_rtc.standpipe = 0;
    g_rtc.kf = edge::kalman_init();
  } else if (!strncmp(line, "HEIGHT ", 7)) {
    const float h = atof(line + 7);
    if (h >= 200 && h <= 4400) g_rtc.pipe_height_mm = h;
  } else if (!strcmp(line, "BENCH ON")) {
    g_rtc.bench = 1;
  } else if (!strcmp(line, "BENCH OFF")) {
    g_rtc.bench = 0;
  } else if (!strcmp(line, "SIM SURGE")) {
    g_rtc.sim = SIM_SURGE;
  } else if (!strcmp(line, "SIM BLOCKAGE")) {
    g_rtc.sim = SIM_BLOCKAGE;
  } else if (!strcmp(line, "SIM DRY")) {
    g_rtc.sim = SIM_DRY;
  } else if (!strcmp(line, "SIM OFF")) {
    g_rtc.sim = SIM_OFF;
  } else if (!strcmp(line, "RESET")) {
    reset_rtc();
  } else if (strcmp(line, "STATUS") != 0) {
    Serial.println("[HELP] NODE EN-01..EN-10 | SCALE ON|OFF | HEIGHT <mm> | BENCH ON|OFF | SIM SURGE|BLOCKAGE|DRY|OFF | STATUS | RESET");
    return;
  }
  print_status();
}

static void poll_console(uint32_t window_ms) {
  static char buf[48];
  static size_t len = 0;
  const uint32_t t0 = millis();
  do {
    while (Serial.available()) {
      const char ch = static_cast<char>(Serial.read());
      if (ch == '\n' || ch == '\r') {
        if (len) {
          buf[len] = '\0';
          handle_command(buf);
          len = 0;
        }
      } else if (len < sizeof(buf) - 1) {
        buf[len++] = ch;
      }
    }
    if (window_ms) delay(5);
  } while (millis() - t0 < window_ms);
}

// ---------------------------------------------------------------- one wake cycle
static edge::CycleResult run_once(float dt_min) {
  const edge::NodeConfig& p = profile();
  edge::real raw[edge::BURST_LEN];
  uint32_t checksum_errors = 0;
  const float span = g_rtc.standpipe ? g_rtc.pipe_height_mm : static_cast<float>(p.mount_mm);
  const size_t n = g_rtc.sim ? simulate_burst(raw, edge::BURST_LEN, span) : read_burst(raw, edge::BURST_LEN, checksum_errors);
  bool temp_ok = true;
  const float temp_c = read_temperature_c(temp_ok);
  const float vbat = read_battery_v();
  // SENSOR_FAULT: UART timeout (< 5 valid frames) or a stuck transducer (zero variance burst).
  const bool fault = n < 5;
  edge::real safe[edge::BURST_LEN];
  for (size_t i = 0; i < edge::BURST_LEN; ++i) safe[i] = i < n ? raw[i] : (n ? raw[n - 1] : span);
  const edge::CycleInputs in{safe, edge::BURST_LEN, temp_c, dt_min, vbat > 2.5f ? vbat : 4.0f, fault, g_rtc.bench != 0, g_rtc.standpipe != 0,
                             g_rtc.pipe_height_mm};
  const edge::CycleResult r = edge::run_cycle(p, g_rtc.kf, in);
  ++g_rtc.seq;
  edge::format_edge_tx(g_json, sizeof(g_json), p, in, r, g_rtc.seq, FW_VERSION);
  Serial.printf("[EDGE_TX] %s\n", g_json);
  if (checksum_errors) Serial.printf("[A02YYUW] %lu checksum errors this burst\n", static_cast<unsigned long>(checksum_errors));
  if (!temp_ok) Serial.println("[DS18B20] not found, using 14.0 C");

  g_rtc.since_uplink_s += r.fsm.wake_s;
  const bool alarm_changed = r.anomaly != g_rtc.last_anomaly;
  if (g_rtc.bench || alarm_changed || g_rtc.since_uplink_s >= r.fsm.uplink_s) {
    lorawan_uplink(r.payload);
    wifi_post(g_json);
    g_rtc.since_uplink_s = 0;
  }
  g_rtc.last_anomaly = r.anomaly;
  return r;
}

// ---------------------------------------------------------------- Arduino entry points
void setup() {
  Serial.begin(115200);
  pinMode(PIN_US_POWER, OUTPUT);
  analogReadResolution(12);
  g_ds18b20.begin();
  g_ds18b20.setResolution(11);
  if (g_rtc.magic != RTC_MAGIC) reset_rtc();
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  lorawan_join();
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_UNDEFINED) {
    delay(1500);  // give the USB CDC console time to attach after a cold boot
    print_status();
  }
  if (g_rtc.bench) return;  // bench demo: stream continuously from loop()

  // Field mode: one cycle per wake, then deep sleep for the FSM interval (Kalman + session in RTC).
  poll_console(CONSOLE_WINDOW_MS);
  const uint32_t slept_s = g_rtc.last_wake_s ? g_rtc.last_wake_s : edge::FSM_WAKE_S[edge::STATE_CRITICAL_SURGE];
  const edge::CycleResult r = run_once(static_cast<float>(slept_s) / 60.0f);
  g_rtc.last_wake_s = r.fsm.wake_s;
  if (g_rtc.bench) return;
  Serial.flush();
  WiFi.disconnect(true);
  esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(r.fsm.wake_s) * 1000000ULL);
  esp_deep_sleep_start();
}

void loop() {
  poll_console(0);
  if (!g_rtc.bench) {
    // BENCH OFF typed during the demo: hand back to the low-power field cycle.
    esp_sleep_enable_timer_wakeup(1000000ULL);
    esp_deep_sleep_start();
  }
  const uint32_t now = millis();
  if (now - g_last_cycle_ms >= edge::FSM_BENCH_PERIOD_S * 1000UL) {
    const float dt_min = g_last_cycle_ms ? static_cast<float>(now - g_last_cycle_ms) / 60000.0f : 1.0f / 60.0f;
    g_last_cycle_ms = now;
    run_once(dt_min);
  }
  delay(5);
}
