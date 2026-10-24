# Deployment

The web game is published to GitHub Pages; the Android app is a Capacitor
shell that loads that site (`capacitor.config.ts`, `server.url`). Online play
runs on its dedicated Supabase project `puoxmqovckvfoqyihasl`. Imperial
Battleground uses a separate project and separate deployment credentials.

## On every push to `main`

`.github/workflows/deploy.yml` runs, in order:

1. **Backend** (`.github/workflows/backend.yml`):
   - checks without secrets: install, typecheck, `npm run referee:check`
     (the committed referee bundle matches the source), and every test,
     including the database and referee tests against a PostgreSQL 16 service;
   - then, on `main` only, in the `supabase-production` environment: applies
     pending migrations with `scripts/apply-migrations.mjs` and deploys the
     `match-referee` Edge Function with the Supabase CLI.
2. **Web client:** tests, build, and the Pages deploy (plus itch.io when
   `ITCH_DEPLOY_ENABLED` is set). It runs only if the backend deployed, so a
   client never goes live before the server it needs.

Runs are never cancelled halfway. Pull requests run the backend checks only.

### Migrations

`scripts/apply-migrations.mjs` applies every `supabase/migrations/NNNN_*.sql`
the database hasn't run, in order, each in one transaction with its history
row in `seven_private.schema_migrations`. On first run it records 0001–0003
as already applied (they were applied by hand, and are detected by the
objects they created), then applies 0004. Applied migrations are immutable:
editing one fails the run; add a new one instead. `supabase db push` is not
used: this project's existing migration history is maintained by the custom
runner, including migrations originally applied by hand.

Run it by hand: `SUPABASE_DB_URL=… npm run db:migrate -- --dry-run`, then
without `--dry-run`. Or start "Deploy Supabase backend" from the Actions tab
with **dry run** checked.

## One-time setup before merging the referee

The referee change needs its backend live before the new client: until the
secrets below exist, the deploy workflow stops at "Check deployment secrets"
and the site is not updated.

1. **GitHub → Settings → Secrets and variables → Actions** (or the
   `supabase-production` environment):

   | Secret | Value |
   | --- | --- |
   | `SUPABASE_DB_URL` | This project's Dashboard → **Connect** → **Session pooler** connection string, with the database password percent-encoded. GitHub runners have no IPv6, so the direct `db.<ref>.supabase.co` host does not work. Do not use Imperial Battleground's connection string. |
   | `SUPABASE_ACCESS_TOKEN` | A personal access token from Supabase **Account → Access Tokens**. |

   Restrict the `supabase-production` environment's deployment branches to
   `main`; optionally add yourself as a required reviewer.
2. **Optional dry run:** Actions → "Deploy Supabase backend" → Run workflow
   with dry run, from `main` after merging, or locally as above. It should list
   `0004_referee.sql` as pending.
3. **After the first deploy:** in the Supabase dashboard, delete the unused
   `notify-turn` function (migration 0004 already removed its webhook). The
   `seven-expire-matches`, `seven-assign-bots` and `seven-prune-push-devices`
   jobs are scheduled by the migration (pg_cron is enabled on the project).

What 0004 does to live data: every 7 Seconds match still open or active
(made under the old client-resolved protocol) ends with no winner
(`finish_reason = 'version'`); finished matches and players' push settings
are kept. Old cached web clients get "permission denied" on their next move
and recover on reload.

Ranked and Android turn alerts need their own setup: [docs/ranked.md](docs/ranked.md),
[docs/turn-alerts.md](docs/turn-alerts.md). Without it the game simply has no
Ranked button and uses local notifications on Android.

## Function secrets

Set with `supabase secrets set --project-ref puoxmqovckvfoqyihasl NAME=value`.
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase.

| Secret | Needed for |
| --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push (already set for the old `notify-turn`) |
| `FCM_SERVICE_ACCOUNT` | Android turn alerts |
| `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_WEB_CLIENT_SECRET`, `PGS_APP_ID` | Ranked |
| `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` | email alerts (optional) |
| `NOTIFY_APP_URL` | the link in alerts (default: the GitHub Pages site) |

## Rules changes

A change to battle outcomes (`src/rules-version.test.ts` fails) ships as one
change with: `RULES_VERSION` bumped and `GOLDEN` updated, the referee bundle
rebuilt (`npm run referee:bundle`), and a migration ending older matches in
play:

```sql
update public.matches set status = 'abandoned', finish_reason = 'version', finished_at = now()
  where status in ('open', 'active') and rules <> <new version>;
```

The backend deploys before the client, so between the two, old clients get
"Reload or update the app" (HTTP 426) instead of playing on mismatched rules.

## Android

`npm run cap:build` builds the signed release bundle (needs
`android/keystore.properties`). Web changes reach installed apps without a
release; native changes (the Ranked and turn-alert plugins, their
configuration) need a new build with a higher `versionCode`.
