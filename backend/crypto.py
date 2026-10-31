"""Edge-to-command payload protection (Phase 9D) ≡ src/utils/edgeCrypto.ts ≡ firmware edge_crypto.h.

The 32-bit telemetry frame is encrypted with Speck32/64 in counter mode and authenticated with a
Speck CBC-MAC over (nonce, ciphertext, node hash), truncated to TAG_BITS (default 32):

    keystream = Speck32/64(K_enc, nonce)              cipher = frame XOR keystream
    tag       = msb_TAG_BITS( CBC-MAC_Speck(K_mac; nonce, cipher, fnv1a32(node_id)) )

The nonce is the node's rolling frame counter; the receiver rejects a nonce that does not exceed
the last one accepted from that node (replay). Keys are derived from a pre-shared passphrase:
K = first 8 bytes of SHA-256("BFI-EDGE-ENC|" + psk) / ("BFI-EDGE-MAC|" + psk).

Notes for the record:
  * LoRaWAN 1.0.x already encrypts FRMPayload (AES-128, AppSKey) and adds a 4-byte MIC (NwkSKey).
    This layer protects the paths LoRaWAN does not: USB Web Serial, Wi-Fi HTTP posts, the backend
    ingest, and replays across them.
  * An 8-bit tag is forgeable by chance once in 256 tries; TAG_BITS defaults to 32. Shorter tags
    are accepted only when explicitly requested.
  * DEV_PSK is a demo key and is public in this repository. Set CITYCAMP_EDGE_PSK for real use.
"""
from __future__ import annotations

import hashlib
import os
import time

DEV_PSK = "BAGUIO_LGU_PSK_2026"
TAG_BITS = 32
ROUNDS = 22
MASK16 = 0xFFFF


def _ror(x: int, r: int) -> int:
    return ((x >> r) | (x << (16 - r))) & MASK16


def _rol(x: int, r: int) -> int:
    return ((x << r) | (x >> (16 - r))) & MASK16


def speck_round_keys(key: tuple[int, int, int, int]) -> list[int]:
    """Key words (l2, l1, l0, k0), as the Speck paper writes them (e.g. 1918 1110 0908 0100)."""
    l2, l1, l0, k0 = key
    ls, ks = [l0, l1, l2], [k0]
    for i in range(ROUNDS - 1):
        ls.append(((ks[i] + _ror(ls[i], 7)) & MASK16) ^ i)
        ks.append(_rol(ks[i], 2) ^ ls[i + 3])
    return ks


def speck_encrypt(rk: list[int], block: int) -> int:
    """Encrypts a 32-bit block (x = high 16 bits, y = low 16 bits)."""
    x, y = (block >> 16) & MASK16, block & MASK16
    for k in rk:
        x = ((_ror(x, 7) + y) & MASK16) ^ k
        y = _rol(y, 2) ^ x
    return (x << 16) | y


def fnv1a32(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def derive_keys(psk: str) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
    def k(label: str) -> tuple[int, int, int, int]:
        d = hashlib.sha256(f"{label}|{psk}".encode("utf-8")).digest()[:8]
        return tuple(int.from_bytes(d[2 * i:2 * i + 2], "big") for i in range(4))  # type: ignore[return-value]
    return k("BFI-EDGE-ENC"), k("BFI-EDGE-MAC")


class EdgeCipher:
    def __init__(self, psk: str | None = None, tag_bits: int = TAG_BITS) -> None:
        if tag_bits not in (8, 16, 24, 32):
            raise ValueError("tag_bits must be 8, 16, 24 or 32")
        self.psk = psk if psk is not None else os.environ.get("CITYCAMP_EDGE_PSK", DEV_PSK)
        self.tag_bits = tag_bits
        enc, mac = derive_keys(self.psk)
        self.rk_enc = speck_round_keys(enc)
        self.rk_mac = speck_round_keys(mac)
        self.last_nonce: dict[str, int] = {}

    def tag(self, nonce: int, cipher: int, node_id: str) -> int:
        t = speck_encrypt(self.rk_mac, nonce & 0xFFFFFFFF)
        t = speck_encrypt(self.rk_mac, t ^ (cipher & 0xFFFFFFFF))
        t = speck_encrypt(self.rk_mac, t ^ fnv1a32(node_id))
        return t >> (32 - self.tag_bits)

    def encrypt(self, frame: int, nonce: int, node_id: str) -> dict:
        cipher = (frame ^ speck_encrypt(self.rk_enc, nonce & 0xFFFFFFFF)) & 0xFFFFFFFF
        return dict(cipher_hex=f"0x{cipher:08X}", tag_hex=f"0x{self.tag(nonce, cipher, node_id):0{self.tag_bits // 4}X}", nonce=nonce & 0xFFFFFFFF)

    def decrypt_and_verify(self, cipher_hex: str, tag_hex: str, nonce: int, node_id: str, check_replay: bool = True) -> dict:
        t0 = time.perf_counter()
        cipher = int(cipher_hex, 16) & 0xFFFFFFFF
        ok_tag = int(tag_hex, 16) == self.tag(nonce, cipher, node_id)
        replay = check_replay and node_id in self.last_nonce and nonce <= self.last_nonce[node_id]
        verified = ok_tag and not replay
        plain = (cipher ^ speck_encrypt(self.rk_enc, nonce & 0xFFFFFFFF)) & 0xFFFFFFFF
        if verified and check_replay:
            self.last_nonce[node_id] = nonce
        return dict(verified=verified, reason=None if verified else ("REPLAYED_NONCE" if ok_tag else "INVALID_TAG"),
                    plain_hex=f"0x{plain:08X}" if verified else None,
                    latency_us=round((time.perf_counter() - t0) * 1e6, 1))


if __name__ == "__main__":  # print the derived keys for firmware/universal_hcsr04_node/edge_crypto.h
    import sys
    enc, mac = derive_keys(sys.argv[1] if len(sys.argv) > 1 else DEV_PSK)
    print("ENC", ", ".join(f"0x{w:04X}" for w in enc))
    print("MAC", ", ".join(f"0x{w:04X}" for w in mac))
