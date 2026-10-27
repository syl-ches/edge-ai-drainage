// Subset of the RadioLib 7.x API used by main.cpp (signatures per RadioLib 7 LoRaWAN examples).
#pragma once
#include <cstddef>
#include <cstdint>
#define RADIOLIB_ERR_NONE 0
#define RADIOLIB_LORAWAN_NEW_SESSION -1118
#define RADIOLIB_LORAWAN_SESSION_RESTORED -1117
#define RADIOLIB_LORAWAN_NONCES_BUF_SIZE 16
#define RADIOLIB_LORAWAN_SESSION_BUF_SIZE 256
struct Module { Module(int, int, int, int) {} };
struct SX1262 { SX1262(Module*) {} int16_t begin() { return 0; } };
struct LoRaWANBand_t { int id; };
extern const LoRaWANBand_t AS923_3;
struct LoRaWANNode {
  LoRaWANNode(SX1262*, const LoRaWANBand_t*) {}
  int16_t beginOTAA(uint64_t, uint64_t, const uint8_t*, const uint8_t*) { return 0; }
  int16_t setBufferNonces(const uint8_t*) { return 0; }
  int16_t setBufferSession(const uint8_t*) { return 0; }
  int16_t activateOTAA() { return RADIOLIB_LORAWAN_NEW_SESSION; }
  void setADR(bool) {}
  int16_t sendReceive(const uint8_t*, size_t, uint8_t) { return 0; }
  uint8_t* getBufferNonces() { return buf; }
  uint8_t* getBufferSession() { return buf; }
  uint8_t buf[256] = {0};
};
