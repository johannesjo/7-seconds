# Night battles (experimental, vs AI only)

A map modifier that turns the full-information board into a fight over
information. Turned on with the **Night battle** toggle in the vs-AI difficulty
dialog. Off by default; never used in online play, the daily challenge,
tutorial, Horde or CTF. Night results are not counted in the vs-AI record.

## Rules (`src/night.ts`)

- **Sight**: each unit sees a short radius (soldier 140, sniper 170, mortar 110,
  blade 125, ...), extended by hills like weapon range, blocked by obstacles.
- **Team sight**: a unit may only target enemies that some living friendly unit
  sees. Snipers (range 300) and mortars (range 320) outrange their own eyes and
  need spotters.
- **Muzzle flash**: firing (bullets, shells, rockets) reveals the shooter to the
  enemy team for 1 s, wherever it is.
- Flashes fade when a round ends; the shooter shows as a ghost where it fired.
- Hits on hidden enemies (blood, kill text) still show: a blind rocket or
  shell tells you it found something.
- **Mortars** only fire at enemies their team sees.
- **Rockets** follow their drawn path as usual, so they are the one blind-fire
  weapon: aim them at last-known positions.
- **Planning** shows only enemies in sight when the round ended. Others appear
  as faded ghosts (dashed ring) at their last-known position. Round 1 shows the
  enemy deployment as ghosts.
- **Dawn**: from round 5 sight grows 15% per round so the last units can't hide
  from each other forever.

## AI cheats (prototype)

- The AI planner still scores positions with full knowledge of blue's units.
- Red chasers (zombie, shielder, bomber) home in on blue units they can't see.

Red units still only *shoot* what red can see.

## Determinism

The rules run inside the fixed-step simulation and use no randomness, so a
night battle replays identically from the same seed. With `night` unset the
engine takes exactly the old code paths (the rules-version golden is unchanged).
