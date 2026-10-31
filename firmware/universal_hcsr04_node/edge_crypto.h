// =============================================================================
// Edge payload protection (Phase 9D) == backend/crypto.py == src/utils/edgeCrypto.ts.
// Speck32/64 counter mode over the 32-bit frame + Speck CBC-MAC tag over (nonce, cipher,
// fnv1a32(node)), 32-bit tag. Header-only, no heap; host-tested by scripts/test_phase5_firmware.py.
// The keys below are derived from the PUBLIC demo passphrase BAGUIO_LGU_PSK_2026:
//   python -m backend.crypto "<your passphrase>"   -> paste ENC / MAC words here for a real fleet.
// LoRaWAN already encrypts + MICs its FRMPayload; this layer covers USB, Wi-Fi and replays.
// =============================================================================
#pragma once
#include <stdint.h>

#ifndef EDGE_KEY_ENC
#define EDGE_KEY_ENC {0x0277, 0xC423, 0x53FC, 0xBE6C}  // (l2, l1, l0, k0)
#endif
#ifndef EDGE_KEY_MAC
#define EDGE_KEY_MAC {0x875E, 0x9288, 0x368B, 0xEDAC}
#endif

namespace edgecrypto {

static const int ROUNDS = 22;

inline uint16_t ror16(uint16_t x, int r) { return (uint16_t)((x >> r) | (x << (16 - r))); }
inline uint16_t rol16(uint16_t x, int r) { return (uint16_t)((x << r) | (x >> (16 - r))); }

/** Round keys from key words (l2, l1, l0, k0). */
inline void round_keys(const uint16_t key[4], uint16_t rk[ROUNDS]) {
  uint16_t l[ROUNDS + 2];
  l[0] = key[2];
  l[1] = key[1];
  l[2] = key[0];
  rk[0] = key[3];
  for (int i = 0; i < ROUNDS - 1; ++i) {
    l[i + 3] = (uint16_t)((uint16_t)(rk[i] + ror16(l[i], 7)) ^ (uint16_t)i);
    rk[i + 1] = (uint16_t)(rol16(rk[i], 2) ^ l[i + 3]);
  }
}

inline uint32_t encrypt(const uint16_t rk[ROUNDS], uint32_t block) {
  uint16_t x = (uint16_t)(block >> 16);
  uint16_t y = (uint16_t)(block & 0xFFFFu);
  for (int i = 0; i < ROUNDS; ++i) {
    x = (uint16_t)((uint16_t)(ror16(x, 7) + y) ^ rk[i]);
    y = (uint16_t)(rol16(y, 2) ^ x);
  }
  return ((uint32_t)x << 16) | y;
}

inline uint32_t fnv1a32(const char *s) {
  uint32_t h = 0x811C9DC5UL;
  while (*s) h = (h ^ (uint8_t)*s++) * 0x01000193UL;
  return h;
}

struct Keys {
  uint16_t enc[ROUNDS];
  uint16_t mac[ROUNDS];
  void init() {
    const uint16_t ke[4] = EDGE_KEY_ENC;
    const uint16_t km[4] = EDGE_KEY_MAC;
    round_keys(ke, enc);
    round_keys(km, mac);
  }
};

inline uint32_t tag32(const Keys &k, uint32_t nonce, uint32_t cipher, const char *node) {
  uint32_t t = encrypt(k.mac, nonce);
  t = encrypt(k.mac, t ^ cipher);
  return encrypt(k.mac, t ^ fnv1a32(node));
}

/** Encrypts one frame; writes the 32-bit tag. */
inline uint32_t seal(const Keys &k, uint32_t frame, uint32_t nonce, const char *node, uint32_t *tag) {
  const uint32_t cipher = frame ^ encrypt(k.enc, nonce);
  *tag = tag32(k, nonce, cipher, node);
  return cipher;
}

}  // namespace edgecrypto
