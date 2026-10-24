<p align="center">
  <img src="public/icon.svg" width="128" height="128" alt="7 Seconds">
</p>

<h1 align="center">7 Seconds</h1>

<p align="center">A tactical micro-strategy game. Draw paths for your units, then watch them fight.</p>

<p align="center">
  <img src="store-assets/desktop-vid.gif" alt="Gameplay" width="600">
</p>

## How It Works

1. **Plan** — Draw movement paths for each of your units
2. **Fight** — Units follow their paths and auto-engage enemies within range
3. **Repeat** — Survive multiple rounds until one side is eliminated

Terrain matters: elevation grants range bonuses, obstacles block movement and line of sight, and flanking deals extra damage.

## Game Modes

- **vs AI** — Single player against AI opponents
- **Horde** — Survive 10 waves of increasingly difficult enemies, choosing upgrades between waves
- **Play a Stranger** — Matched with a random opponent; if nobody is searching, an AI commander takes the seat
- **Play a Friend** — Share a link and play against a friend, at your own pace
- **Ranked** (Android) — Elo ladder with Google Play Games sign-in
- **Local PvP** — Hot-seat multiplayer on the same device

## Unit Types

| Unit | Role |
|------|------|
| Soldier | Balanced all-rounder |
| Sniper | Long range, slow, fragile |
| Blade | Fast melee attacker |
| Shielder | Tanky frontline |
| Bomber | Area damage |
| Mortar | Lobs shells over cover at where enemies stand; can't hit close targets |
| Rocketeer | No gun; you draw its rocket's flight path, which launches at the end of its move |

## Screenshots

| Menu | Planning | Battle | Result |
|------|----------|--------|--------|
| ![Menu](store-assets/01-menu.png) | ![Planning](store-assets/02-planning.png) | ![Battle](store-assets/03-battle.png) | ![Result](store-assets/04-result.png) |

<details>
<summary>Night mode</summary>

| Planning | Battle |
|----------|--------|
| ![Night planning](store-assets/06-battle-night.png) | ![Night battle](store-assets/07-battle-night.png) |

</details>

## Tech Stack

- **Renderer**: [PixiJS](https://pixijs.com/) 8 (WebGL)
- **Online**: [Supabase](https://supabase.com/) (Postgres, Realtime, and the `match-referee` Edge Function that plays each round; see [docs/online-play.md](docs/online-play.md))
- **Mobile**: [Capacitor](https://capacitorjs.com/) (Android)
- **Build**: [Vite](https://vite.dev/) + TypeScript (strict)
- **Tests**: [Vitest](https://vitest.dev/)

Zero runtime CSS frameworks. Two themes (paper day mode, dark night mode) via CSS custom properties.

## Development

```bash
npm install
npm run dev        # start dev server
npm run build      # production build
npm run test:run   # run tests
npm run typecheck  # app and integration-test types
```

Online play talks to the shared Supabase project. To develop against a local
stack instead, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for
`npm run dev`. The database and referee integration tests need a PostgreSQL 16
server: `SEVEN_PG_URL=postgresql://postgres@localhost:5432/postgres npm run test:db`.
After changing the engine or the referee, run `npm run referee:bundle` and
commit `supabase/functions/match-referee/referee.mjs`. Deployment: [DEPLOYMENT.md](DEPLOYMENT.md).

## Recording

Append `?record` to the URL to enable the built-in screen recorder. Press **R** during battle or replay to capture a WebM clip (max 15 seconds).

Run `npm run video:capture` to regenerate the square and 9:16 mobile action clips in `store-assets/`. The Playwright-driven capture includes path drawing before the battle and requires `ffmpeg`/`ffprobe`.
