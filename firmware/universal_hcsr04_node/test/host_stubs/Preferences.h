// Host stub: ESP32 NVS Preferences (empty store).
#pragma once
#include <cstddef>
#include <cstdint>
struct Preferences {
  bool begin(const char *, bool) { return true; }
  size_t putBytes(const char *, const void *, size_t n) { return n; }
  size_t getBytes(const char *, void *, size_t) { return 0; }
  size_t putUShort(const char *, uint16_t) { return 2; }
  uint16_t getUShort(const char *, uint16_t d) { return d; }
  void end() {}
};
