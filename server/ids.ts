import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CODE_ALPHABET, EVENT_CODE_LENGTH } from '../shared/protocol';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function randomFrom(alphabet: string, length: number): string {
  // Rejection sampling keeps every character equally likely (no modulo bias).
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit) out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export const newEventCode = () => randomFrom(CODE_ALPHABET, EVENT_CODE_LENGTH);
export const newId = () => randomFrom(ID_ALPHABET, 10);
export const newSecret = () => randomBytes(18).toString('base64url');

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison so response timing can't leak the key. */
export function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
