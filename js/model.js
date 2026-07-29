"use strict";
/* Each logic file is wrapped in one IIFE so that plain <script> tags do not
   collide in the shared global lexical scope (two files both declaring `const
   N` is a hard SyntaxError). Node still gets require(); the browser reads the
   namespaced global. Nothing else about this file changed. */
(function (root) {

/* STRATA — core data model.
   Pure data + rules. No DOM, no localStorage, no randomness beyond what is
   passed in. Everything here runs headlessly under node so the solver, the
   generator and the verification harness can all share one definition of
   "what a legal board is".

   THE RULES
     Board      7x7. Each cell is EMPTY (0) or a STONE of weight 1..5.
     Density    every row and every column holds exactly 4 stones, 3 empties.
     Repulsion  no two orthogonally adjacent stones share a weight.
     Load       each row/column's edge clue is the sum of its weights.

   THE CHAIN
     Survival   a stone survives if it weighs at least SURVIVAL_MIN_WEIGHT and
                is strictly greater than every orthogonally adjacent STONE.
                Repulsion makes ties impossible, so "strictly greater" is never
                ambiguous — countTies() exists to keep that honest.
     Seed       the player adds exactly one more stone by hand.
     Rotation   survivors + seed rotate 90 degrees CLOCKWISE into tomorrow's
                bedrock: pre-placed, weight-locked.
     Cap        at most 5 bedrock stones; past that the YOUNGEST erodes first,
                so a long-held stone keeps holding on (see erodeYoungest).
     Age        consecutive days a stone has survived. Colour deepens with it.
*/

const N = 7;
const CELLS = N * N;
const STONES_PER_LINE = 4;
const EMPTIES_PER_LINE = N - STONES_PER_LINE; // 3
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 5;
const BEDROCK_CAP = 5;

/* Cell values. A *grid* (solution) holds EMPTY..5. A *board* (in-progress
   puzzle) additionally holds UNKNOWN for cells the player hasn't decided. */
const EMPTY = 0;
const UNKNOWN = -1;

/* Difficulty tiers, ascending by geological hardness. `technique` is the
   weakest solver technique set that must be enabled to crack the tier —
   difficulty is graded by WHAT REASONING IS REQUIRED, never by clue count. */
const TIERS = [
  { key: "topsoil", name: "Topsoil", technique: "sums" },
  { key: "silt", name: "Silt", technique: "repulsion" },
  { key: "shale", name: "Shale", technique: "repulsion" },
  { key: "slate", name: "Slate", technique: "parity" },
  { key: "basalt", name: "Basalt", technique: "parity" },
  { key: "bedrock", name: "Bedrock", technique: "intersection" },
];

/* Technique sets, weakest first. Index order IS the grading order. */
const TECHNIQUES = ["sums", "repulsion", "parity", "intersection"];

function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || null;
}

// ---------------------------------------------------------------- geometry

function idx(r, c) {
  return r * N + c;
}
function rowOf(i) {
  return (i / N) | 0;
}
function colOf(i) {
  return i % N;
}

/* Orthogonal neighbours of cell i, as indices. */
function neighbors(i) {
  const r = rowOf(i);
  const c = colOf(i);
  const out = [];
  if (r > 0) out.push(i - N);
  if (r < N - 1) out.push(i + N);
  if (c > 0) out.push(i - 1);
  if (c < N - 1) out.push(i + 1);
  return out;
}

// ------------------------------------------------------------------- grids

function emptyGrid(fill) {
  const g = new Int8Array(CELLS);
  if (fill !== undefined && fill !== 0) g.fill(fill);
  return g;
}

function cloneGrid(g) {
  return Int8Array.from(g);
}

function gridsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* Rotate 90 degrees CLOCKWISE. Source (r,c) lands at (c, N-1-r).
   An index-order slip here would silently corrupt every chain forever, which
   is why the harness asserts rotate90 applied four times is the identity and
   twice equals rotate180. */
function rotate90(g) {
  const out = new Int8Array(CELLS);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      out[idx(c, N - 1 - r)] = g[idx(r, c)];
    }
  }
  return out;
}

/* Independent 180 implementation — deliberately NOT rotate90(rotate90(g)),
   so the harness comparison is a real cross-check and not a tautology. */
function rotate180(g) {
  const out = new Int8Array(CELLS);
  for (let i = 0; i < CELLS; i++) out[CELLS - 1 - i] = g[i];
  return out;
}

/* Rotate a single (r,c) position 90 degrees clockwise. Bedrock stones travel
   as {r,c,w,age} records rather than as a grid, so they need this. */
function rotatePoint(r, c) {
  return { r: c, c: N - 1 - r };
}

// -------------------------------------------------------------- validation

function lineSums(g) {
  const rows = new Array(N).fill(0);
  const cols = new Array(N).fill(0);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const v = g[idx(r, c)];
      if (v > 0) {
        rows[r] += v;
        cols[c] += v;
      }
    }
  }
  return { rows, cols };
}

function lineCounts(g) {
  const rows = new Array(N).fill(0);
  const cols = new Array(N).fill(0);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (g[idx(r, c)] > 0) {
        rows[r]++;
        cols[c]++;
      }
    }
  }
  return { rows, cols };
}

/* Every reason a full grid is illegal, as a list of strings. Empty list means
   the grid is a legal STRATA solution. */
function gridViolations(g) {
  const bad = [];
  for (let i = 0; i < CELLS; i++) {
    const v = g[i];
    if (v !== EMPTY && (v < MIN_WEIGHT || v > MAX_WEIGHT)) {
      bad.push(`cell ${rowOf(i)},${colOf(i)} has out-of-range value ${v}`);
    }
  }
  const counts = lineCounts(g);
  for (let k = 0; k < N; k++) {
    if (counts.rows[k] !== STONES_PER_LINE) {
      bad.push(`row ${k} holds ${counts.rows[k]} stones, expected ${STONES_PER_LINE}`);
    }
    if (counts.cols[k] !== STONES_PER_LINE) {
      bad.push(`col ${k} holds ${counts.cols[k]} stones, expected ${STONES_PER_LINE}`);
    }
  }
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const v = g[idx(r, c)];
      if (v <= 0) continue;
      if (c + 1 < N && g[idx(r, c + 1)] === v) bad.push(`repulsion broken at ${r},${c}-${r},${c + 1}`);
      if (r + 1 < N && g[idx(r + 1, c)] === v) bad.push(`repulsion broken at ${r},${c}-${r + 1},${c}`);
    }
  }
  return bad;
}

function isValidGrid(g) {
  return gridViolations(g).length === 0;
}

/* The invariant the whole survival rule rests on: no stone touches an equal
   stone, so a local maximum can never tie. Returns the count of offending
   adjacent pairs — the harness asserts this is 0 across 1,000 grids. */
function countTies(g) {
  let ties = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const v = g[idx(r, c)];
      if (v <= 0) continue;
      if (c + 1 < N && g[idx(r, c + 1)] === v) ties++;
      if (r + 1 < N && g[idx(r + 1, c)] === v) ties++;
    }
  }
  return ties;
}

// ---------------------------------------------------------------- survival

/* A stone must ALSO be at least this heavy to survive. Local-maximum alone
   let ~10.8 stones through per grid against a cap of 5, so the cap did all
   the work and survival read as loss. Requiring real mass as well means the
   five stones you carry are five you earned. */
const SURVIVAL_MIN_WEIGHT = 4;

/* Method A — neighbour scan. A stone survives when it is heavy enough AND
   strictly heavier than every adjacent stone. A heavy stone with no stone
   neighbours survives vacuously. Returns a sorted array of cell indices. */
function survivors(g) {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    const v = g[i];
    if (v < SURVIVAL_MIN_WEIGHT) continue;
    let isMax = true;
    const ns = neighbors(i);
    for (let k = 0; k < ns.length; k++) {
      const w = g[ns[k]];
      if (w > 0 && w >= v) {
        isMax = false;
        break;
      }
    }
    if (isMax) out.push(i);
  }
  return out;
}

/* Method B — elimination sweep. Start by assuming every heavy-enough stone
   survives, then knock out any stone that some neighbour matches or beats.
   Different control flow, same answer; the harness compares A and B on every
   generated grid. */
function survivorsAlt(g) {
  const alive = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) alive[i] = g[i] >= SURVIVAL_MIN_WEIGHT ? 1 : 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = idx(r, c);
      const v = g[i];
      if (v <= 0) continue;
      const pairs = [];
      if (c + 1 < N) pairs.push(idx(r, c + 1));
      if (r + 1 < N) pairs.push(idx(r + 1, c));
      for (const j of pairs) {
        const w = g[j];
        if (w <= 0) continue;
        if (w >= v) alive[i] = 0;
        if (v >= w) alive[j] = 0;
      }
    }
  }
  const out = [];
  for (let i = 0; i < CELLS; i++) if (alive[i]) out.push(i);
  return out;
}

// ----------------------------------------------------------------- bedrock

/* A bedrock stone is {r, c, w, age}. age counts consecutive days survived:
   1 the first day it becomes bedrock, incremented each day it survives again. */

function makeBedrock(r, c, w, age) {
  return { r, c, w, age: age || 1 };
}

function bedrockAt(bedrock, r, c) {
  return bedrock.find((b) => b.r === r && b.c === c) || null;
}

/* Paint a bedrock list onto a grid (used to seed the generator and to render
   pre-placed stones). Does not validate. */
function applyBedrock(g, bedrock) {
  const out = cloneGrid(g);
  for (const b of bedrock) out[idx(b.r, b.c)] = b.w;
  return out;
}

/* Is a solution grid compatible with a bedrock list? Bedrock is weight-locked,
   so every bedrock cell must hold exactly its weight. */
function bedrockFits(g, bedrock) {
  for (const b of bedrock) if (g[idx(b.r, b.c)] !== b.w) return false;
  return true;
}

/* Erode the YOUNGEST bedrock stone. The newest arrival crumbles first, so a
   stone that has held on for many days keeps holding on and bedrock can grow
   genuinely ancient. Ties break by position, so erosion is deterministic and
   reproducible. Returns {bedrock, eroded} — eroded is null when there was
   nothing to erode. */
function erodeYoungest(bedrock) {
  if (!bedrock.length) return { bedrock: [], eroded: null };
  let worst = 0;
  for (let i = 1; i < bedrock.length; i++) {
    const a = bedrock[i];
    const b = bedrock[worst];
    if (a.age < b.age || (a.age === b.age && idx(a.r, a.c) < idx(b.r, b.c))) worst = i;
  }
  const eroded = bedrock[worst];
  return { bedrock: bedrock.filter((_, i) => i !== worst), eroded };
}

/* Build tomorrow's bedrock from a solved board.

     solved      the completed grid
     seedIndex   the one extra stone the player chose to carry forward
     prevBedrock yesterday's bedrock, so ages can continue rather than reset

   Survivors + seed are aged, rotated 90 CW, then capped at BEDROCK_CAP by
   eroding the youngest. Returns {bedrock, capped} where capped lists the
   stones the cap crumbled away, so the UI can show them going. */
function nextBedrock(solved, seedIndex, prevBedrock) {
  const prev = prevBedrock || [];
  const keep = new Set(survivors(solved));
  if (seedIndex !== null && seedIndex !== undefined && solved[seedIndex] > 0) keep.add(seedIndex);

  let carried = [];
  for (const i of keep) {
    const r = rowOf(i);
    const c = colOf(i);
    const was = bedrockAt(prev, r, c);
    // A stone that was already bedrock and made it through again ages up;
    // a free stone that just became a local maximum starts at age 1.
    const age = was && was.w === solved[i] ? was.age + 1 : 1;
    const p = rotatePoint(r, c);
    carried.push(makeBedrock(p.r, p.c, solved[i], age));
  }
  carried.sort((a, b) => idx(a.r, a.c) - idx(b.r, b.c));

  const capped = [];
  while (carried.length > BEDROCK_CAP) {
    const res = erodeYoungest(carried);
    carried = res.bedrock;
    if (res.eroded) capped.push(res.eroded);
  }
  return { bedrock: carried, capped };
}

// ------------------------------------------------------------- chain state

/* Local date key, "YYYY-MM-DD". The chain runs on the player's own calendar;
   there is no server, so there is nothing to sync to. */
function dateKey(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function dayNumber(key) {
  const [y, m, d] = key.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function daysBetween(a, b) {
  return dayNumber(b) - dayNumber(a);
}

function newChain() {
  return {
    length: 0, // consecutive days solved
    longest: 0,
    lastSolvedDate: null, // date key of the most recent solved daily
    bedrock: [], // what tomorrow's board inherits
    brokenAt: null, // chain length at the last break, for the plain-spoken notice
    day: 0, // total dailies solved, ever — gates the lineage view at 7
  };
}

/* What state is the chain in when the player opens the app on `today`?
   Returns {status, chain, message}.

     "fresh"     never played
     "intact"    solved yesterday (or already solved today)
     "broken"    missed at least one day — bedrock is cleared and said plainly

   The daily puzzle itself is NEVER gated on this. A broken chain changes what
   the board inherits and what the header says; it never withholds a board. */
function chainStatus(chain, today) {
  const key = today || dateKey();
  if (!chain.lastSolvedDate) {
    return { status: "fresh", chain: { ...chain, bedrock: [] }, message: null };
  }
  const gap = daysBetween(chain.lastSolvedDate, key);
  if (gap <= 1) {
    return { status: "intact", chain, message: null };
  }
  return {
    status: "broken",
    chain: { ...chain, length: 0, bedrock: [], brokenAt: chain.length },
    message: `Chain broken at ${chain.length}. Starting again.`,
  };
}

/* Record a solved daily. Pure: returns the next chain, never mutates. */
function recordSolve(chain, solved, seedIndex, today) {
  const key = today || dateKey();
  if (chain.lastSolvedDate === key) return { chain, capped: [] }; // already counted
  const { bedrock, capped } = nextBedrock(solved, seedIndex, chain.bedrock);
  const length = chain.length + 1;
  return {
    chain: {
      ...chain,
      length,
      longest: Math.max(chain.longest, length),
      lastSolvedDate: key,
      bedrock,
      day: chain.day + 1,
    },
    capped,
  };
}

const API = {
    N,
    CELLS,
    STONES_PER_LINE,
    EMPTIES_PER_LINE,
    MIN_WEIGHT,
    MAX_WEIGHT,
    BEDROCK_CAP,
    SURVIVAL_MIN_WEIGHT,
    EMPTY,
    UNKNOWN,
    TIERS,
    TECHNIQUES,
    tierByKey,
    idx,
    rowOf,
    colOf,
    neighbors,
    emptyGrid,
    cloneGrid,
    gridsEqual,
    rotate90,
    rotate180,
    rotatePoint,
    lineSums,
    lineCounts,
    gridViolations,
    isValidGrid,
    countTies,
    survivors,
    survivorsAlt,
    makeBedrock,
    bedrockAt,
    applyBedrock,
    bedrockFits,
    erodeYoungest,
    nextBedrock,
    dateKey,
    dayNumber,
    daysBetween,
    newChain,
    chainStatus,
    recordSolve,
};

root.StrataModel = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
