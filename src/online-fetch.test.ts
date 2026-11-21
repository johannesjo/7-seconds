import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout } from './online';

/** A fetch that never answers until its signal aborts, like a stalled connection. */
function hangingFetch() {
  return vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
}

describe('fetchWithTimeout', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('gives up on a request that never answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const pending = fetchWithTimeout(1000)('https://example.test');
    const outcome = expect(pending).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
  });

  it('still lets the caller cancel early', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const caller = new AbortController();
    const pending = fetchWithTimeout(60_000)('https://example.test', { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('leaves the deadline to a caller that sets its own', async () => {
    // Ranked sign-in waits up to 60 s via its own signal; a 20 s cut would
    // waste the single-use Play Games code.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    let settled = false;
    fetchWithTimeout(1000)('https://example.test', { signal: new AbortController().signal })
      .catch(() => {}).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
  });

  it('passes a normal answer through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    const res = await fetchWithTimeout(1000)('https://example.test');
    expect(await res.text()).toBe('ok');
  });
});
