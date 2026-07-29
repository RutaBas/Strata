# STRATA — design brief

Status: **round 2 of the design gate — direction and ladder chosen, sound set outstanding.**
Nothing in `index.html`, `*.css` or `js/game.js` may be written until a direction, a
ladder, the screen previews and a sound set are all chosen. (A hook enforces this.)

Companion files: `design-moodboard.html` (round 1), `design-screens.html` and `design-sound.html`
(round 2, both live).

---

## 0. What the design has to carry

STRATA is a 7×7 daily deduction puzzle whose whole point is the **chain**: the stones that
survive today's board are rotated 90° clockwise and pre-placed into tomorrow's. Three things
follow, and the visual design lives or dies on them:

1. **Weights 1–5 must be instantly distinguishable** — the puzzle is arithmetic, so every
   stone shows its numeral, and the numeral is primary. Colour is a *second* channel (a
   light→dark mass ramp), never the only one. This is a hard accessibility floor, not a
   preference.
2. **Bedrock must read as inherited**, visibly different from a stone you placed — darker,
   mineralised, weight-locked, with colour deepening as its age grows.
3. **Boards are ~37% pre-filled** (measured: mean 17.6–19.7 givens of 49). The layout must
   not look sparse-and-empty in the mockups and then dense-and-noisy in play.

---

## Stage 1 · Concept anchor

Three candidates are on the moodboard; **one gets chosen in round 1**.

- **A · Core Sample** — "STRATA feels like pulling a drill core out of the ground and reading
  the layers." Field kit, graphite, kraft paper, a job done carefully.
- **B · Lamplight** — "STRATA feels like working a seam by lamplight." Warm dark, wet rock,
  one small circle of light that is entirely yours.
- **C · Survey Plate** — "STRATA feels like a 19th-century geological survey plate."
  Hand-tinted lithograph, hairline rules, an engraver's patience.

Everything below must be answerable with "because it's [the anchor]".

_Chosen: **A · Core Sample.** "STRATA feels like pulling a drill core out of the ground and
reading the layers."_

## Stage 2 · Colour

Each direction carries a ground neutral (never pure white or black), a dominant used for the
heaviest stones, an accent reserved for tappable things, and one secondary for
error/hint/erosion. Full hex values with roles are on the moodboard.

The weight ramp 1→5 is a single monotonic light→dark progression in every direction, so a
heavier stone always *looks* heavier — the ramp encodes the mechanic, not just the palette.
Text on stones flips to the light ink at weights 4–5 to hold contrast.

Hard requirement: every numeral/background pair must clear **WCAG AA 4.5:1**, checked with a
contrast script before the UI ships, and legible in direct sun.

_Chosen — the shipping palette:_

| Token | Hex | Role |
|---|---|---|
| `--paper` | `#e6e0d4` | ground, kraft paper |
| `--panel` / `--panel-2` | `#d9d2c3` / `#cfc6b4` | raised surfaces, empty cells |
| `--ink` / `--dim` | `#241f19` / `#6b6154` | text, secondary text |
| `--accent` / `--accent-dark` | `#b4522a` / `#8e3f20` | oxide — tappable things, bedrock ring |
| `--moss` | `#4f6b5e` | satisfied clue, survivor ring |
| `--w1 … --w5` | `#d6c9a8` `#c2ab7d` `#9d8358` `#6b563a` `#3d3226` | the weight ramp, light → heavy |

Numeral ink flips to `#f2ece0` on weights 4–5.

## Stage 3 · Typography

One display face plus one text face per direction, both from Google Fonts, never the system
sans default. Numerals get a monospaced face in every direction — the board is a grid of
digits and tabular figures stop it shimmering.

- A · IBM Plex Mono + IBM Plex Sans (technical, surveyed)
- B · Newsreader + Inter, JetBrains Mono numerals (warm, human)
- C · Spectral + JetBrains Mono numerals (printed, patient)

_Chosen: **IBM Plex Mono** (display, numerals, all board digits — tabular figures) +
**IBM Plex Sans** (body). Technical and surveyed, because it's a core sample._

## Stage 4 · Spacing & depth

- Scale: **4 / 8 / 16 / 24 / 32**, nothing off-scale.
- Tap targets **≥ 44px**. At 390px wide, a 7×7 board plus a 22px clue gutter gives ~46px
  cells — the board is exactly as big as the phone allows and the chrome gets what's left.
- **One material**, applied everywhere: A = debossed paper, B = soft glow over dark,
  C = flat print with hairline rules.
- Every tappable thing has a pressed state; no interaction anywhere depends on hover.

## Stage 5 · Motion language

One personality per direction (A snappy/dry ~120ms · B smooth/heavy ~220ms · C precise/almost
none ~90ms), with one shared easing curve. Touchpoints: tap-to-place, weight cycling, an
invalid placement, screen transitions, the win, and the survival sequence.

The survival sequence is the signature moment and gets the most time: survivors pulse and
darken to mineral, everything else washes away, the board rotates 90° clockwise, and the
survivors settle as tomorrow's bedrock. It must be legible enough that a player learns the
chain rule by watching it once.

## Stage 6 · Feedback & juice

Proportional, so the win still means something:

| Moment | Feedback |
|---|---|
| Stone placed | Soft tick, 60ms cell press, light haptic |
| Line completed (count + load both satisfied) | The clue numeral settles/dims — the quiet "yes, that line is done" |
| Invalid placement (breaks repulsion or over-fills a line) | Short low tone, 1-cell shake, no colour-only signal |
| Board solved | Full celebration — particles, sound, haptic, then the survival sequence |
| A stone crumbles (erosion / cap) | Dry crumble, dust fall, no punishment framing |
| Chain broken | **No** negative juice at all. Plain sentence, plain type: "Chain broken at N. Starting again." Then the board loads as normal. |

Sounds are synthesised with the Web Audio API (no asset files); Ruta picks the set in round 2.
Haptics via `navigator.vibrate()`, off-switchable, as is sound.

## Stage 7 · Screens & layout

- **Start screen** — title, the current chain length, six ladder tiers as ≥44px buttons in
  ascending order, and Continue when a save exists. All above the fold at 390px, on a
  **unique anchor-derived background** (not a flat fill): A = a scrolling core-log column,
  B = lamplight falling across rock, C = a printed cross-section plate. Round 2 shows this.
- **In-game HUD** — board dominant. Only the timer, move count, undo and hint are on screen;
  everything else recedes.
- **Win screen** — the payoff, gets the most polish: time, moves, tier, chain length, then the
  survival animation and the **seed choice** (pick one extra stone to carry forward). The seed
  choice is a deliberate act on the board itself, not a dialog to dismiss.
- **Chain-break screen** — STRATA cannot be lost, so there is no fail screen. The nearest
  thing is the chain break, and it is deliberately undramatic.
- **Lineage view** (unlocks at day 7) — a vertical core sample of every completed board, most
  recent on top, survivors coloured by age until old stones read as nearly black; chain breaks
  render as a horizontal fault line. Exports as an **image**, not an emoji grid.

## Stage 8 · App-store-level extras

Real app icon and theme/splash colour in the manifest; safe-area insets for notch and home
bar; pull-to-refresh and text-selection disabled on the board; offline play via a cache-first
service worker; a short first-launch "how to play" that returning players never see again.

---

## Difficulty ladder

Graded by **which solver technique is required**, verified at 200 puzzles/tier — a tier can
never be reached by the technique set below it. Six tiers, three naming ladders on the
moodboard (Hardness / Depth / Core log).

_Chosen: **Hardness** — Topsoil → Silt → Shale → Slate → Basalt → Bedrock._
Note the deliberate double meaning: "Bedrock" is both the hardest tier and the name for
inherited stones. In UI copy, inherited stones are always called **bedrock stones** (lower
case, with the noun) and the tier is always **Bedrock** (capitalised, in a tier position), so
the two never collide in a sentence.

## Round 2 — delivered

`design-screens.html` — five phone frames at 390×844: home with its real core-sample
background, in-play HUD, win + survival, seed choice, chain break. The home background is a
drill core seen head on: uneven sediment bands with a turbulence grain overlay and a paper
veil that keeps text contrast intact.

`design-sound.html` — three Web Audio sets, tap to compare, covering place / line-complete /
invalid / crumble / win, plus a no-sound option:
1 · **Graphite** — noise-led, pencil-and-clipboard, driest.
2 · **Stoneware** — pitched clay knocks, minor pentatonic, most game-like.
3 · **Quarry** — low resonant stone, long tails, heaviest.

_Chosen sound set: **Stoneware**, with one swap — the **crumble/erosion sound comes from
Graphite** (the dry noise cascade), because a stone crumbling should sound like material
failing, not like a note being played._

Status: **design gate signed off.** UI may be built.

---

## Decisions already locked (from the build so far)

- **True daily.** One chain-advancing board per calendar day; the player picks its tier. Extra
  boards are free play and never touch the chain.
- **Bedrock counts as givens**, so a healthy chain visibly reduces how much else is revealed.
- **Erosion takes the youngest stone** when the cap of 5 is exceeded, so a long-held stone
  keeps holding on and bedrock can grow genuinely ancient.
- **Survival is rare on purpose**: a stone survives only if it weighs ≥ 4 *and* is strictly
  heavier than every orthogonal neighbour. Local-maximum alone let ~10.8 stones through
  against a cap of 5, which made survival read as loss.
- The daily board is **never gated** on the chain.
