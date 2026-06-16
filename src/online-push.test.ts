import { describe, it, expect } from 'vitest';
import { urlBase64ToUint8Array, isValidEmail } from './online-push';

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url string to the expected bytes', () => {
    // "hello" -> base64url "aGVsbG8"
    const out = urlBase64ToUint8Array('aGVsbG8');
    expect(Array.from(out)).toEqual([104, 101, 108, 108, 111]);
  });

  it('handles base64url-specific chars (- and _)', () => {
    // bytes [251, 255] -> base64 "+/8=" -> base64url "-_8"
    const out = urlBase64ToUint8Array('-_8');
    expect(Array.from(out)).toEqual([251, 255]);
  });

  it('pads correctly for lengths not divisible by 4', () => {
    // single byte 0x00 -> base64 "AA==" -> base64url "AA"
    expect(Array.from(urlBase64ToUint8Array('AA'))).toEqual([0]);
  });

  it('produces the 65-byte length typical of a VAPID key', () => {
    const key = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
    expect(urlBase64ToUint8Array(key).length).toBe(65);
  });
});

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.example.com')).toBe(true);
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['', 'plainstring', 'no@domain', '@no-local.com', 'a b@c.com', 'two@@b.com']) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it('rejects addresses over the 254-char SMTP limit', () => {
    const long = 'a'.repeat(250) + '@b.com';
    expect(isValidEmail(long)).toBe(false);
  });
});
