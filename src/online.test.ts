import { describe, it, expect, beforeEach } from 'vitest';
import { generateRoomId, getShareUrl } from './online';

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

describe('getShareUrl', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      value: { location: { href: 'https://example.com/game' } },
      writable: true,
      configurable: true,
    });
  });

  it('appends join param to current URL', () => {
    const url = getShareUrl('abc123');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('join')).toBe('abc123');
  });

  it('preserves existing URL structure', () => {
    const url = getShareUrl('xyz789');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('join')).toBe('xyz789');
    expect(parsed.origin).toBe('https://example.com');
    expect(parsed.pathname).toBe('/game');
  });
});
