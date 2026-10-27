// Minimal Arduino-ESP32 API stubs: host-side *syntax* check of src/main.cpp only.
#pragma once
#include <cctype>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#define RTC_DATA_ATTR
#define HIGH 1
#define LOW 0
#define OUTPUT 1
#define SERIAL_8N1 0x800001c
inline void pinMode(int, int) {}
inline void digitalWrite(int, int) {}
inline uint32_t analogReadMilliVolts(int) { return 2000; }
inline void analogReadResolution(int) {}
inline uint32_t millis() { return 0; }
inline void delay(uint32_t) {}
inline uint32_t esp_random() { return 4; }
struct Print {
  int printf(const char* f, ...) { va_list a; va_start(a, f); int n = vprintf(f, a); va_end(a); return n; }
  size_t println(const char* s) { return static_cast<size_t>(::printf("%s\n", s)); }
  void flush() {}
};
struct HardwareSerial : Print {
  void begin(unsigned long, uint32_t = SERIAL_8N1, int = -1, int = -1) {}
  void end() {}
  int available() { return 0; }
  int read() { return -1; }
};
extern HardwareSerial Serial;
extern HardwareSerial Serial1;
