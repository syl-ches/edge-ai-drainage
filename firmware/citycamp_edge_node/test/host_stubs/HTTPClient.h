#pragma once
#include <cstddef>
#include <cstdint>
struct HTTPClient {
  void setTimeout(uint16_t) {}
  bool begin(const char*) { return true; }
  void addHeader(const char*, const char*) {}
  int POST(uint8_t*, size_t) { return 200; }
  void end() {}
};
