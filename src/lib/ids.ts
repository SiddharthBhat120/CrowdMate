/**
 * Random ids for ops and devices.
 *
 * `crypto.randomUUID()` only exists on HTTPS pages (and localhost). Phones that
 * open the app over plain http://192.168.x.x on local Wi-Fi don't have it, but
 * `crypto.getRandomValues()` works everywhere, so we build ids from that.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function uid(length = 22): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  // 64-character alphabet: every byte maps evenly with & 63.
  for (const byte of bytes) out += ALPHABET[byte & 63];
  return out;
}
