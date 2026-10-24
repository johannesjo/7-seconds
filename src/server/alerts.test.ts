import { describe, it, expect } from 'vitest';
import { alertText, alertUrl, fcmMessage, webPushPayload, type Alert } from './alerts';

const alert: Alert = { player: 'p', match: 'abc234', kind: 'turn', ranked: false, opponent: 'Bea', round: 3 };

describe('turn alerts', () => {
  it('words each moment', () => {
    expect(alertText(alert)).toEqual({ title: 'Your turn', body: 'Bea has planned round 3.' });
    expect(alertText({ ...alert, kind: 'round' }).body).toBe('Watch round 2 vs Bea, then plan round 3.');
    expect(alertText({ ...alert, kind: 'result', won: false, opponent: null }).body).toBe('You lost to Your opponent. Watch the final round.');
    expect(alertText({ ...alert, kind: 'joined', ranked: true }).title).toBe('Ranked opponent found');
    expect(alertText({ ...alert, kind: 'forfeit' }).title).toBe('Victory!');
  });

  it('links to the match, marking ranked ones', () => {
    expect(alertUrl('https://example.com/7-seconds/', alert)).toBe('https://example.com/7-seconds/?amatch=abc234');
    expect(alertUrl('https://example.com/7-seconds/', { ...alert, ranked: true })).toBe('https://example.com/7-seconds/?amatch=abc234&ranked=1');
    expect(JSON.parse(webPushPayload('https://example.com/', alert))).toMatchObject({ title: 'Your turn', tag: 'seven-abc234' });
  });

  it('builds an FCM message that replaces the match’s earlier alert', () => {
    const message = fcmMessage({ ...alert, ranked: true }, 'tok');
    expect(message).toMatchObject({
      token: 'tok',
      data: { seven_match: 'abc234', seven_ranked: '1' },
      android: { collapse_key: 'seven-abc234', notification: { tag: 'seven-abc234', channel_id: 'turns' } },
    });
  });
});
