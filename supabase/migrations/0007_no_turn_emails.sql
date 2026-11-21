-- Email turn alerts are gone: the addresses were never verified, so alerts
-- could be aimed at someone else's inbox. Delete the stored addresses and stop
-- new ones being saved, so the server holds no email for online play.
-- Hold writes until the constraint is in: an old client saving an address
-- between the two statements would fail the migration.
lock table public.players in share row exclusive mode;
update public.players set email = null, notify_email = false
  where email is not null or notify_email;
alter table public.players add constraint players_no_email check (email is null and not notify_email);
