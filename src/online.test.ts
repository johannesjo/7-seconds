import { describe, it, expect, afterEach } from 'vitest';
import { generateRoomId, safeUUID } from './online';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('safeUUID', () => {
  const realRandomUUID = crypto.randomUUID;

  afterEach(() => {
    crypto.randomUUID = realRandomUUID;
  });

  it('returns a valid v4 UUID using crypto.randomUUID when available', () => {
    expect(safeUUID()).toMatch(UUID_V4_RE);
  });

  it('falls back to a valid v4 UUID when crypto.randomUUID throws (insecure context)', () => {
    // Simulate plain-HTTP where randomUUID is unavailable/throws.
    crypto.randomUUID = (() => { throw new Error('not a secure context'); }) as typeof crypto.randomUUID;
    const id = safeUUID();
    expect(id).toMatch(UUID_V4_RE);
  });

  it('falls back to a valid v4 UUID when crypto.randomUUID is undefined', () => {
    // The real insecure-context shape: the method simply isn't there.
    crypto.randomUUID = undefined as unknown as typeof crypto.randomUUID;
    expect(safeUUID()).toMatch(UUID_V4_RE);
  });

  it('produces unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => safeUUID()));
    expect(ids.size).toBe(100);
  });
});

describe('generateRoomId', () => {
  it('returns a 6-character string', () => {
    const id = generateRoomId();
    expect(id).toHaveLength(6);
  });

  it('contains only non-ambiguous alphanumeric characters', () => {
    const ambiguous = /[lo01IO]/;
    for (let i = 0; i < 50; i++) {
      const id = generateRoomId();
      expect(id).toMatch(/^[a-km-np-z2-9]{6}$/);
      expect(ambiguous.test(id)).toBe(false);
    }
  });

  it('generates unique IDs across multiple calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRoomId()));
    // With 30^6 possible IDs, 100 calls should produce at least 95 unique
    expect(ids.size).toBeGreaterThanOrEqual(95);
  });
});
