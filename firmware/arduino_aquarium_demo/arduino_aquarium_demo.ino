// =============================================================================
// City Camp Lagoon Edge-AI twin: universal Arduino / ESP32 aquarium demo sketch (Phase 7B)
// =============================================================================
// Works on Arduino Uno / Nano / Mega and ESP32 / ESP32-S3 (incl. Seeed XIAO ESP32-S3) with
// either ultrasonic sensor:
//   * HC-SR04 / JSN-SR04T (4-pin TRIG / ECHO)               -> SENSOR_TYPE SENSOR_HCSR04
//   * DFRobot A02YYUW (UART 9600, 0xFF H L SUM frames)       -> SENSOR_TYPE SENSOR_A02YYUW
// Mount the sensor face-down above an aquarium / bucket. It prints, at 115200 baud and 5 Hz:
//   DIST_MM:<air gap mm>      raw distance (median of 5 pings, temperature compensated)
//   FILL_PCT:<0..120>         fill on the bench-standpipe scale (100 % = 74 % of TANK_HEIGHT_MM)
//   TEMP_C:<deg C>            every 5 s (DS18B20 when USE_DS18B20 1, else AIR_TEMP_C)
// Open the twin's "Arduino & Aquarium Sim" page in Chrome / Edge and click "Connect Physical USB
// Arduino / ESP32" (Web Serial), or run scripts/serial_bridge.py. The browser runs the same
// Kalman filter + INT8 classifier + 32-bit packer as the production firmware on these lines.
// LED_BUILTIN blinks at 3 Hz while the tank is >= 80 % full (the map's red-blink threshold).
// =============================================================================
#include <Arduino.h>

#define SENSOR_HCSR04 1
#define SENSOR_A02YYUW 2
#ifndef SENSOR_TYPE
#define SENSOR_TYPE SENSOR_HCSR04
#endif

#ifndef TANK_HEIGHT_MM
#define TANK_HEIGHT_MM 400.0f      // sensor face -> tank floor (measure your rig)
#endif
#ifndef USE_DS18B20
#define USE_DS18B20 0              // 1: needs the OneWire + DallasTemperature libraries
#endif
#define AIR_TEMP_C 24.0f
#define FULL_BORE_FRACTION 0.74f   // bench standpipe scale (CLAUDE.md §14)
#define ALARM_FILL_PCT 80.0f
#define SAMPLE_PERIOD_MS 200UL
#define TEMP_PERIOD_MS 5000UL
#define BLIND_ZONE_MM 30.0f
#define MAX_RANGE_MM 4500.0f

#ifndef LED_BUILTIN
#define LED_BUILTIN 13
#endif

#if defined(ARDUINO_ARCH_ESP32)
#define TRIG_PIN 2
#define ECHO_PIN 3
#define A02_RX_PIN 44              // XIAO ESP32-S3 D7 (matches the production edge node)
#define A02_TX_PIN 43
#else
#define TRIG_PIN 9
#define ECHO_PIN 10
#define A02_RX_PIN 10
#define A02_TX_PIN 11
#endif

#if SENSOR_TYPE == SENSOR_A02YYUW && !defined(ARDUINO_ARCH_ESP32)
#include <SoftwareSerial.h>
SoftwareSerial a02(A02_RX_PIN, A02_TX_PIN);
#define A02_PORT a02
#elif SENSOR_TYPE == SENSOR_A02YYUW
#define A02_PORT Serial1
#endif

#if USE_DS18B20
#include <OneWire.h>
#include <DallasTemperature.h>
#define DS18B20_PIN 5
OneWire oneWire(DS18B20_PIN);
DallasTemperature ds18b20(&oneWire);
#endif

static float g_temp_c = AIR_TEMP_C;
static unsigned long g_last_sample = 0;
static unsigned long g_last_temp = 0;
static float g_fill_pct = 0.0f;

static float speed_of_sound_mm_per_us(float t_c) { return (331.3f + 0.606f * t_c) / 1000.0f; }

static float median5(float *v) {
  for (int i = 1; i < 5; ++i) {                // insertion sort, 5 elements
    float x = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > x) {
      v[j + 1] = v[j];
      --j;
    }
    v[j + 1] = x;
  }
  return v[2];
}

#if SENSOR_TYPE == SENSOR_HCSR04
static float ping_mm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long echo_us = pulseIn(ECHO_PIN, HIGH, 30000UL);   // ~5 m round trip timeout
  if (echo_us == 0) return -1.0f;
  return (float)echo_us * speed_of_sound_mm_per_us(g_temp_c) / 2.0f;
}
#else
// A02YYUW: 0xFF, DATA_H, DATA_L, SUM = (0xFF + H + L) & 0xFF. The module reports at ~10 Hz and
// assumes 343.2 m/s, so rescale to the measured air temperature.
static float ping_mm() {
  unsigned long t0 = millis();
  while (millis() - t0 < 150UL) {
    if (A02_PORT.available() < 4) continue;
    if (A02_PORT.read() != 0xFF) continue;
    int h = A02_PORT.read();
    int l = A02_PORT.read();
    int sum = A02_PORT.read();
    if (((0xFF + h + l) & 0xFF) != sum) continue;
    float d = (float)((h << 8) | l);
    return d * speed_of_sound_mm_per_us(g_temp_c) * 1000.0f / 343.2f;
  }
  return -1.0f;
}
#endif

static float read_distance_mm() {
  float v[5];
  int n = 0;
  for (int k = 0; k < 8 && n < 5; ++k) {
    float d = ping_mm();
    if (d > 0.0f && d < MAX_RANGE_MM) v[n++] = d;
#if SENSOR_TYPE == SENSOR_HCSR04
    delay(12);                                   // let echoes die down between pings
#endif
  }
  if (n == 0) return -1.0f;
  while (n < 5) {                                // pad a short burst with its last good sample
    v[n] = v[n - 1];
    ++n;
  }
  return median5(v);
}

static void read_temperature() {
#if USE_DS18B20
  ds18b20.requestTemperatures();
  float t = ds18b20.getTempCByIndex(0);
  if (t > -55.0f && t < 125.0f) g_temp_c = t;
#endif
  Serial.print(F("TEMP_C:"));
  Serial.println(g_temp_c, 1);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
#if SENSOR_TYPE == SENSOR_HCSR04
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
#elif defined(ARDUINO_ARCH_ESP32)
  Serial1.begin(9600, SERIAL_8N1, A02_RX_PIN, A02_TX_PIN);
#else
  a02.begin(9600);
#endif
#if USE_DS18B20
  ds18b20.begin();
#endif
  Serial.println(F("# City Camp twin aquarium demo: DIST_MM / FILL_PCT / TEMP_C @ 115200"));
  read_temperature();
}

void loop() {
  unsigned long now = millis();
  // 3 Hz HIGH WATER ALARM blink (on 1/6 s, off 1/6 s) while >= 80 % full
  bool alarm = g_fill_pct >= ALARM_FILL_PCT;
  digitalWrite(LED_BUILTIN, alarm && ((now / 167UL) % 2UL == 0UL) ? HIGH : LOW);

  if (now - g_last_temp >= TEMP_PERIOD_MS) {
    g_last_temp = now;
    read_temperature();
  }
  if (now - g_last_sample < SAMPLE_PERIOD_MS) return;
  g_last_sample = now;

  float d = read_distance_mm();
  if (d < 0.0f) {
    Serial.println(F("# no echo"));
    return;
  }
  if (d < BLIND_ZONE_MM) d = BLIND_ZONE_MM;      // water at the transducer face
  float water = TANK_HEIGHT_MM - d;
  if (water < 0.0f) water = 0.0f;
  g_fill_pct = water / (TANK_HEIGHT_MM * FULL_BORE_FRACTION) * 100.0f;
  if (g_fill_pct > 120.0f) g_fill_pct = 120.0f;

  Serial.print(F("DIST_MM:"));
  Serial.println(d, 0);
  Serial.print(F("FILL_PCT:"));
  Serial.println(g_fill_pct, 1);
}
