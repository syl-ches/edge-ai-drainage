// Host stub: SPI bus (no-op).
#pragma once
struct SPIClass {
  void begin(int, int, int, int) {}
};
__attribute__((unused)) static SPIClass SPI;
