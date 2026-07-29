"use strict";
/* One IIFE per logic file — see the note in model.js. */
(function (root) {

/* STRATA — deduction engine.

   Pure logic. No DOM, no randomness, no I/O. The same file powers the hint
   button, the auto-solver, the generator's uniqueness gate and the harness's
   soundness proof, so every line in here has to be defensible.

   THE CONTRACT
     A deduction is only ever made when it can be PROVEN. Every technique
     eliminates a candidate only after showing that candidate cannot appear in
     ANY completion consistent with the constraints the technique looks at.
     When a technique is unsure it eliminates nothing. Nothing in here ever
     reasons from "the puzzle is supposed to have one solution" — that would
     make the generator's uniqueness gate circular.

   REPRESENTATION
     Each cell carries a 6-bit candidate mask over {0,1,2,3,4,5}, bit v = 1<<v,
     where 0 means EMPTY. A cell is "fixed" when exactly one bit remains.
     Domains live in a Uint8Array(49).

   THE TECHNIQUE LADDER (weakest first — this IS the difficulty axis)
     sums          one line at a time, counting + sum bounds only.
     repulsion     adjacency: a fixed neighbour forbids its own weight.
     parity        one line's feasible weight MULTISETS (with a matching test),
                   line-wide value elimination and exact-count forcing.
     intersection  exact per-cell support from full line enumeration, which is
                   where a row's remaining multiset and the columns it crosses
                   finally talk to each other through the shared domains.
*/

/* Node: require it. Browser: model.js published itself as a namespaced global. */
const M =
  typeof module !== "undefined" && module.exports
    ? require("./model.js")
    : root.StrataModel;

const N = M.N;
const CELLS = M.CELLS;
const STONES = M.STONES_PER_LINE; // 4
const EMPTIES = M.EMPTIES_PER_LINE; // 3
const MAXW = M.MAX_WEIGHT; // 5
const UNKNOWN = M.UNKNOWN;
const TECHNIQUES = M.TECHNIQUES;

const FULL_MASK = 0x3f; // {0,1,2,3,4,5}
const STONE_MASK = 0x3e; // {1..5}
const EMPTY_MASK = 0x01;

// ------------------------------------------------------------------ bit ops

const POP = new Uint8Array(64);
const LOW = new Int8Array(64);
for (let m = 0; m < 64; m++) {
  let p = 0;
  let low = -1;
  for (let v = 0; v <= MAXW; v++) {
    if (m & (1 << v)) {
      p++;
      if (low < 0) low = v;
    }
  }
  POP[m] = p;
  LOW[m] = low;
}

/* Sole surviving value of a mask, or -1 if the cell is not yet fixed. */
function fixedValue(mask) {
  return POP[mask] === 1 ? LOW[mask] : -1;
}

function maskValues(mask) {
  const out = [];
  for (let v = 0; v <= MAXW; v++) if (mask & (1 << v)) out.push(v);
  return out;
}

// ----------------------------------------------------------------- geometry

/* The 14 lines, as index arrays. Rows 0..6 then cols 0..6. */
const LINES = [];
for (let r = 0; r < N; r++) {
  const a = [];
  for (let c = 0; c < N; c++) a.push(M.idx(r, c));
  LINES.push({ kind: "row", n: r, cells: a });
}
for (let c = 0; c < N; c++) {
  const a = [];
  for (let r = 0; r < N; r++) a.push(M.idx(r, c));
  LINES.push({ kind: "col", n: c, cells: a });
}

const NEIGHBORS = [];
for (let i = 0; i < CELLS; i++) NEIGHBORS.push(M.neighbors(i));

function lineClue(clues, line) {
  return line.kind === "row" ? clues.rows[line.n] : clues.cols[line.n];
}

function lineLabel(line) {
  return `${line.kind} ${line.n + 1}`;
}

function cellLabel(i) {
  return `r${M.rowOf(i) + 1}c${M.colOf(i) + 1}`;
}

// ------------------------------------------------------------------ context

/* All mutable solver state travels in one context object so eliminations can
   be logged, truth-checked and contradiction-flagged from a single choke
   point. Nothing writes ctx.dom except elim(). */
function makeCtx(dom, opts) {
  return {
    dom,
    log: [],
    needLog: !!(opts && opts.needLog),
    truth: (opts && opts.truth) || null,
    violations: [],
    contradiction: false,
    hardest: -1, // index into TECHNIQUES of the strongest technique that fired
    tech: null, // technique currently running, for logging
  };
}

/* THE choke point. Remove `drop` (a bit mask) from cell i.

   Returns true if anything changed. Sets ctx.contradiction if the cell empties.
   If a ground truth grid was supplied and this elimination would remove the
   TRUE value, that is a soundness bug: it is recorded in ctx.violations and
   NOT swallowed — solve()/deduce() surface the list and checkAgainstTruth()
   reports it loudly. */
function elim(ctx, i, drop, reason) {
  const before = ctx.dom[i];
  const after = before & ~drop;
  if (after === before) return false;

  if (ctx.truth) {
    const t = ctx.truth[i];
    const bit = 1 << (t < 0 ? 0 : t);
    if (before & bit && !(after & bit)) {
      ctx.violations.push({
        cell: i,
        r: M.rowOf(i),
        c: M.colOf(i),
        removedTrueValue: t,
        technique: ctx.tech,
        reason,
      });
    }
  }

  ctx.dom[i] = after;
  if (after === 0) ctx.contradiction = true;
  const ti = TECHNIQUES.indexOf(ctx.tech);
  if (ti > ctx.hardest) ctx.hardest = ti;

  if (ctx.needLog) {
    const fv = fixedValue(after);
    ctx.log.push({
      type: fv >= 0 && fixedValue(before) < 0 ? "fix" : "eliminate",
      cell: i,
      r: M.rowOf(i),
      c: M.colOf(i),
      value: fv,
      removed: maskValues(before & drop),
      technique: ctx.tech,
      reason,
    });
  }
  return true;
}

function setCell(ctx, i, v, reason) {
  return elim(ctx, i, ctx.dom[i] & ~(1 << v), reason);
}

// ------------------------------------------------------------ line snapshot

/* What is already settled in one line: fixed stones and their sum, fixed
   empties, and the still-undecided cells. */
function scanLine(dom, line) {
  const unk = [];
  let stones = 0;
  let empties = 0;
  let sum = 0;
  for (const i of line.cells) {
    const v = fixedValue(dom[i]);
    if (v < 0) {
      unk.push(i);
      continue;
    }
    if (v === 0) empties++;
    else {
      stones++;
      sum += v;
    }
  }
  return { unk, stones, empties, sum };
}

// -------------------------------------------------------- technique: 'sums'

/* Line arithmetic alone.

   From a line's remaining sum, remaining stone count and remaining empty
   count:
     - once 4 stones are placed every other cell is EMPTY;
     - once 3 empties are placed every other cell is a STONE;
     - a candidate v for cell i survives only if, after committing v, the
       remaining stones can still reach exactly the remaining sum. The bound
       used is a relaxation (smallest/largest weights still available in the
       other cells' domains, ignoring who can be empty), so it only ever
       eliminates the provably impossible. */
function techSums(ctx, clues) {
  let changed = false;
  for (const line of LINES) {
    const s = scanLine(ctx.dom, line);
    const clue = lineClue(clues, line);
    const needStones = STONES - s.stones;
    const needEmpties = EMPTIES - s.empties;
    const remSum = clue - s.sum;
    if (needStones < 0 || needEmpties < 0 || remSum < 0) {
      ctx.contradiction = true;
      return changed;
    }
    if (needStones === 0) {
      for (const i of s.unk) {
        changed |= elim(ctx, i, STONE_MASK, `${lineLabel(line)} already holds all ${STONES} stones`);
      }
      continue;
    }
    if (needEmpties === 0) {
      for (const i of s.unk) {
        changed |= elim(ctx, i, EMPTY_MASK, `${lineLabel(line)} already holds all ${EMPTIES} empties`);
      }
    }

    // per-cell min/max stone weights still available
    const minW = new Map();
    const maxW = new Map();
    for (const j of s.unk) {
      const sm = ctx.dom[j] & STONE_MASK;
      minW.set(j, sm ? LOW[sm] : Infinity);
      let hi = -Infinity;
      for (let v = MAXW; v >= 1; v--) {
        if (sm & (1 << v)) {
          hi = v;
          break;
        }
      }
      maxW.set(j, hi);
    }

    for (const i of s.unk) {
      for (const v of maskValues(ctx.dom[i])) {
        const rs = needStones - (v > 0 ? 1 : 0);
        const re = needEmpties - (v === 0 ? 1 : 0);
        const rsum = remSum - v;
        let bad = false;
        if (rs < 0 || re < 0 || rsum < 0) bad = true;
        if (!bad) {
          const mins = [];
          const maxs = [];
          for (const j of s.unk) {
            if (j === i) continue;
            if (minW.get(j) !== Infinity) mins.push(minW.get(j));
            if (maxW.get(j) !== -Infinity) maxs.push(maxW.get(j));
          }
          if (mins.length < rs) bad = true;
          else {
            mins.sort((a, b) => a - b);
            maxs.sort((a, b) => b - a);
            let lo = 0;
            let hi = 0;
            for (let k = 0; k < rs; k++) {
              lo += mins[k];
              hi += maxs[k];
            }
            if (rsum < lo || rsum > hi) bad = true;
          }
        }
        if (bad) {
          changed |= elim(
            ctx,
            i,
            1 << v,
            `${lineLabel(line)} cannot reach its load of ${clue} with ${v === 0 ? "an empty" : "a " + v} at ${cellLabel(i)}`
          );
        }
      }
    }
    if (ctx.contradiction) return changed;
  }
  return changed;
}

// --------------------------------------------------- technique: 'repulsion'

/* Adjacency. A stone of weight w forbids w in all four orthogonal neighbours.
   Chains fall out of the fixpoint loop: each forced cell re-fires this pass
   against its own neighbours on the next round. */
function techRepulsion(ctx) {
  let changed = false;
  for (let i = 0; i < CELLS; i++) {
    const v = fixedValue(ctx.dom[i]);
    if (v <= 0) continue;
    for (const j of NEIGHBORS[i]) {
      if (ctx.dom[j] & (1 << v)) {
        changed |= elim(ctx, j, 1 << v, `repulsion: ${cellLabel(i)} already holds a ${v}`);
        if (ctx.contradiction) return changed;
      }
    }
  }
  return changed;
}

// ------------------------------------------------------ technique: 'parity'

/* Multiset counting.

   Enumerate every non-decreasing multiset of `needStones` weights from 1..5
   summing to the line's remaining load. A multiset is FEASIBLE only if its
   weights can actually be seated: an exact bipartite matching (bitmask DP over
   the undecided cells) that also leaves enough cells able to be EMPTY, and
   covers every cell that can no longer be empty.

   Two sound deductions come out of it:
     - a weight appearing in NO feasible multiset is gone from the whole line;
     - if every feasible multiset uses weight w exactly k times and only k
       undecided cells can host w, those cells are forced to w.

   No adjacency is consulted here; that is what keeps parity strictly weaker
   than 'intersection'. */
function multisets(needStones, remSum, out, start, acc) {
  if (needStones === 0) {
    if (remSum === 0) out.push(acc.slice());
    return;
  }
  for (let v = start; v <= MAXW; v++) {
    if (v * needStones > remSum) break;
    if (v + MAXW * (needStones - 1) < remSum) continue;
    acc.push(v);
    multisets(needStones - 1, remSum - v, out, v, acc);
    acc.pop();
  }
}

/* Can these weights be seated in these cells? Exact — bitmask DP over cells.
   `mustStone` marks cells whose domain no longer contains EMPTY; every one of
   them has to receive a weight. */
function seatable(weights, cells, dom, mustStone) {
  const n = cells.length;
  const k = weights.length;
  if (k > n) return false;
  let reach = new Set([0]);
  for (let w = 0; w < k; w++) {
    const next = new Set();
    const bit = 1 << weights[w];
    for (const mask of reach) {
      for (let c = 0; c < n; c++) {
        if (mask & (1 << c)) continue;
        if (!(dom[cells[c]] & bit)) continue;
        next.add(mask | (1 << c));
      }
    }
    if (!next.size) return false;
    reach = next;
  }
  for (const mask of reach) {
    let ok = true;
    for (let c = 0; c < n; c++) {
      if (mask & (1 << c)) continue;
      if (mustStone[c] || !(dom[cells[c]] & EMPTY_MASK)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function techParity(ctx, clues) {
  let changed = false;
  for (const line of LINES) {
    const s = scanLine(ctx.dom, line);
    const needStones = STONES - s.stones;
    const remSum = lineClue(clues, line) - s.sum;
    if (needStones < 0 || remSum < 0) {
      ctx.contradiction = true;
      return changed;
    }
    if (!s.unk.length) continue;

    const cells = s.unk;
    const mustStone = cells.map((i) => !(ctx.dom[i] & EMPTY_MASK));

    const cand = [];
    multisets(needStones, remSum, cand, 1, []);
    const feasible = cand.filter((ms) => seatable(ms, cells, ctx.dom, mustStone));
    if (!feasible.length) {
      ctx.contradiction = true;
      return changed;
    }

    // (a) weights nobody can use
    let usable = 0;
    for (const ms of feasible) for (const w of ms) usable |= 1 << w;
    for (const i of cells) {
      const drop = ctx.dom[i] & STONE_MASK & ~usable;
      if (drop) {
        changed |= elim(ctx, i, drop, `${lineLabel(line)}'s remaining load of ${remSum} admits no such weight`);
        if (ctx.contradiction) return changed;
      }
    }

    // (b) exact-count forcing
    for (let w = 1; w <= MAXW; w++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const ms of feasible) {
        let k = 0;
        for (const x of ms) if (x === w) k++;
        if (k < lo) lo = k;
        if (k > hi) hi = k;
      }
      if (lo !== hi || lo === 0) continue;
      const hosts = cells.filter((i) => ctx.dom[i] & (1 << w));
      if (hosts.length === lo) {
        for (const i of hosts) {
          changed |= setCell(ctx, i, w, `${lineLabel(line)} needs exactly ${lo} weight-${w} stone(s) and only ${lo} cell(s) can take one`);
          if (ctx.contradiction) return changed;
        }
      }
    }
  }
  return changed;
}

// ------------------------------------------------ technique: 'intersection'

/* Exact per-cell support from full line enumeration.

   Walk every assignment of the line consistent with the current domains, the
   stone count, the load, and in-line repulsion. A candidate that appears in no
   such assignment is impossible — remove it. Because domains are shared, a
   row's enumeration immediately constrains the seven columns it crosses and
   vice versa; that cross-talk is the whole point of this tier.

   The enumeration is bounded (7 cells, <=6 values, pruned hard by the running
   count and sum) so it is cheap enough to run every round. */
function enumerateLine(dom, cells, clue, support) {
  const n = cells.length;
  // suffix bounds for pruning
  const maxTail = new Int32Array(n + 1);
  for (let p = n - 1; p >= 0; p--) {
    const sm = dom[cells[p]] & STONE_MASK;
    let hi = 0;
    for (let v = MAXW; v >= 1; v--) {
      if (sm & (1 << v)) {
        hi = v;
        break;
      }
    }
    maxTail[p] = maxTail[p + 1] + hi;
  }

  let found = 0;
  const chosen = new Int8Array(n);

  function rec(p, stones, sum, prev) {
    if (sum > clue) return;
    if (stones > STONES) return;
    if (p - stones > EMPTIES) return;
    if (sum + maxTail[p] < clue) return;
    if (p === n) {
      if (stones !== STONES || sum !== clue) return;
      found++;
      for (let q = 0; q < n; q++) support[q] |= 1 << chosen[q];
      return;
    }
    const d = dom[cells[p]];
    for (let v = 0; v <= MAXW; v++) {
      if (!(d & (1 << v))) continue;
      if (v > 0 && v === prev) continue; // in-line repulsion
      chosen[p] = v;
      rec(p + 1, stones + (v > 0 ? 1 : 0), sum + v, v);
    }
  }
  rec(0, 0, 0, -1);
  return found;
}

function techIntersection(ctx, clues) {
  let changed = false;
  const support = new Int32Array(N);
  for (const line of LINES) {
    support.fill(0);
    const found = enumerateLine(ctx.dom, line.cells, lineClue(clues, line), support);
    if (!found) {
      ctx.contradiction = true;
      return changed;
    }
    for (let p = 0; p < line.cells.length; p++) {
      const i = line.cells[p];
      const drop = ctx.dom[i] & ~support[p];
      if (drop) {
        changed |= elim(
          ctx,
          i,
          drop,
          `no arrangement of ${lineLabel(line)} (load ${lineClue(clues, line)}) puts ${maskValues(drop).join("/")} at ${cellLabel(i)}`
        );
        if (ctx.contradiction) return changed;
      }
    }
  }
  return changed;
}

// ------------------------------------------------------------- propagation

const RUNNERS = {
  sums: (ctx, clues) => techSums(ctx, clues),
  repulsion: (ctx) => techRepulsion(ctx),
  parity: (ctx, clues) => techParity(ctx, clues),
  intersection: (ctx, clues) => techIntersection(ctx, clues),
};

function normalizeTechniques(t) {
  if (!t) return TECHNIQUES.slice();
  const set = t instanceof Set ? t : new Set(t);
  return TECHNIQUES.filter((name) => set.has(name));
}

/* Build the starting domains from the puzzle's givens. UNKNOWN(-1) means the
   cell is open; 0 asserts EMPTY; 1..5 asserts that weight (bedrock included,
   it is just a weight-locked given). */
function initialDomains(puzzle, boardState) {
  const dom = new Uint8Array(CELLS).fill(FULL_MASK);
  const g = puzzle.givens;
  for (let i = 0; i < CELLS; i++) {
    const v = g ? g[i] : UNKNOWN;
    if (v !== UNKNOWN && v !== undefined) dom[i] = 1 << v;
  }
  if (boardState) {
    for (let i = 0; i < CELLS; i++) {
      const v = boardState[i];
      if (v !== UNKNOWN && v !== undefined && v !== null) dom[i] &= 1 << v;
    }
  }
  return dom;
}

/* Run the enabled techniques, weakest first, to a fixpoint. Weak techniques
   are re-run before strong ones after any change, so the log reads as the
   easiest available reason at every step and grade() means what it says. */
function propagate(ctx, clues, techniques) {
  let rounds = 0;
  for (;;) {
    let changed = false;
    for (const name of techniques) {
      ctx.tech = name;
      const did = RUNNERS[name](ctx, clues);
      if (ctx.contradiction) {
        ctx.tech = null;
        return rounds;
      }
      if (did) {
        changed = true;
        break; // fall back to the weakest technique that still bites
      }
    }
    ctx.tech = null;
    if (!changed) return rounds;
    rounds++;
    if (rounds > 500) return rounds; // paranoia; techniques are monotone
  }
}

function domainsToGrid(dom) {
  const g = new Int8Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    const v = fixedValue(dom[i]);
    g[i] = v < 0 ? UNKNOWN : v;
  }
  return g;
}

function allFixed(dom) {
  for (let i = 0; i < CELLS; i++) if (POP[dom[i]] !== 1) return false;
  return true;
}

/* Independent final check: a candidate solution must satisfy the model's own
   rules AND the clues. The search never trusts propagation for correctness. */
function isSolution(grid, clues) {
  if (!M.isValidGrid(grid)) return false;
  const s = M.lineSums(grid);
  for (let k = 0; k < N; k++) {
    if (s.rows[k] !== clues.rows[k]) return false;
    if (s.cols[k] !== clues.cols[k]) return false;
  }
  return true;
}

// -------------------------------------------------------------- public API

/* Propagation only, no search. Returns the narrowed domains, the grid they
   imply (UNKNOWN where undetermined), the round count and the ordered log. */
function deduce(puzzle, opts) {
  const o = opts || {};
  const techniques = normalizeTechniques(o.techniques);
  const dom = initialDomains(puzzle, o.boardState);
  const ctx = makeCtx(dom, o);
  const rounds = propagate(ctx, puzzle.clues, techniques);
  return {
    domains: dom,
    grid: domainsToGrid(dom),
    solved: !ctx.contradiction && allFixed(dom),
    contradiction: ctx.contradiction,
    rounds,
    log: ctx.log,
    techniqueUsed: ctx.hardest >= 0 ? TECHNIQUES[ctx.hardest] : null,
    violations: ctx.violations,
  };
}

/* Full solve: propagate to fixpoint, then a backtracking search that stops as
   soon as maxSolutions (default 2) solutions are found. Uniqueness is exactly
   one. Propagation only prunes; every counted solution is re-validated from
   scratch by isSolution(), so a bug in a technique can cost performance or
   correctness of the COUNT only through over-pruning — which is exactly what
   checkAgainstTruth exists to catch. */
function solve(puzzle, opts) {
  const o = opts || {};
  const techniques = normalizeTechniques(o.techniques);
  const maxSolutions = o.maxSolutions === undefined ? 2 : o.maxSolutions;
  const clues = puzzle.clues;

  const root = initialDomains(puzzle, o.boardState);
  const ctx = makeCtx(root, o);
  const rounds = propagate(ctx, clues, techniques);

  const result = {
    status: "none",
    solution: null,
    count: 0,
    rounds,
    techniqueUsed: null,
    log: ctx.log,
    violations: ctx.violations,
    searched: false,
  };
  if (ctx.contradiction) {
    result.techniqueUsed = ctx.hardest >= 0 ? TECHNIQUES[ctx.hardest] : null;
    return result;
  }

  const found = [];
  let hardest = ctx.hardest;
  let searched = false;

  function branch(dom) {
    if (found.length >= maxSolutions) return;
    if (allFixed(dom)) {
      const g = domainsToGrid(dom);
      if (isSolution(g, clues)) found.push(g);
      return;
    }
    searched = true;
    // most-constrained cell first
    let best = -1;
    let bestPop = 99;
    for (let i = 0; i < CELLS; i++) {
      const p = POP[dom[i]];
      if (p > 1 && p < bestPop) {
        bestPop = p;
        best = i;
      }
    }
    for (const v of maskValues(dom[best])) {
      const next = Uint8Array.from(dom);
      next[best] = 1 << v;
      const c2 = makeCtx(next, { needLog: false, truth: null });
      propagate(c2, clues, techniques);
      if (c2.contradiction) continue;
      branch(next);
      if (found.length >= maxSolutions) return;
    }
  }

  branch(root);

  result.count = found.length;
  result.solution = found.length ? found[0] : null;
  result.status = found.length === 0 ? "none" : found.length === 1 ? "unique" : "multiple";
  result.searched = searched;
  result.techniqueUsed = hardest >= 0 ? TECHNIQUES[hardest] : null;
  return result;
}

/* The hint. Returns the single next FORCED cell, with a one-line explanation
   naming the rule that produced it — never a guess. If nothing is forced it
   says so, and the caller is expected to say "this would need a guess" rather
   than invent one. */
function nextDeduction(puzzle, boardState) {
  const decided = (i) => {
    if (boardState && boardState[i] !== UNKNOWN && boardState[i] !== undefined && boardState[i] !== null) return true;
    const g = puzzle.givens;
    return !!(g && g[i] !== UNKNOWN);
  };

  let open = 0;
  for (let i = 0; i < CELLS; i++) if (!decided(i)) open++;
  if (open === 0) {
    return { found: false, reason: "solved", technique: null, text: "Every cell is already settled." };
  }

  for (let k = 1; k <= TECHNIQUES.length; k++) {
    const techniques = TECHNIQUES.slice(0, k);
    const res = deduce(puzzle, { techniques, boardState, needLog: true });
    if (res.contradiction) {
      return { found: false, reason: "contradiction", technique: TECHNIQUES[k - 1], text: "This board state contradicts the clues." };
    }
    for (const entry of res.log) {
      if (entry.type !== "fix") continue;
      if (decided(entry.cell)) continue;
      const v = entry.value;
      return {
        found: true,
        index: entry.cell,
        r: entry.r,
        c: entry.c,
        value: v,
        technique: entry.technique,
        text: `${cellLabel(entry.cell)} must be ${v === 0 ? "empty" : "a stone of weight " + v} — ${entry.reason}.`,
      };
    }
  }
  return {
    found: false,
    reason: "guess-required",
    technique: null,
    text: "No cell is forced from here; going further would require a guess.",
  };
}

/* The weakest technique tier that finishes the puzzle by DEDUCTION ALONE.
   Returns e.g. "repulsion", or null when even the full ladder stalls (such a
   puzzle is rejected by the generator — a stall means a guess). */
function grade(puzzle, opts) {
  const o = opts || {};
  for (let k = 1; k <= TECHNIQUES.length; k++) {
    const techniques = TECHNIQUES.slice(0, k);
    const res = deduce(puzzle, { techniques, truth: o.truth, needLog: !!o.needLog });
    if (res.violations && res.violations.length) {
      return { technique: null, unsound: res.violations };
    }
    if (res.solved) {
      return { technique: TECHNIQUES[k - 1], rounds: res.rounds, deductions: res.log.length, unsound: [] };
    }
    if (res.contradiction) return { technique: null, unsound: [] };
  }
  return { technique: null, unsound: [] };
}

/* Ground-truth mode. Runs the whole ladder against a known solution and
   reports EVERY deduction that contradicted it. `ok:false` means a technique
   is unsound — that is a bug in this file, not in the puzzle, and callers are
   expected to fail loudly rather than continue. */
function checkAgainstTruth(puzzle, truthGrid, opts) {
  const o = opts || {};
  const violations = [];
  const perTier = [];
  for (let k = 1; k <= TECHNIQUES.length; k++) {
    const techniques = TECHNIQUES.slice(0, k);
    const res = deduce(puzzle, { techniques, truth: truthGrid, needLog: true });
    for (const v of res.violations) violations.push({ ...v, tier: TECHNIQUES[k - 1] });
    perTier.push({
      technique: TECHNIQUES[k - 1],
      solved: res.solved,
      rounds: res.rounds,
      deductions: res.log.length,
      contradiction: res.contradiction,
    });
  }
  // Also truth-check the search path. A puzzle with several solutions is not
  // a soundness bug (it is a weak puzzle), so only "no solution at all" or
  // "one solution that isn't the truth" counts against us here.
  let solveOk = true;
  if (o.solveToo !== false) {
    const s = solve(puzzle, { truth: truthGrid, maxSolutions: 2 });
    if (s.status === "none") solveOk = false;
    if (s.status === "unique" && !(s.solution && M.gridsEqual(s.solution, truthGrid))) solveOk = false;
    for (const v of s.violations) violations.push({ ...v, tier: "solve" });
    perTier.push({ technique: "solve", status: s.status, matchesTruth: solveOk });
  }
  return {
    ok: violations.length === 0 && solveOk,
    violations,
    perTier,
    message: violations.length
      ? `SOUNDNESS BUG: ${violations.length} deduction(s) eliminated the true value.`
      : solveOk
        ? "sound"
        : "SOUNDNESS BUG: solve() did not return the known solution uniquely.",
  };
}

const API = {
  solve,
  deduce,
  nextDeduction,
  grade,
  checkAgainstTruth,
  // exposed for the harness and the generator
  initialDomains,
  domainsToGrid,
  fixedValue,
  maskValues,
  isSolution,
  LINES,
  FULL_MASK,
  STONE_MASK,
  TECHNIQUES,
};

root.StrataSolver = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
