// Host-side stub (see Arduino.h in this folder).
#pragma once
#include <cstddef>
#include <cstdint>
struct HTTPClient {
  void setConnectTimeout(int32_t) {}
  void setTimeout(uint16_t) {}
  bool begin(const char *) { return true; }
  void addHeader(const char *, const char *) {}
  int POST(uint8_t *, size_t) { return 200; }
  void end() {}
};
