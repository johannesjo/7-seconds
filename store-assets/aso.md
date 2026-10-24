# 7 Seconds - Google Play ASO

Listing URL: https://play.google.com/store/apps/details?id=io.github.johannesjo.sevenseconds

Source of the current listing text: `../7-seconds/store-assets/store-listing.md`.
Repo: `/home/johannes/www/7-seconds` (v1.4.0, versionCode 5).

**Not one of the four products in `AGENTS.md`**, and deliberately kept out of the
marketing repo (human decision, 2026-09-22). This file belongs next to the
listing source in `7-seconds/store-assets/`. It turned up in the Play Console
export alongside Super Productivity and minded, which is the only reason it was
audited at all.

**No A/B test for this app.** At 370 listing visitors/month and 4.3% conversion,
even a 50% relative lift needs 9.3 months against Play's 6-month auto-stop.
Ship directly and measure before/after: [ab-experiments-2026-09.md](ab-experiments-2026-09.md).

## Title (<= 30 chars)

Current: `7 Seconds` (9 chars). Two thirds of the field unused, and the phrase
carries no genre keyword - a Play search for "7 seconds" is as likely to be
looking for a timer or a song.

Variants:

1. **[recommended]** `7 Seconds - Turn-Based Tactics` (30) - "turn-based tactics"
   is the genre term players actually search, and it is accurate: orders are
   planned each round, then resolved.
2. `7 Seconds: Tactics Battles` (26) - shorter, broader, weaker.
3. `7 Seconds - Tactics Strategy` (28) - "strategy" has more volume than
   "tactics" but a far larger competitive set dominated by big-budget titles.

Hard-fails check: all clean.

Not testable - store listing experiments cover graphics and descriptions only.

## Short description (<= 80 chars)

Current (76): `Local multiplayer tactics: draw paths for your units, then watch them fight.`

It leads with the mechanic, and the mechanic is the hook. Three issues - it
spends the first two words on a mode rather than the genre, it omits the
"7 seconds" hook that gives the game its name, and **it says "local multiplayer"
when online play ships** (human confirmed 2026-09-22). Calling the game local-only
turns away every visitor who wants to play someone who is not in the room.

Variants:

1. **[recommended]** `Turn-based tactics: draw paths, watch 7-second battles. Online or hotseat.` (74) - genre keyword first, keeps the draw-paths mechanic, lands the title's hook, and corrects the local-only framing.
2. `Draw paths, watch chaos. Turn-based tactics online, vs AI, or on one device.` (76) - uses the repo's own elevator pitch ("Draw paths. Watch chaos. 7 seconds.") and fronts all three ways to play. Livelier, slightly less searchable.

Hard-fails check: clean.

## Long description (<= 4000 chars)

Current copy is a clean spec sheet: modes, units, tactical depth, features. It
opens with the mechanic, which is right. What it lacks is any sense of what a
match feels like, and it front-loads "local" before the reader knows what the
game is.

Draft rewrite (1,214 chars):

```
Draw a path for each of your units. Then both sides move at once, and you have seven seconds to find out whether you were right.

7 Seconds is a turn-based tactics game with no hidden dice and no waiting. Every round you plan; every round resolves simultaneously. A path that looked clever becomes a sniper's line of fire. A flank that looked slow arrives exactly on time.

MODES
- Vs. AI - play solo against the AI
- Online - matchmake against a random opponent, or share a link and play a friend
- Hotseat - pass and play on one device
- Horde - survive 15 waves and upgrade your squad between rounds
- Capture the Flag - take the enemy flag back to your base

UNITS
- Soldier - versatile ranged fighter
- Blade - fast melee attacker with area damage
- Sniper - long range, piercing shots
- Shielder - blocks frontal attacks
- Bomber - chain explosion on death

TACTICS THAT ACTUALLY MATTER
- Flanking deals 50% bonus damage
- High ground extends your range
- Line of sight and obstacles shape every fight
- Multiple upgrade paths in Horde mode

Every battle has a replay, because the good ones are worth watching again.

No ads. No in-app purchases. No accounts, no analytics, no tracking. Free and open source.
```

Changes from the live copy and why:

- Opens on the tension (plan, then watch) instead of the instruction.
- Moves "Vs. AI" to the top of the modes list. Solo is what most installers try
  first, and leading with hotseat asks the reader to find a second player before
  they know if they like the game.
- Keeps every factual bullet verbatim from `store-assets/store-listing.md`,
  except the modes list, which now includes online play, and the closing line
  (see the two bullets below).
- **Online play added** (human confirmed 2026-09-22 that it ships in the Android
  build). Phrasing follows the repo README: matchmaking against a random
  opponent, and a shareable link for playing a friend. Check before publishing
  that both paths work in the shipped build, since a broken online mode is a
  1-star review generator.
- "No ads / no in-app purchases / free" style claims are fine in the long
  description when literally true, and they are.
- **"No data collection" dropped** (2026-09-22 editorial review). With online
  play, matches share the player's IP address peer-to-peer over WebRTC, and
  `docs/plans/2026-03-07-online-pvp-legal-requirements.md` says the Data Safety
  form must declare exactly that. A listing that says "no data collection" next
  to a Data Safety form declaring IP sharing is a suppression-grade mismatch.
  The copy now says "no accounts, no analytics, no tracking", which stays true.
  Fill the Data Safety form per that plan before publishing.
- **"MIT license" dropped** (2026-09-22 editorial review). The repo has no
  LICENSE file and `package.json` says ISC. Reverted to the live copy's
  "free and open source". Add a LICENSE file first if the name should appear.

## Screenshots, feature graphic, video

Current set, inspected live 2026-09-22:

| Slot | What it shows | Caption |
| ---: | --- | --- |
| 1 | Planning phase, cream grid, two blue paths drawn, "BLUE PLANNING" header | none |
| 2 | Capture the Flag round in progress, score header, small shapes on the grid | none |
| 3+ | Further battle and menu screens, same treatment | none |

The problem is legibility, not taste. The art is deliberately minimal - small
flat shapes on cream graph paper - and at carousel thumbnail size a person
scrolling Play sees pale rectangles with no figures, no action, and no text. A
tactics game has to sell motion and consequence in slot 1.

Proposed set (captions max ~40 chars):

| Slot | Screen | Caption |
| ---: | --- | --- |
| 1 | Planning phase with several drawn paths, zoomed in enough that units read as units | Draw a path for every unit |
| 2 | Mid-resolution frame, units crossing, one clearly flanking | Then all orders fire at once |
| 3 | The moment a sniper line connects | Seven seconds decides it |
| 4 | Horde mode upgrade screen | Survive 15 waves, upgrade your squad |
| 5 | Capture the Flag with the flag carried | Capture the Flag |
| 6 | Online match, or the share-a-link screen | Play online or pass the phone |
| 7 | Replay view | Every battle has a replay |

Existing assets in `store-assets/` cover most of this already
(`screenshot-05-horde.png`, `06-ctf.png`, `08-planning-paths.png`) and only need
captions plus tighter cropping.

Video: `store-assets/action-short-mobile.mp4` and `desktop-vid.webm` exist. A
promo video is a conversion lever for a game whose appeal is motion, and this
listing has none attached. Worth doing - upload the clip to YouTube and attach
it. The feature graphic becomes its thumbnail, so check
`store-assets/feature-graphic.png` reads well in isolation first.

## Category + tags

Confirm in Play Console which game category is set. Strategy is the honest fit;
the peer set that showed up beside this listing when fetched was board and
puzzle titles, which suggests the current categorization may be pulling the
wrong neighbors.

## Reviews + Data Safety notes

Play export: 4.67 rating, a handful of reviews, one 1-2 star review in 2026-08.
Too thin for theme analysis. Re-check after the listing change.

## Baseline (pre-change snapshot)

Captured 2026-09-22:

| Metric | Value | Source |
| --- | --- | --- |
| Title | `7 Seconds` | live listing |
| Short description | `Local multiplayer tactics: draw paths for your units, then watch them fight.` | live listing |
| Rating | 4.67 | Play export, 2026-08 |
| Listing visitors, 2026-08 | 370 | Play export |
| Listing acquisitions, 2026-08 | 16 | Play export |
| Conversion, 2026-08 | 4.3% | Play export |
| Prior three months | 399 / 31 (7.8%), 379 / 25 (6.6%), 336 / 17 (5.1%) | Play export |

Conversion has fallen every month since 2026-05 on flat visitor numbers. The
listing is the most likely place to look.

## Resolved

**Online play ships** (human confirmed 2026-09-22). The live Play listing and
`store-assets/store-listing.md` both describe the game as local-only, so both
need updating, not just the fields drafted here. That stale "local multiplayer"
framing is a plausible contributor to conversion sliding from 7.8% to 4.3% while
visitor numbers stayed flat - the listing undersells the game it is selling.

## Change log

- 2026-09-22: First pass. Title, short description, long description,
  screenshots, and baseline drafted; A/B testing ruled out on traffic grounds;
  online-play discrepancy flagged.
- 2026-09-22: Online play confirmed live by the human; short description, modes
  list, and screenshot plan updated to include it. `store-assets/store-listing.md`
  still says local-only and needs the same correction.
- 2026-09-22: Moved out of the marketing repo by human decision.
- 2026-09-22 (editorial review): Long description - unverified MIT claim and the
  no-longer-true "no data collection" line replaced; duplicate rationale bullet
  removed. Data Safety declaration for online play flagged as a pre-publish step.
