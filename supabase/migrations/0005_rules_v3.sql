-- Rules version 3: mortar blast damage falls off towards the rim. Rounds of
-- matches still in play on version 2 would resolve differently now, so they
-- end here with no winner (finish_reason 'version').

update public.matches set status = 'abandoned', finish_reason = 'version', finished_at = now()
  where status in ('open','active') and rules <> 3;
