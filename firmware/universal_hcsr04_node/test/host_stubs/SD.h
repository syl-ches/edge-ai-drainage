// Host stub: Arduino SD library. SD.begin() fails (no card), so the sketch exercises its fail-over.
#pragma once
#include <cstddef>
#include <cstdint>
#define FILE_WRITE 1
#define FILE_APPEND 2
struct File {
  bool ok = false;
  explicit operator bool() const { return ok; }
  size_t write(const uint8_t *, size_t n) { return n; }
  void print(const char *) {}
  void print(unsigned long) {}
  void println(const char *) {}
  void close() {}
};
struct SDClass {
  bool begin(int) { return false; }
  File open(const char *, int) { return File{}; }
};
static SDClass SD;
