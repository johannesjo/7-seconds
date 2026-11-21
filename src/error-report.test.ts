import { describe, it, expect, vi } from 'vitest';
import { createErrorReporter } from './error-report';

const ORIGIN = 'https://game.example';
const make = (send = vi.fn()) => ({ send, report: createErrorReporter({ send, origin: ORIGIN, version: '1.5.1', platform: 'web' }) });

describe('createErrorReporter', () => {
  it('sends the message, where it happened, the version and the platform, and nothing else', () => {
    const { send, report } = make();
    const error = new Error('boom');
    error.stack = `Error: boom\n    at draw (${ORIGIN}/assets/index-abc.js:1:200)`;
    report({ message: 'boom', error });
    expect(send).toHaveBeenCalledWith({
      message: 'boom',
      stack: 'Error: boom\n    at draw (/assets/index-abc.js:1:200)',
      version: '1.5.1',
      platform: 'web',
    });
  });

  it('reports a repeated error once', () => {
    const { send, report } = make();
    report({ message: 'same' });
    report({ message: 'same' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stops after five reports in one session', () => {
    const { send, report } = make();
    for (let i = 0; i < 8; i++) report({ message: `error ${i}` });
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('caps long text', () => {
    const { send, report } = make();
    report({ message: 'x'.repeat(5000) });
    expect(send.mock.calls[0][0].message).toHaveLength(300);
  });

  it('ignores errors from other sites (browser extensions, injected scripts)', () => {
    const { send, report } = make();
    report({ message: 'Script error.' });
    report({ message: 'ext', filename: 'chrome-extension://abc/content.js' });
    expect(send).not.toHaveBeenCalled();
  });
});
