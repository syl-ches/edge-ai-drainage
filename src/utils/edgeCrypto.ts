// Edge-to-command payload protection (Phase 9D) ≡ backend/crypto.py ≡ firmware edge_crypto.h,
// locked by tests/frontend/fixtures/crypto_golden.json.
//
// Speck32/64 counter mode over the 32-bit frame + a Speck CBC-MAC over (nonce, ciphertext,
// fnv1a32(node)) truncated to the tag length (default 32 bits; 8 bits is forgeable once in 256).
// The nonce is the node's rolling frame counter; a nonce that does not advance is a replay.
// DEV_PSK is a public demo key; real deployments set their own pre-shared key.

export const DEV_PSK = 'BAGUIO_LGU_PSK_2026';
export const DEFAULT_TAG_BITS = 32;
const ROUNDS = 22;
const M16 = 0xffff;

const ror = (x: number, r: number) => ((x >>> r) | (x << (16 - r))) & M16;
const rol = (x: number, r: number) => ((x << r) | (x >>> (16 - r))) & M16;

export type SpeckKey = [number, number, number, number]; // (l2, l1, l0, k0)

export function speckRoundKeys([l2, l1, l0, k0]: SpeckKey): number[] {
  const l = [l0, l1, l2];
  const k = [k0];
  for (let i = 0; i < ROUNDS - 1; i++) {
    l.push(((k[i] + ror(l[i], 7)) & M16) ^ i);
    k.push(rol(k[i], 2) ^ l[i + 3]);
  }
  return k;
}

export function speckEncrypt(rk: number[], block: number): number {
  let x = (block >>> 16) & M16;
  let y = block & M16;
  for (const k of rk) {
    x = ((ror(x, 7) + y) & M16) ^ k;
    y = rol(y, 2) ^ x;
  }
  return ((x << 16) | y) >>> 0;
}

export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h >>> 0;
}

export interface EdgeKeys {
  enc: number[]; // round keys
  mac: number[];
  tagBits: number;
}

/** K = first 8 bytes of SHA-256(label | psk), as four big-endian 16-bit words. */
export async function deriveEdgeKeys(psk = DEV_PSK, tagBits = DEFAULT_TAG_BITS): Promise<EdgeKeys> {
  if (![8, 16, 24, 32].includes(tagBits)) throw new RangeError('tag bits must be 8, 16, 24 or 32');
  const k = async (label: string): Promise<SpeckKey> => {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${label}|${psk}`)));
    return [0, 1, 2, 3].map((i) => (d[2 * i] << 8) | d[2 * i + 1]) as SpeckKey;
  };
  return { enc: speckRoundKeys(await k('BFI-EDGE-ENC')), mac: speckRoundKeys(await k('BFI-EDGE-MAC')), tagBits };
}

const hex = (v: number, digits: number) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;

export function edgeTag(keys: EdgeKeys, nonce: number, cipher: number, node: string): number {
  let t = speckEncrypt(keys.mac, nonce >>> 0);
  t = speckEncrypt(keys.mac, (t ^ cipher) >>> 0);
  t = speckEncrypt(keys.mac, (t ^ fnv1a32(node)) >>> 0);
  return keys.tagBits === 32 ? t : t >>> (32 - keys.tagBits);
}

export interface EncryptedFrame {
  cipherHex: string;
  authTagHex: string;
  nonce: number;
}

export function encryptTelemetryFrame(rawFrame32: number, nonce: number, keys: EdgeKeys, node: string): EncryptedFrame {
  const cipher = (rawFrame32 ^ speckEncrypt(keys.enc, nonce >>> 0)) >>> 0;
  return { cipherHex: hex(cipher, 8), authTagHex: hex(edgeTag(keys, nonce, cipher, node), keys.tagBits / 4), nonce: nonce >>> 0 };
}

export interface VerifiedFrame {
  verified: boolean;
  reason: null | 'INVALID_TAG' | 'REPLAYED_NONCE';
  plainHex: string | null;
  latencyMicroseconds: number;
}

/** Verifies the tag (and, with `lastNonce`, the replay window) before decrypting. */
export function decryptAndVerifyFrame(cipherHex: string, authTagHex: string, nonce: number, keys: EdgeKeys, node: string, lastNonce?: number): VerifiedFrame {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const cipher = parseInt(cipherHex, 16) >>> 0;
  const okTag = (parseInt(authTagHex, 16) >>> 0) === edgeTag(keys, nonce, cipher, node) >>> 0;
  const replay = lastNonce !== undefined && nonce <= lastNonce;
  const verified = okTag && !replay;
  const plain = (cipher ^ speckEncrypt(keys.enc, nonce >>> 0)) >>> 0;
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { verified, reason: verified ? null : okTag ? 'REPLAYED_NONCE' : 'INVALID_TAG', plainHex: verified ? hex(plain, 8) : null, latencyMicroseconds: Math.round((t1 - t0) * 1000 * 10) / 10 };
}

/** A spoofed frame for the demo: a plausible alarm payload with a tag the attacker had to guess. */
export function spoofedFrame(real: EncryptedFrame): EncryptedFrame {
  const forged = (parseInt(real.cipherHex, 16) ^ 0x00ff0000) >>> 0; // flips the dh/dt + depth bits
  return { cipherHex: hex(forged, 8), authTagHex: real.authTagHex, nonce: real.nonce + 1 };
}
