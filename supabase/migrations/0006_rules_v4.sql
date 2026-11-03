-- Rules version 4: soldiers hunker after finishing a move, and the round state
-- carries their setup. Rounds of matches still in play on version 3 would
-- resolve differently now, so they end here with no winner (finish_reason 'version').

update public.matches set status = 'abandoned', finish_reason = 'version', finished_at = now()
  where status in ('open','active') and rules <> 4;
