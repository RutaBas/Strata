"use strict";
/* One IIFE per logic file — see the note in model.js. */
(function (root) {

/* STRATA — puzzle generation, gated by the solver.

   The order of operations here is not negotiable: a candidate board is only a
   puzzle once solve() says it has exactly one solution and grade() says that
   solution is reachable by pure deduction at the requested tier. Nothing in
   this file hand-tunes a board to fit a tier; the solver is the arbiter and
   anything it will not certify is thrown away.

     1. random full grid (density + repulsion), bedrock cells pinned
     2. bedrock feasibility fallback — erode the YOUNGEST stone and retry
     3. clues = row/col sums of that grid
     4. dig until unique (clues alone are usually not enough)
     5. prune givens back down while uniqueness and tier both hold
     6. grade; accept only on an exact tier match, else next seed
*/

/* Node: require them. Browser: each dependency published a namespaced global. */
const isNode = typeof module !== "undefined" && module.exports;
const M = isNode ? require("./model.js") : root.StrataModel;
const solver = isNode ? require("./solver.js") : root.StrataSolver;
const { mulberry32, hashString, shuffle } = isNode ? require("./rng.js") : root.StrataRng;

const N = M.N;
const CELLS = M.CELLS;
const STONES = M.STONES_PER_LINE;
const MAXW = M.MAX_WEIGHT;
const UNKNOWN = M.UNKNOWN;

// ------------------------------------------------------- step 1: full grids

/* Occupancy first, weights second.

   The original single-pass search chose weight-or-empty per cell in row-major
   order with a "stones first" tie-break. That tie-break was not a tie-break at
   all: 0 always sorted last, so the search only ever placed an empty when every
   stone weight had failed. Since a stone almost always fits (repulsion alone
   rules out at most two of the five weights), the FIRST feasible leaf was
   always reached through the same greedy occupancy, and the seeded shuffle only
   permuted which weights landed in it. Result: one empty-cell mask, forever.
   The density rule is a deduction source, so a constant mask leaks the puzzle.

   So the occupancy pattern is now sampled as its own object — a random 7x7
   binary matrix with exactly STONES ones in every row and column, honouring the
   pins — and only then are weights 1..MAXW backtracked onto the occupied cells.
   Backtracking on weights alone can never disturb the density rule, and the
   mask is drawn from the whole space instead of from one deterministic corner. */

/* Step 1a: a pin-respecting occupancy matrix, row by row.

   Per row we pick which of the free columns carry stones; the pins fix the
   rest. The forward checks are the same idea as the old pin look-ahead, just
   moved up a level: a column may never exceed STONES, may never still need
   more stones than there are rows left, and must leave room for its own pinned
   stones further down. Bedrock lands wherever the rotation put it, so without
   these the search would fill the top rows freely and only then discover the
   bottom is impossible. */
function buildOccupancy(rng, pins, cap) {
  const occ = new Int8Array(CELLS);
  const colUsed = new Int8Array(N);
  const colPinsBelowRow = []; // [r][c] = pinned stones in rows >= r, column c
  for (let r = 0; r <= N; r++) colPinsBelowRow.push(new Int8Array(N));
  if (pins) {
    for (let r = N - 1; r >= 0; r--) {
      for (let c = 0; c < N; c++) {
        colPinsBelowRow[r][c] = colPinsBelowRow[r + 1][c] + (pins[r * N + c] > 0 ? 1 : 0);
      }
    }
  }
  let nodes = 0;

  /* Every k-subset of `free`, generated in an order the rng decides. */
  function subsets(free, k) {
    const pool = free.slice();
    shuffle(pool, rng);
    const out = [];
    const cur = [];
    (function pick(start) {
      if (cur.length === k) {
        out.push(cur.slice());
        return;
      }
      for (let j = start; j < pool.length; j++) {
        cur.push(pool[j]);
        pick(j + 1);
        cur.pop();
      }
    })(0);
    shuffle(out, rng);
    return out;
  }

  function rec(r) {
    if (++nodes > cap) return false;
    if (r === N) return true;
    const forced = [];
    const free = [];
    for (let c = 0; c < N; c++) {
      const p = pins ? pins[r * N + c] : -1;
      if (p > 0) forced.push(c);
      else if (p === 0) continue; // pinned empty
      else free.push(c);
    }
    const k = STONES - forced.length;
    if (k < 0 || k > free.length) return false;

    for (const combo of subsets(free, k)) {
      const chosen = forced.concat(combo);
      let ok = true;
      for (const c of chosen) {
        if (colUsed[c] + 1 > STONES) { ok = false; break; }
      }
      if (ok) {
        const rowsLeft = N - r - 1;
        for (let c = 0; c < N; c++) {
          const used = colUsed[c] + (chosen.indexOf(c) >= 0 ? 1 : 0);
          // still reachable, still not overfull, and its own pins still fit
          if (STONES - used > rowsLeft) { ok = false; break; }
          if (used + colPinsBelowRow[r + 1][c] > STONES) { ok = false; break; }
        }
      }
      if (!ok) continue;

      for (const c of chosen) { occ[r * N + c] = 1; colUsed[c]++; }
      if (rec(r + 1)) return true;
      for (const c of chosen) { occ[r * N + c] = 0; colUsed[c]--; }
      if (nodes > cap) return false;
    }
    return false;
  }

  return rec(0) ? occ : null;
}

/* Step 1b: mix the occupancy with 2x2 switches.

   A switch flips a [[1,0],[0,1]] rectangle to [[0,1],[1,0]]. It preserves every
   row and column count exactly, which is why it is safe here, and the switch
   chain is the standard way to move around the space of 0/1 matrices with fixed
   margins. Pinned cells are never touched, so bedrock survives untouched. */
function mixOccupancy(occ, pins, rng, steps) {
  const free = (i) => !pins || pins[i] < 0;
  for (let s = 0; s < steps; s++) {
    const r1 = (rng() * N) | 0, r2 = (rng() * N) | 0;
    const c1 = (rng() * N) | 0, c2 = (rng() * N) | 0;
    if (r1 === r2 || c1 === c2) continue;
    const a = r1 * N + c1, b = r1 * N + c2, d = r2 * N + c1, e = r2 * N + c2;
    if (!(free(a) && free(b) && free(d) && free(e))) continue;
    if (occ[a] === 1 && occ[b] === 0 && occ[d] === 0 && occ[e] === 1) {
      occ[a] = 0; occ[b] = 1; occ[d] = 1; occ[e] = 0;
    } else if (occ[a] === 0 && occ[b] === 1 && occ[d] === 1 && occ[e] === 0) {
      occ[a] = 1; occ[b] = 0; occ[d] = 0; occ[e] = 1;
    }
  }
  return occ;
}

/* Step 1c: weights onto a fixed occupancy.

   Row-major backtracking over the occupied cells only. The density rule is
   already satisfied by `occ` and cannot be broken here; all that is left is
   repulsion (no orthogonal neighbour repeats a weight) and the pinned bedrock
   values. The pin look-ahead is kept: a pinned neighbour ahead of us forbids
   its own weight at this cell, which prunes doomed branches early. */
function fillWeights(rng, occ, pins, budget) {
  const g = new Int8Array(CELLS);
  let nodes = 0;
  const cap = budget || 200000;

  function rec(i) {
    if (++nodes > cap) return false;
    if (i === CELLS) return true;
    if (!occ[i]) { g[i] = 0; return rec(i + 1); }
    const r = (i / N) | 0;
    const c = i % N;
    const pin = pins ? pins[i] : -1;

    const order = [];
    for (let v = M.MIN_WEIGHT; v <= MAXW; v++) order.push(v);
    shuffle(order, rng);

    for (const v of order) {
      if (pin > 0 && v !== pin) continue;
      if (c > 0 && g[i - 1] === v) continue;
      if (r > 0 && g[i - N] === v) continue;
      if (pins) {
        if (c + 1 < N && pins[i + 1] === v) continue;
        if (r + 1 < N && pins[i + N] === v) continue;
      }
      g[i] = v;
      if (rec(i + 1)) return true;
      g[i] = 0;
      if (nodes > cap) return false;
    }
    return false;
  }

  return rec(0) ? g : null;
}

/* One full grid attempt: sample an occupancy, then weight it. `pins` is an
   Int8Array(49) of -1 or a locked value. Returns null if either stage runs out
   of budget — the caller restarts with fresh randomness rather than grinding. */
function fillGrid(rng, pins, budget) {
  const cap = budget || 200000;
  for (let t = 0; t < 12; t++) {
    const occ = buildOccupancy(rng, pins, 4000);
    if (!occ) return null; // no occupancy exists for these pins at all
    mixOccupancy(occ, pins, rng, 400);
    const g = fillWeights(rng, occ, pins, cap);
    if (g) return g;
  }
  return null;
}

/* Cheap necessary conditions on a pin set. Rotation can drop two equal-weight
   survivors next to each other, which no grid can ever satisfy — catching that
   here saves an exhaustive search that was only ever going to fail. */
function pinsViable(pins) {
  if (!pins) return true;
  const rowN = new Int8Array(N);
  const colN = new Int8Array(N);
  for (let i = 0; i < CELLS; i++) {
    const v = pins[i];
    if (v < 0) continue;
    if (v > 0) {
      rowN[(i / N) | 0]++;
      colN[i % N]++;
      for (const j of M.neighbors(i)) if (pins[j] === v) return false;
    }
  }
  for (let k = 0; k < N; k++) if (rowN[k] > STONES || colN[k] > STONES) return false;
  return true;
}

/* A random valid STRATA grid: exported so the harness can sample raw grids. */
function generateFullGrid(rng, pins) {
  if (!pinsViable(pins)) return null;
  const budget = pins ? 20000 : 60000;
  const tries = pins ? 8 : 40;
  for (let attempt = 0; attempt < tries; attempt++) {
    const g = fillGrid(rng, pins || null, budget);
    if (g && M.isValidGrid(g)) return g;
  }
  return null;
}

function pinsFromBedrock(bedrock) {
  const pins = new Int8Array(CELLS).fill(-1);
  for (const b of bedrock || []) pins[M.idx(b.r, b.c)] = b.w;
  return pins;
}

function cluesOf(grid) {
  const s = M.lineSums(grid);
  return { rows: s.rows.slice(), cols: s.cols.slice() };
}

// ------------------------------------------------------------- tier gating

/* Two tiers can share a technique (silt/shale, slate/basalt). The technique is
   still the difficulty axis — within one technique the harder twin is the one
   that leans on it longer, measured by how many rounds of the fixpoint loop
   the weaker techniques alone fail to finish. `minRounds` is a secondary
   filter only; it can never promote a board across a technique boundary. */
const TIER_RULES = {
  topsoil: { technique: "sums", minRounds: 0 },
  silt: { technique: "repulsion", minRounds: 0 },
  shale: { technique: "repulsion", minRounds: 12 },
  slate: { technique: "parity", minRounds: 0 },
  basalt: { technique: "parity", minRounds: 14 },
  bedrock: { technique: "intersection", minRounds: 0 },
};

function tierAccepts(tierKey, graded) {
  const rule = TIER_RULES[tierKey];
  if (!rule || !graded || graded.technique !== rule.technique) return false;
  if ((graded.rounds || 0) < rule.minRounds) return false;
  // the easier twin must NOT be hard enough for the harder twin
  if (tierKey === "silt" && graded.rounds >= TIER_RULES.shale.minRounds) return false;
  if (tierKey === "slate" && graded.rounds >= TIER_RULES.basalt.minRounds) return false;
  return true;
}

/* At-or-above the target, used by the pruner: pruning may only make a board
   harder, never easier than what was asked for. */
function tierRank(technique) {
  return M.TECHNIQUES.indexOf(technique);
}

// --------------------------------------------------- steps 4-5: dig & prune

function makePuzzle(clues, givens) {
  return { clues, givens: Int8Array.from(givens) };
}

/* Cheap information heuristic: prefer cells the current propagation is least
   sure about, so a reveal buys the most. Ties broken by the seeded order. */
function digOrder(rng, clues, givens, solution) {
  const res = solver.deduce({ clues, givens }, { techniques: M.TECHNIQUES });
  const open = [];
  for (let i = 0; i < CELLS; i++) {
    if (givens[i] !== UNKNOWN) continue;
    const d = res.domains[i];
    let pop = 0;
    for (let v = 0; v <= MAXW; v++) if (d & (1 << v)) pop++;
    open.push({ i, pop, k: rng() });
  }
  open.sort((a, b) => b.pop - a.pop || a.k - b.k);
  return open.map((o) => o.i);
}

/* Reveal one more cell at a time until solve() reports exactly one solution.
   Returns {givens, extra} or null if even the full solution is not unique
   (which would mean the clues themselves are inconsistent — impossible, but
   the loop refuses to pretend). */
function digUntilUnique(rng, clues, baseGivens, solution) {
  const givens = Int8Array.from(baseGivens);
  let extra = 0;
  for (let guard = 0; guard <= CELLS; guard++) {
    const res = solver.solve(makePuzzle(clues, givens), { maxSolutions: 2 });
    if (res.status === "unique") return { givens, extra };
    if (res.status === "none") return null;
    const order = digOrder(rng, clues, givens, solution);
    if (!order.length) return null;
    givens[order[0]] = solution[order[0]];
    extra++;
  }
  return null;
}

/* Try to take each revealed given back out. Keep it out only if the board is
   still uniquely solvable AND still grades at the target tier's technique.

   Removing a given can only ever make a board harder, so the lower bound is
   what the tier demands and the upper bound is what stops an easy tier from
   quietly turning into a hard one. Both bounds are read off solver.grade();
   the puzzle itself is never adjusted to fit. */
function pruneGivens(rng, clues, givens, tierKey, pinned) {
  const rule = TIER_RULES[tierKey];
  const target = tierRank(rule.technique);
  const ceiling = target;
  const order = [];
  for (let i = 0; i < CELLS; i++) if (givens[i] !== UNKNOWN && !pinned.has(i)) order.push(i);
  shuffle(order, rng);

  const out = Int8Array.from(givens);
  for (const i of order) {
    const keep = out[i];
    out[i] = UNKNOWN;
    const p = makePuzzle(clues, out);
    const res = solver.solve(p, { maxSolutions: 2 });
    let ok = res.status === "unique";
    if (ok) {
      const g = solver.grade(p);
      const rank = g.technique === null ? -1 : tierRank(g.technique);
      ok = rank >= target && rank <= ceiling;
    }
    if (!ok) out[i] = keep;
  }
  return out;
}

// ------------------------------------------------------------------ public

function dailySeed(dateKey, tierKey) {
  return hashString(`strata|${dateKey}|${tierKey || ""}`);
}

/* generate({tier, seed, bedrock, maxAttempts})
     -> {puzzle, solution, tier, givenCount, erosions, bedrock, attempts, seed}
   or {puzzle:null, ...} if the attempt budget ran out. Never throws. */
function generate(opts) {
  const o = opts || {};
  const tierKey = o.tier || "topsoil";
  if (!TIER_RULES[tierKey]) return { puzzle: null, reason: `unknown tier ${tierKey}`, erosions: 0, bedrock: o.bedrock || [] };
  const baseSeed = o.seed === undefined ? 1 : o.seed >>> 0;
  const maxAttempts = o.maxAttempts || 400;
  const gridTries = o.gridTriesPerBedrock || 6;

  let bedrock = (o.bedrock || []).map((b) => ({ ...b }));
  let erosions = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rng = mulberry32((baseSeed + attempt * 0x9e3779b1) >>> 0);

    // 1+2: a full grid honouring the bedrock pins, eroding the youngest stone
    // if this bedrock configuration admits no valid completion at all.
    let grid = null;
    for (let t = 0; t < gridTries; t++) {
      grid = generateFullGrid(rng, pinsFromBedrock(bedrock));
      if (grid) break;
    }
    if (!grid) {
      if (bedrock.length) {
        const er = M.erodeYoungest(bedrock);
        bedrock = er.bedrock;
        if (er.eroded) erosions++;
      }
      continue;
    }
    if (!M.bedrockFits(grid, bedrock)) continue;

    // 3: clues
    const clues = cluesOf(grid);

    // bedrock cells are permanent givens and never prunable
    const pinned = new Set(bedrock.map((b) => M.idx(b.r, b.c)));
    const base = new Int8Array(CELLS).fill(UNKNOWN);
    for (const b of bedrock) base[M.idx(b.r, b.c)] = b.w;

    // 4: dig until unique
    const dug = digUntilUnique(rng, clues, base, grid);
    if (!dug) continue;

    // 4b: an easy tier needs MORE than uniqueness — it needs the weak
    // techniques to be enough. Keep revealing until grade() itself says the
    // board is within reach of the target technique (or give up on this grid).
    const target = tierRank(TIER_RULES[tierKey].technique);
    let softened = true;
    for (let extra = 0; extra < CELLS; extra++) {
      const gd = solver.grade(makePuzzle(clues, dug.givens));
      const rank = gd.technique === null ? 99 : tierRank(gd.technique);
      if (rank <= target) break;
      const order = digOrder(rng, clues, dug.givens, grid);
      if (!order.length) {
        softened = false;
        break;
      }
      dug.givens[order[0]] = grid[order[0]];
      dug.extra++;
    }
    if (!softened) continue;

    // 5: prune
    const givens = pruneGivens(rng, clues, dug.givens, tierKey, pinned);
    const puzzle = makePuzzle(clues, givens);

    // 6: the solver has the last word
    const res = solver.solve(puzzle, { maxSolutions: 2 });
    if (res.status !== "unique" || !M.gridsEqual(res.solution, grid)) continue;
    const graded = solver.grade(puzzle);
    if (!graded.technique) continue; // needs a guess — reject outright
    if (!tierAccepts(tierKey, graded)) continue;

    let givenCount = 0;
    for (let i = 0; i < CELLS; i++) if (givens[i] !== UNKNOWN) givenCount++;

    return {
      puzzle,
      solution: grid,
      tier: tierKey,
      technique: graded.technique,
      rounds: graded.rounds,
      givenCount,
      extraGivens: dug.extra,
      erosions,
      bedrock,
      attempts: attempt + 1,
      seed: baseSeed,
    };
  }

  return { puzzle: null, reason: "attempt budget exhausted", tier: tierKey, erosions, bedrock, attempts: maxAttempts, seed: baseSeed };
}

const API = {
  generate,
  generateFullGrid,
  dailySeed,
  cluesOf,
  digUntilUnique,
  pruneGivens,
  tierAccepts,
  TIER_RULES,
};

root.StrataGenerator = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
