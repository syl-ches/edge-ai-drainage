// Host stub: AVR 1 KB EEPROM.
#pragma once
#include <cstdint>
struct EEPROMClass {
  uint8_t mem[1024] = {};
  uint8_t read(int a) const { return mem[a & 1023]; }
  void update(int a, uint8_t v) { mem[a & 1023] = v; }
  int length() const { return 1024; }
};
static EEPROMClass EEPROM;
