// Host harness for blackbox.h: pushes 300 LCG frames into a 256-frame ring and prints the
// DUMP_SD_LOG burst; scripts/test_phase5_firmware.py checks order, count and CRC-32 against zlib.
#include <cstdint>
#include <cstdio>
#include "../blackbox.h"

struct Out {
  void print(const char *s) { std::fputs(s, stdout); }
  void print(unsigned long v) { std::printf("%lu", v); }
  void println(const char *s) { std::puts(s); }
};

int main() {
  blackbox::RamRing<256> ring;
  uint32_t x = 0x12345678u;
  for (uint32_t i = 0; i < 300; ++i) {
    x = x * 1664525u + 1013904223u;
    ring.push(x, 1000u + i * 1000u, i + 1u);
  }
  Out o;
  blackbox::dump(o, ring, "SPI_SD");
  return 0;
}
