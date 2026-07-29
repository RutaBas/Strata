# STRATA

A daily 7×7 deduction puzzle about weight, balance and inheritance.

Every board is a core sample. Solve today's, and the heaviest stones — the ones that
outweigh everything they touch — **survive**, rotate 90° clockwise, and are waiting for you
tomorrow as locked *bedrock*. Miss a day and the chain breaks; the game says so once, plainly,
and hands you a board anyway. **STRATA cannot be lost.**

Vanilla HTML/CSS/JS. No frameworks, no build step, no CDN scripts, no backend, no accounts.
Open `index.html` and it runs.

---

## The rules

1. **Four stones to a line.** Every row and every column holds exactly four stones and three
   empties.
2. **None touching its equal.** No two orthogonally adjacent stones may share a weight.
3. **The edge numbers are the sum.** Each clue is the total weight of the stones in its line.

Stones weigh 1–5. Every board has exactly one solution, and that solution is always reachable
by pure deduction — never by guessing.

## The chain

The chain is the point of the game.

- **One chain-advancing board per calendar day**, at a tier *you* pick. Any extra board the
  same day is free play: it records nothing and never touches the chain.
- **Survival is rare on purpose.** A stone survives only if it weighs **≥ 4** *and* is strictly
  heavier than every orthogonal neighbour. (Local-maximum alone let ~10.8 stones through
  against a cap of 5, which made survival read as loss.)
- **You choose one more.** After the survival animation you pick a single extra stone to carry
  forward, on the board itself, with the rotated consequence shown live before you commit.
- **Rotation.** Survivors + your seed rotate 90° clockwise into tomorrow's bedrock: pre-placed
  and weight-locked. Bedrock counts as givens, so a healthy chain visibly reduces how much
  else is revealed.
- **The cap is 5, and the youngest erodes first** — so a long-held stone keeps holding on, and
  bedrock can grow genuinely ancient. Age deepens its colour.
- **Breaking the chain** clears the bedrock and says `Chain broken at N. Starting again.` No
  red, no shake, no sound, no streak-freeze to buy. Then the board loads as normal.

The daily puzzle is **never** gated on the chain.

## Difficulty

Six tiers, ascending by hardness, graded by **which solver technique is required** — never by
clue count. A tier can never be reached by the technique set below it, which is verified at 200
puzzles per tier.

| Tier | Requires |
|---|---|
| Topsoil | sums only |
| Silt | + repulsion |
| Shale | + repulsion (leaned on longer) |
| Slate | + parity |
| Basalt | + parity (leaned on longer) |
| Bedrock | intersection |

"Bedrock" is deliberately both the hardest tier and the name for inherited stones. In UI copy
inherited stones are always **bedrock stones** (lower case, with the noun) and the tier is
always **Bedrock** (capitalised, in a tier position), so the two never collide in a sentence.

---

## How it works

**Solver-first.** The generator does not invent puzzles and hope. It builds a full legal grid,
digs cells away until exactly one solution remains, then hands the result to the solver, which
has the last word: a board that needs a guess is rejected outright, and a board the target
technique cannot crack is rejected too. Difficulty is therefore a property the solver *measured*,
not a number someone chose.

**Hints are the same solver.** `solver.nextDeduction()` returns the next cell that is actually
forced from the current board state, with the rule that forces it — *"r7c1 must be empty — col 1
cannot reach its load of 15 with a 3 at r7c1."* It never reveals a random cell and never peeks at
the stored solution.

A hint is a piece of reasoning, so it is **not on a timer**. It sits in a bar below the tools —
never over the board — and stays until the player acts on it: placing or clearing a cell, undo,
tapping the bar, or leaving the board. While it is up, the cell it names is ringed in oxide, so
the words and the board say the same thing. The bar wraps and never clips;
`node scripts/hint-worstcase.js` replays the deduction chain of a batch of boards across all six
tiers and prints the longest string the solver can emit (**107 characters**, which sets on two
lines at 390px).

**Logic and DOM are strictly separated.** `js/model.js`, `js/solver.js`, `js/generator.js` and
`js/game.js` contain no DOM at all and run headlessly under node, which is what makes the
verification harness possible. `js/ui.js` decides nothing about the rules — it asks.

**Generation is sliced.** A board takes 0.4–1.9 s to cut and Bedrock can burn several candidate
grids, so generation runs in bounded slices behind a themed *drilling…* state. Each slice
continues the same deterministic attempt sequence, so a daily board is identical however many
slices it took.

---

## Project structure

```
index.html            one page, every screen
css/style.css         the whole visual system
sw.js                 cache-first service worker (precaches every shipped file)
manifest.webmanifest  PWA manifest

js/model.js           rules, chain, survival, bedrock, rotation, erosion   ← verified core
js/solver.js          constraint propagation, techniques, grading, hints   ← verified core
js/generator.js       full grids → dug puzzles → solver-graded boards      ← verified core
js/rng.js             seeded PRNG (mulberry32) + string hashing            ← verified core
js/logic.js           thin bridge: collects the four namespaced globals

js/game.js            game state machine — no DOM, node-testable
js/ui.js              all DOM, rendering, screens, animation
js/lineage.js         the lineage view + the core-sample image export
js/tutorial.js        the field lesson — a guided run on a fixed, literal board
js/meta-ui.js         streak line, calendar, records panel, rank badge, stones
js/meta-config.js     mounts the shared meta-layer for STRATA
js/par.js             par times — one formula, deliberately forgiving
js/sound.js           Web Audio, synthesised, zero asset files
js/storage.js         namespaced localStorage (every key is `strata:`)
js/meta/              GENERATED — vendored from games/_shared/meta, never edit

scripts/make-icons.js reproducible PNG app icons (no dependencies)
scripts/contrast.js   WCAG AA audit of every numeral-on-stone pair
scripts/hint-worstcase.js  longest explanation nextDeduction can emit (layout budget)
scripts/pick-tutorial-board.js  picks the field lesson's fixed board (run once, by hand)
test/verify.js        the logic gate — 35 checks
design-brief.md       the signed-off design (palette, type, motion, ladder)
```

### The meta-layer

Progression is **not** hand-rolled: streak, calendar, personal bests and the rank badge come
from the shared library in `games/_shared/meta`, vendored into `js/meta/` by
`node games/_shared/sync.js strata` (a service worker cannot serve `../_shared/`, so the copy
is what ships). **Never edit `js/meta/` directly** — edit the shared source and re-run sync.

STRATA is a true daily game, so only the daily/records/rank parts are mounted. There is no
campaign, no level table and no unlock gating. **The chain is not the streak:** `model.js` owns
the chain, and the meta daily layer is a parallel record used for the streak line, the calendar
and the records panel. It can never gate or alter the chain.

### The field lesson

There are two pieces of teaching, and they are not the same thing. The **how-to-play card** shows
the three rules in words on the first launch and is reopenable from the menu. The **field lesson**
(`js/tutorial.js`, opened from the core log or the menu, never automatically) teaches by playing.
Fourteen steps in one arc: the three rules demonstrated on a real board (1–3), three deductions the
player makes themselves with the board refusing anything wrong in the rules' own words (4–6), the
technique ladder the six tiers actually ride on (7–11), and then the chain — the real survival
animation, the seed choice, and the quarter turn into tomorrow's bedrock (12–14).

Steps 8–11 are one technique set each, on the same board: **sums** (Topsoil) fills all of column 6
by arithmetic; **repulsion** (Silt, Shale) shows one forced stone dragging two more with it;
**parity** (Slate, Basalt) counts row 4's possible weight multisets when cells alone are stuck;
**intersection** (Bedrock) crosses row 7's arrangements against what columns 4 and 5 have ruled out.

Four properties are load-bearing:

- **The board is a literal, not a seed.** `assertBoard()` re-derives every claim the authored steps
  make — validity, both sets of clues, the survivor set, each teaching cell's value — from the logic
  core when the lesson opens, and throws rather than teaching something false.
- **The technique steps are proved, not written.** `assertDemos()` puts each one to `js/solver.js` at
  load: with the set *below* the named technique the cell must stay unresolved, and with the named
  technique it must be forced to its true value. The candidate sets the copy quotes out loud ("a 1 or
  a 3") are asserted against the solver's domains too. If the ladder ever shifts, the lesson refuses
  to open. The tier promise it states is the one the gate actually proves: a board **cannot be solved
  by the technique set below its tier** — nothing more.
- **It records nothing a player earned.** No chain, record, streak, stats or history movement. The
  one key it writes is `strata:lesson`, set when the player reaches the end **or** uses Leave lesson;
  closing the tab mid-run writes nothing, so an interrupted first run is still a first run. On a
  later run every interactive step is advanceable with Next without touching the board — the answer
  settles on the board first, so it stays a demonstration — and Next is visibly never disabled.
- **Leaving is possible from every step.** `Leave lesson` sits in a sticky head, ≥44px, on all
  fourteen steps including the chain. It kills every pending timer and animation class, and the next
  open starts clean at step 1.

It borrows the board, the keypad, the survival sequence and both mini boards from `js/ui.js`, so it
is the game teaching itself rather than a slideshow drawn alongside it.

### Sound

Web Audio, synthesised at runtime — no asset files ever ship. The set is *Stoneware* (fired clay
tapped with a knuckle, minor pentatonic) with one swap: the crumble comes from *Graphite*'s dry
noise cascade, because a stone crumbling should sound like material failing, not like a note
being played. Sound and haptics are both toggleable and default on.

---

## Running the tests

```bash
node test/verify.js                      # the logic gate — must be 35/35
node games/_shared/meta/test/verify.js    # the shared meta-layer gate
node scripts/contrast.js                 # WCAG AA, exits non-zero on any failure
node scripts/make-icons.js               # regenerate the app icons
```

`test/verify.js` takes ~5 minutes: it generates hundreds of boards, cross-checks two independent
survival implementations against each other, asserts `rotate90` applied four times is the
identity, and simulates 60 consecutive days of chain to prove ages only ever increment by one or
reset to one.

## Deploying

Everything is static — copy the folder to any static host (GitHub Pages, Netlify, a plain
directory on a server). No build step.

```bash
node games/_shared/sync.js strata   # refresh js/meta/ before you ship
```

If you change any shipped file, bump `CACHE_VERSION` in `sw.js`, or returning players will keep
the old cache.

The service worker only registers over `http(s)`, so opening `index.html` from the filesystem
still works — it just plays without offline caching.

## Installing on an iPhone

1. Serve the folder over HTTPS (a service worker will not install from `file://`).
2. Open the URL in **Safari** — not Chrome; only Safari can add to the Home Screen on iOS.
3. Tap **Share → Add to Home Screen**.
4. Launch it from the Home Screen. It runs standalone with no browser chrome, respects the
   notch and home bar, and works with no network at all — including cutting a brand new board,
   because every puzzle is generated on the device.

---

## Accessibility

Every numeral-on-stone pair clears **WCAG AA 4.5:1** in both light and dark themes, checked by
`scripts/contrast.js` in CI-friendly form (it exits non-zero on failure). Weight is encoded by
the numeral first and colour second — the light→dark ramp is a *second* channel, never the only
one. Every tap target is ≥ 44 px, nothing depends on hover, and `prefers-reduced-motion` is
respected.
