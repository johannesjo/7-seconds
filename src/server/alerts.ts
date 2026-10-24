// What the referee tells an absent player, and how. Pure: the Edge Function
// supplies the senders (Web Push, Firebase Cloud Messaging, email).

export type AlertKind = 'joined' | 'turn' | 'round' | 'result' | 'forfeit';

export interface Alert {
  /** The Supabase user to notify. */
  player: string;
  match: string;
  kind: AlertKind;
  ranked: boolean;
  /** The opponent's name, if they have one. */
  opponent: string | null;
  /** The round the player should plan next ('round'), or the one waiting ('turn'). */
  round: number;
  /** For 'result': whether this player won. */
  won?: boolean;
}

export function alertText(alert: Alert): { title: string; body: string } {
  const who = alert.opponent ?? 'Your opponent';
  switch (alert.kind) {
    case 'joined': return { title: alert.ranked ? 'Ranked opponent found' : 'Opponent joined', body: `${who} is in. Plan round ${alert.round}.` };
    case 'turn': return { title: 'Your turn', body: `${who} has planned round ${alert.round}.` };
    case 'round': return { title: 'Round played', body: `Watch round ${alert.round - 1} vs ${who}, then plan round ${alert.round}.` };
    case 'result': return { title: alert.won ? 'Victory!' : 'Defeat', body: `${alert.won ? 'You beat' : 'You lost to'} ${who}. Watch the final round.` };
    case 'forfeit': return { title: 'Victory!', body: `${who} conceded the match.` };
  }
}

/** The link that opens the match in the web game. */
export function alertUrl(appUrl: string, alert: Alert): string {
  const url = new URL(appUrl);
  url.searchParams.set('amatch', alert.match);
  if (alert.ranked) url.searchParams.set('ranked', '1');
  return url.toString();
}

/** The FCM HTTP v1 message for one Android device. Tapping it opens the match
 *  (TurnAlertsPlugin reads `data`); a newer alert for the same match replaces
 *  the older one, on the phone and while it is offline. */
export function fcmMessage(alert: Alert, token: string) {
  return {
    token,
    notification: alertText(alert),
    data: { seven_match: alert.match, seven_ranked: alert.ranked ? '1' : '0' },
    android: {
      priority: 'high',
      collapse_key: `seven-${alert.match}`,
      // Matches end after a week without moves; an older alert has nothing left to say.
      ttl: '604800s',
      notification: { tag: `seven-${alert.match}`, channel_id: 'turns' },
    },
  };
}

/** The Web Push payload public/sw-notify.js shows. */
export function webPushPayload(appUrl: string, alert: Alert): string {
  return JSON.stringify({ ...alertText(alert), url: alertUrl(appUrl, alert), tag: `seven-${alert.match}` });
}
