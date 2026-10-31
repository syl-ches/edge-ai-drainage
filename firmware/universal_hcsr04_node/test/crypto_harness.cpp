// Host harness for edge_crypto.h: the Speck32/64 paper vector and sealed frames that
// scripts/test_phase5_firmware.py compares with backend/crypto.py.
#include <cstdint>
#include <cstdio>
#include "../edge_crypto.h"

int main() {
  const uint16_t vk[4] = {0x1918, 0x1110, 0x0908, 0x0100};
  uint16_t rk[edgecrypto::ROUNDS];
  edgecrypto::round_keys(vk, rk);
  std::printf("SPECK %08X\n", (unsigned)edgecrypto::encrypt(rk, 0x6574694Cu));
  edgecrypto::Keys k;
  k.init();
  const uint32_t frames[3] = {0x34A89F12u, 0x54C1672Au, 0xFFFFFFFFu};
  const char *nodes[3] = {"EN-08", "EN-07", "EN-10"};
  for (int i = 0; i < 3; ++i) {
    uint32_t tag = 0;
    const uint32_t c = edgecrypto::seal(k, frames[i], 1000u + (uint32_t)i, nodes[i], &tag);
    std::printf("SEAL %s %08X %u %08X %08X\n", nodes[i], (unsigned)frames[i], 1000u + (unsigned)i, (unsigned)c, (unsigned)tag);
  }
  return 0;
}
