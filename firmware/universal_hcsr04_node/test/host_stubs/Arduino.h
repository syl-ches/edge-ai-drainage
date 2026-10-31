// Host-side Arduino / ESP32 API stubs: lets scripts/test_phase5_firmware.py compile the universal
// sketch (-Wall -Wextra -Werror) and diff its edge pipeline against backend/edge_dsp.py.
#pragma once
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

#define UNIVERSAL_HOST_BUILD 1  // never read a developer's local node_config.h in tests
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1

inline void pinMode(int, int) {}
inline void digitalWrite(int, int) {}
inline unsigned long millis() { return 0; }
inline void delay(unsigned long) {}
inline void delayMicroseconds(unsigned int) {}
inline unsigned long pulseIn(int, int, unsigned long) { return 1166; }

struct HostSerial {
  void begin(unsigned long) {}
  void print(const char *s) { std::fputs(s, stdout); }
  void print(double v, int d) { std::printf("%.*f", d, v); }
  void print(unsigned long v) { std::printf("%lu", v); }
  void println(const char *s) { std::puts(s); }
  void println(double v, int d) { std::printf("%.*f\n", d, v); }
  int available() { return 0; }
  int read() { return -1; }
};
static HostSerial Serial;

#if defined(ESP32)
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(m) ((void)(m))
#define portEXIT_CRITICAL(m) ((void)(m))
#define pdMS_TO_TICKS(ms) (ms)
inline void vTaskDelay(unsigned long) {}
inline void configTime(long, int, const char *, const char *) {}
inline int xTaskCreatePinnedToCore(void (*)(void *), const char *, unsigned, void *, int, void *, int) { return 1; }
#endif
