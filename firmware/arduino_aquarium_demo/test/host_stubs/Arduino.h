// Host-side API stubs so scripts/test_phase5_firmware.py can compile-check the aquarium sketch
// (-Wall -Wextra -Werror) without an Arduino toolchain. Signatures only; nothing runs.
#pragma once
#include <stdint.h>
#include <stddef.h>

#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define SERIAL_8N1 0x800001c
#define LED_BUILTIN 13
#define F(s) (s)

inline void pinMode(int, int) {}
inline void digitalWrite(int, int) {}
inline unsigned long millis() { return 0; }
inline void delay(unsigned long) {}
inline void delayMicroseconds(unsigned int) {}
inline unsigned long pulseIn(int, int, unsigned long) { return 1166; }

struct Stream {
  int available() { return 0; }
  int read() { return -1; }
  void print(const char *) {}
  void print(float, int) {}
  void println(const char *) {}
  void println(float, int) {}
  void begin(unsigned long) {}
  void begin(unsigned long, uint32_t, int, int) {}
};
static Stream Serial, Serial1;
