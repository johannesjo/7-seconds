export function isAuthorizedWebhook(authorization: string | null, serviceRoleKey: string | undefined): boolean {
  return !!serviceRoleKey && authorization === `Bearer ${serviceRoleKey}`;
}

/** The recipient may need to plan, or to reveal a plan they already committed. */
export function shouldNotifyOpponent(
  match: { host_player: string; guest_player: string | null; status: string; current_round: number },
  committer: string,
  round: number,
  opponentTurn: { paths: unknown } | null,
): boolean {
  return match.status === 'active'
    && match.current_round === round
    && (committer === match.host_player || committer === match.guest_player)
    && (!opponentTurn || opponentTurn.paths == null);
}

export const TURN_NOTIFICATION_BODY = 'Your friend made a move. Open the match to continue.';
