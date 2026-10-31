// =============================================================================
// ESP32-S3 -> Vercel baseline link test.
// Answers one question: can this board reach our Vercel deployment? It reads the HC-SR04, applies
// the alarm threshold, and POSTs JSON over HTTPS to api/esp32.js. The Edge-AI pipeline, the SD card
// and the 3D map are not involved: that is universal_hcsr04_node.
//
// Setup: copy node_config.example.h to node_config.h in this folder and set VERCEL_URL.
// Sends: every POST_PERIOD_MS, and at once when the level changes (so an alarm is not held back).
// No echo: it still posts, with level NO_ECHO, so a sensor fault cannot hide a working link.
// USB:   115200 baud. Success looks like: POST seq=3 -> HTTP 200 in 612 ms
//
// Wiring (HW-131: ESP32-S3 and HC-SR04 on the 3.3 V rail, common GND):
//   HC-SR04 TRIG -> GPIO5, ECHO -> GPIO18
// =============================================================================
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#if __has_include("node_config.h")
#include "node_config.h"
#endif

#ifndef VERCEL_URL
#error "Copy node_config.example.h to node_config.h and set VERCEL_URL"
#endif
#ifndef DEVICE_ID
#define DEVICE_ID "EN-08"
#endif
#ifndef TANK_HEIGHT_MM
#define TANK_HEIGHT_MM 300.0f     // HC-SR04 face -> tank floor
#endif
#ifndef WARNING_PCT
#define WARNING_PCT 45.0f
#endif
#ifndef ALARM_PCT
#define ALARM_PCT 80.0f
#endif

#define TRIG_PIN 5
#define ECHO_PIN 18
#define FULL_BORE_FRACTION 0.74f  // 100 % full = 74 % of the tank height, as in universal_hcsr04_node
#define ECHO_SAMPLES 5
#define MM_PER_US 0.1716f         // 343.2 m/s, halved for the round trip
#define READ_PERIOD_MS 1000UL
#define POST_PERIOD_MS 10000UL
#define WIFI_RETRY_MS 15000UL     // association can take several seconds: do not restart it sooner
#define HTTP_TIMEOUT_MS 10000     // a cold Vercel function plus the TLS handshake can take seconds
#define TLS_HANDSHAKE_TIMEOUT_S 15

static unsigned long g_last_read = 0;
static unsigned long g_last_post = 0;
static unsigned long g_last_join = 0;
static unsigned long g_seq = 0;
static char g_sent_level[10] = "";

/** Median of ECHO_SAMPLES pings in mm, or -1 when none came back. */
static float read_distance_mm() {
  float s[ECHO_SAMPLES];
  int n = 0;
  for (int i = 0; i < ECHO_SAMPLES; ++i) {
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);
    const unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000UL);
    if (us > 0) {
      float x = (float)us * MM_PER_US;
      int j = n - 1;
      while (j >= 0 && s[j] > x) {
        s[j + 1] = s[j];
        --j;
      }
      s[j + 1] = x;
      ++n;
    }
    delay(60);  // let the last echo die away
  }
  return n > 0 ? s[n / 2] : -1.0f;
}

static float fill_pct_of(float dist_mm) {
  const float water = constrain((float)TANK_HEIGHT_MM - dist_mm, 0.0f, (float)TANK_HEIGHT_MM);
  return water / ((float)TANK_HEIGHT_MM * FULL_BORE_FRACTION) * 100.0f;
}

/** The threshold: this is what decides ALARM. */
static const char *level_of(float dist_mm, float fill_pct) {
  if (dist_mm < 0) return "NO_ECHO";
  if (fill_pct >= ALARM_PCT) return "ALARM";
  return fill_pct >= WARNING_PCT ? "WARNING" : "NORMAL";
}

static void print_hint(int code) {
  if (code < 0) Serial.println("# no HTTPS connection: check VERCEL_URL starts with https:// and that this Wi-Fi has internet");
  else if (code == 401 || code == 403) Serial.println("# blocked by Vercel Deployment Protection: use the production URL, not a preview URL");
  else if (code == 404) Serial.println("# not found: api/esp32.js is not deployed at VERCEL_URL");
  else if (code >= 300 && code < 400) Serial.println("# redirected: use https:// and no trailing slash in VERCEL_URL");
}

static void post_reading(const char *body, size_t len) {
  WiFiClientSecure client;
  client.setInsecure();  // baseline only: encrypted, but the server's identity is not checked
  client.setHandshakeTimeout(TLS_HANDSHAKE_TIMEOUT_S);
  HTTPClient https;
  https.setConnectTimeout(HTTP_TIMEOUT_MS);
  https.setTimeout(HTTP_TIMEOUT_MS);
  if (!https.begin(client, VERCEL_URL)) {
    Serial.println("POST not sent: VERCEL_URL did not parse");
    return;
  }
  https.addHeader("Content-Type", "application/json");
  const unsigned long t0 = millis();
  const int code = https.POST((uint8_t *)body, len);
  Serial.printf("POST seq=%lu -> HTTP %d in %lu ms\n", g_seq, code, millis() - t0);
  if (code > 0) Serial.printf("RESP %s\n", https.getString().c_str());
  https.end();
  print_hint(code);
}

void setup() {
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);  // on battery no USB host is listening: printing must never stall the loop
#endif
  delay(1500);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  WiFi.setTxPower(WIFI_POWER_8_5dBm);  // lower TX current peaks on a 9 V cell
  g_last_join = millis();
  Serial.printf("# Vercel baseline test -> %s\n", VERCEL_URL);
}

void loop() {
  const unsigned long now = millis();
  if (now - g_last_read < READ_PERIOD_MS) return;
  g_last_read = now;

  const float dist = read_distance_mm();
  const float fill = dist < 0 ? 0.0f : fill_pct_of(dist);
  const char *level = level_of(dist, fill);
  Serial.printf("READ dist_mm=%.1f fill_pct=%.1f level=%s\n", dist, fill, level);

  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("WIFI down status=%d ssid=%s (the ESP32-S3 joins 2.4 GHz only)\n", (int)WiFi.status(), WIFI_SSID);
    if (now - g_last_join >= WIFI_RETRY_MS) {
      g_last_join = now;
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
    return;
  }

  const bool changed = strcmp(level, g_sent_level) != 0;
  if (!changed && now - g_last_post < POST_PERIOD_MS) return;
  g_last_post = now;
  strncpy(g_sent_level, level, sizeof(g_sent_level) - 1);
  ++g_seq;

  char values[48];
  if (dist < 0) snprintf(values, sizeof(values), "\"dist_mm\":null,\"fill_pct\":null");
  else snprintf(values, sizeof(values), "\"dist_mm\":%.1f,\"fill_pct\":%.1f", dist, fill);
  char body[200];
  const int n = snprintf(body, sizeof(body), "{\"device\":\"%s\",\"level\":\"%s\",%s,\"seq\":%lu,\"rssi\":%d,\"uptime_s\":%lu}", DEVICE_ID, level,
                         values, g_seq, (int)WiFi.RSSI(), now / 1000UL);
  if (n > 0 && n < (int)sizeof(body)) post_reading(body, (size_t)n);
}
