// =============================================================================
// Black-box telemetry logger for the universal node (Phase 9C), board-independent core.
//   * a ring of the last frames (32-bit word + millis + sequence), oldest first
//   * zlib-compatible CRC-32 over each word's big-endian bytes (== backend/database.py::crc32_frames)
//   * the DUMP_SD_LOG burst format the web app parses (src/utils/sdRecovery.ts):
//       [SD_DUMP] {"i":0,"seq":812,"t_ms":5123456,"hex":"0x54C1672A"}
//       [SD_DUMP_END] {"frames":42,"crc32":"1A2B3C4D","tier":"SPI_SD"}
// The sketch provides the storage (RAM + NVS on ESP32, EEPROM on AVR) and the SPI microSD files.
// Tested on the host by scripts/test_phase5_firmware.py (test/blackbox_harness.cpp).
// =============================================================================
#pragma once
#include <stdint.h>

namespace blackbox {

/** One CRC-32 (reflected 0xEDB88320) step over a word's 4 big-endian bytes. Start 0xFFFFFFFF, end ^0xFFFFFFFF. */
inline uint32_t crc32_update(uint32_t crc, uint32_t word) {
  for (int k = 3; k >= 0; --k) {
    crc ^= (word >> (8 * k)) & 0xFFUL;
    for (int b = 0; b < 8; ++b) crc = (crc & 1UL) ? (0xEDB88320UL ^ (crc >> 1)) : (crc >> 1);
  }
  return crc;
}

/** "0x54C1672A" (10 chars + NUL). */
inline void hex32(uint32_t w, char out[11]) {
  static const char *H = "0123456789ABCDEF";
  out[0] = '0';
  out[1] = 'x';
  for (int i = 0; i < 8; ++i) out[2 + i] = H[(w >> (28 - 4 * i)) & 0xF];
  out[10] = '\0';
}

/** "1A2B3C4D" (8 chars + NUL). */
inline void hex8(uint32_t w, char out[9]) {
  char t[11];
  hex32(w, t);
  for (int i = 0; i < 9; ++i) out[i] = t[2 + i];
}

/** RAM ring of the last CAP frames. */
template <uint16_t CAP>
struct RamRing {
  uint32_t words[CAP];
  uint32_t times[CAP];
  uint32_t seqs[CAP];
  uint16_t head = 0;
  uint16_t n = 0;
  void push(uint32_t w, uint32_t t_ms, uint32_t s) {
    words[head] = w;
    times[head] = t_ms;
    seqs[head] = s;
    head = (uint16_t)((head + 1) % CAP);
    if (n < CAP) ++n;
  }
  uint16_t count() const { return n; }
  uint16_t slot(uint16_t i) const { return (uint16_t)((head + CAP - n + i) % CAP); }  // i = 0 oldest
  uint32_t word(uint16_t i) const { return words[slot(i)]; }
  uint32_t t_ms(uint16_t i) const { return times[slot(i)]; }
  uint32_t seq(uint16_t i) const { return seqs[slot(i)]; }
};

/** Streams a ring as the DUMP_SD_LOG burst; returns the final CRC-32. Out needs print(const char*),
 *  print(unsigned long) and println(const char*). */
template <class Out, class Ring>
uint32_t dump(Out &o, const Ring &r, const char *tier) {
  uint32_t crc = 0xFFFFFFFFUL;
  char hx[11];
  for (uint16_t i = 0; i < r.count(); ++i) {
    const uint32_t w = r.word(i);
    hex32(w, hx);
    o.print("[SD_DUMP] {\"i\":");
    o.print((unsigned long)i);
    o.print(",\"seq\":");
    o.print((unsigned long)r.seq(i));
    o.print(",\"t_ms\":");
    o.print((unsigned long)r.t_ms(i));
    o.print(",\"hex\":\"");
    o.print(hx);
    o.println("\"}");
    crc = crc32_update(crc, w);
  }
  crc ^= 0xFFFFFFFFUL;
  char c8[9];
  hex8(crc, c8);
  o.print("[SD_DUMP_END] {\"frames\":");
  o.print((unsigned long)r.count());
  o.print(",\"crc32\":\"");
  o.print(c8);
  o.print("\",\"tier\":\"");
  o.print(tier);
  o.println("\"}");
  return crc;
}

}  // namespace blackbox
