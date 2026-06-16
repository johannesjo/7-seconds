import { describe, it, expect } from 'vitest';
import { withRetry } from './online-retry';

const noSleep = () => Promise.resolve();

describe('withRetry', () => {
  it('returns immediately on success without retrying', async () => {
    let calls = 0;
    const res = await withRetry(async () => { calls++; return { error: null, data: 1 }; }, { sleep: noSleep });
    expect(calls).toBe(1);
    expect(res.data).toBe(1);
  });

  it('retries a transient error then succeeds', async () => {
    let calls = 0;
    const res = await withRetry(async () => {
      calls++;
      if (calls < 3) return { error: { message: 'network blip' } };
      return { error: null, data: 'ok' };
    }, { sleep: noSleep, attempts: 5 });
    expect(calls).toBe(3);
    expect(res.error).toBeNull();
    expect(res.data).toBe('ok');
  });

  it('does NOT retry a permanent error (unique violation)', async () => {
    let calls = 0;
    const res = await withRetry(async () => {
      calls++;
      return { error: { code: '23505', message: 'duplicate key' } };
    }, { sleep: noSleep, attempts: 5 });
    expect(calls).toBe(1);
    expect(res.error?.code).toBe('23505');
  });

  it('does NOT retry an RLS denial (42501)', async () => {
    let calls = 0;
    await withRetry(async () => { calls++; return { error: { code: '42501', message: 'denied' } }; },
      { sleep: noSleep, attempts: 5 });
    expect(calls).toBe(1);
  });

  it('does NOT retry the write-once seed guard (P0001)', async () => {
    let calls = 0;
    await withRetry(async () => { calls++; return { error: { code: 'P0001', message: 'seed is write-once' } }; },
      { sleep: noSleep, attempts: 5 });
    expect(calls).toBe(1);
  });

  it('gives up after the configured attempts on a persistent transient error', async () => {
    let calls = 0;
    const res = await withRetry(async () => { calls++; return { error: { message: 'still down' } }; },
      { sleep: noSleep, attempts: 3 });
    expect(calls).toBe(3);
    expect(res.error?.message).toBe('still down');
  });

  it('retries a thrown network error, then re-throws if it never recovers', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error('fetch failed'); },
      { sleep: noSleep, attempts: 3 })).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });

  it('recovers from a thrown error on a later attempt', async () => {
    let calls = 0;
    const res = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error('transient');
      return { error: null, data: 'recovered' };
    }, { sleep: noSleep, attempts: 3 });
    expect(res.data).toBe('recovered');
    expect(calls).toBe(2);
  });
});
