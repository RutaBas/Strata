"use strict";

/* Picks the FIXED board the guided tutorial is authored against.

   Run once, by hand. Its output is pasted into js/tutorial.js as a literal
   grid — the tutorial never generates, so the authored steps can never drift
   out of sync with the board underneath them.

   What it looks for, in one grid:
     · 3–5 survivors, so the survival beat has something to show but still
       reads as rare
     · a SUM cell      — the only hidden cell in its row, a stone
     · a DENSITY cell  — the only hidden cell in its row, an empty, in a row
                         whose other four cells are already stones
     · a REPULSION PAIR — two hidden stones of different weights in one row
                          where the row clue alone permits both orders and only
                          repulsion (a vertical neighbour) kills the wrong one
   All four teaching cells must sit in different rows.
*/

const path = require("path");
const M = require(path.join(__dirname, "..", "js", "model.js"));
const Rng = require(path.join(__dirname, "..", "js", "rng.js"));
const gen = require(path.join(__dirname, "..", "js", "generator.js"));

const N = M.N;

function rowVals(g, r) { const o = []; for (let c = 0; c < N; c++) o.push(g[M.idx(r, c)]); return o; }

function findSum(g, used) {
  for (let r = 0; r < N; r++) {
    if (used[r]) continue;
    for (let c = 0; c < N; c++) {
      if (g[M.idx(r, c)] >= 3) return { r, c, w: g[M.idx(r, c)] };
    }
  }
  return null;
}

function findDensity(g, used) {
  for (let r = 0; r < N; r++) {
    if (used[r]) continue;
    for (let c = 0; c < N; c++) if (g[M.idx(r, c)] === 0) return { r, c };
  }
  return null;
}

/* Two hidden stones in one row, different weights, where putting the wrong one
   at the other cell touches a vertical neighbour of the same weight — so the
   row's arithmetic alone is not enough and repulsion decides it. */
function findRepulsion(g, used) {
  for (let r = 0; r < N; r++) {
    if (used[r]) continue;
    for (let a = 0; a < N; a++) {
      for (let b = a + 1; b < N; b++) {
        const ia = M.idx(r, a), ib = M.idx(r, b);
        const wa = g[ia], wb = g[ib];
        if (wa <= 0 || wb <= 0 || wa === wb) continue;
        // vertical neighbours only — the two cells may be side by side
        const vert = (i) => M.neighbors(i).filter((j) => M.colOf(j) === M.colOf(i));
        const clash = (i, w) => vert(i).some((j) => g[j] === w);
        // the SWAP must be killed by repulsion, and only by repulsion
        const swapDead = clash(ia, wb) || clash(ib, wa);
        if (!swapDead) continue;
        // and the swap must otherwise be legal on the row: same sum by
        // construction, and neither cell may be horizontally adjacent to a
        // stone of the value it would take
        const horiz = (i) => M.neighbors(i).filter((j) => M.rowOf(j) === M.rowOf(i) && j !== ia && j !== ib);
        if (horiz(ia).some((j) => g[j] === wb)) continue;
        if (horiz(ib).some((j) => g[j] === wa)) continue;
        if (b === a + 1 && wa === wb) continue;
        return { r, a, b, wa, wb };
      }
    }
  }
  return null;
}

/* A grid whose empties clump into one corner is legal but reads as a diagram,
   not a board. Require every line's three empties to be broken up. */
function scattered(g) {
  const run = (vals) => {
    let best = 0, cur = 0;
    vals.forEach((v) => { cur = v === 0 ? cur + 1 : 0; if (cur > best) best = cur; });
    return best;
  };
  for (let k = 0; k < N; k++) {
    const row = [], col = [];
    for (let j = 0; j < N; j++) { row.push(g[M.idx(k, j)]); col.push(g[M.idx(j, k)]); }
    if (run(row) > 2 || run(col) > 2) return false;
  }
  return true;
}

let found = null;
for (let seed = 1; seed < 60000 && !found; seed++) {
  const rng = Rng.mulberry32(seed);
  const g = gen.generateFullGrid(rng, null);
  if (!g) continue;
  const surv = M.survivors(g);
  if (surv.length !== 3) continue;
  // (empty mask is fixed by the generator; see README note)

  const used = {};
  const rep = findRepulsion(g, used);
  if (!rep) continue;
  used[rep.r] = 1;
  const sum = findSum(g, used);
  if (!sum) continue;
  used[sum.r] = 1;
  const dens = findDensity(g, used);
  if (!dens) continue;

  found = { seed, g, surv, sum, dens, rep };
}

if (!found) { console.error("no board matched"); process.exit(1); }

const g = found.g;
const clues = gen.cluesOf(g);
console.log("seed", found.seed);
console.log("grid:");
for (let r = 0; r < N; r++) console.log("  [" + rowVals(g, r).join(",") + "],   // clue " + clues.rows[r]);
console.log("rows", JSON.stringify(clues.rows));
console.log("cols", JSON.stringify(clues.cols));
console.log("survivors", JSON.stringify(found.surv),
  found.surv.map((i) => "r" + (M.rowOf(i) + 1) + "c" + (M.colOf(i) + 1) + "=" + g[i]).join(" "));
console.log("SUM      ", JSON.stringify(found.sum));
console.log("DENSITY  ", JSON.stringify(found.dens), "row values", rowVals(g, found.dens.r).join(","));
console.log("REPULSION", JSON.stringify(found.rep), "row values", rowVals(g, found.rep.r).join(","));
console.log("valid:", M.isValidGrid(g));
