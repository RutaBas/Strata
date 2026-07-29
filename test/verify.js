"use strict";

/* STRATA — adversarial correctness gate.
   node test/verify.js            (reduced batch, default 40/tier)
   STRATA_BATCH=200 node test/verify.js   (full spec batch)

   Every check prints its numbers, not just a tick. Exit code is non-zero if
   any check fails. Nothing here is allowed to "pass" by weakening an
   assertion — a red gate is a valid outcome. */

const path = require("path");
const M = require(path.join(__dirname, "..", "js", "model.js"));
const solver = require(path.join(__dirname, "..", "js", "solver.js"));
const gen = require(path.join(__dirname, "..", "js", "generator.js"));
const { mulberry32, shuffle } = require(path.join(__dirname, "..", "js", "rng.js"));

const BATCH = parseInt(process.env.STRATA_BATCH || "40", 10);
const SEED = parseInt(process.env.STRATA_SEED || "20260727", 10);
const TIERS = M.TIERS.map((t) => t.key);

let failures = 0;
const lines = [];
function log(s) {
  console.log(s);
}
function report(name, ok, detail) {
  if (!ok) failures++;
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  lines.push({ name, ok });
}
function assert(name, cond, detail) {
  report(name, !!cond, detail);
  return !!cond;
}
function ms(t0) {
  return ((Date.now() - t0) / 1000).toFixed(1) + "s";
}
function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
function f(x, d) {
  return Number(x).toFixed(d === undefined ? 2 : d);
}

// ===================================================================== CASE 1
function case1() {
  log("\n--- CASE 1: no ties / survivor agreement (1,000 random full grids) ---");
  const t0 = Date.now();
  const rng = mulberry32(SEED);
  const TARGET = 1000;
  let made = 0,
    illegal = 0,
    ties = 0,
    disagree = 0;
  const survCounts = [];
  let attempts = 0;
  while (made < TARGET && attempts < TARGET * 5) {
    attempts++;
    const g = gen.generateFullGrid(rng, null);
    if (!g) continue;
    made++;
    const v = M.gridViolations(g);
    if (v.length) illegal++;
    ties += M.countTies(g);
    const a = M.survivors(g);
    const b = M.survivorsAlt(g);
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) disagree++;
    survCounts.push(a.length);
  }
  log(`  grids generated:            ${made} (of ${TARGET} requested, ${attempts} attempts, ${ms(t0)})`);
  log(`  illegal grids:              ${illegal}   (must be 0)`);
  log(`  adjacent equal-weight pairs: ${ties}   (must be 0)`);
  log(`  survivors vs survivorsAlt disagreements: ${disagree}   (must be 0)`);
  log(`  mean survivors per grid:    ${f(mean(survCounts))}  (min ${Math.min(...survCounts)}, max ${Math.max(...survCounts)})`);
  assert("1.a all 1,000 grids legal", made === TARGET && illegal === 0, `${made} generated, ${illegal} illegal`);
  assert("1.b zero adjacent equal-weight pairs", ties === 0, `${ties} tie pairs`);
  assert("1.c survivors === survivorsAlt on every grid", disagree === 0, `${disagree} disagreements`);
  assert("1.d every grid has >=1 survivor (chain can always carry)", Math.min(...survCounts) >= 1, `min ${Math.min(...survCounts)}`);
}

// ================================================================ CASES 2,5,6,7
function case2() {
  const full = BATCH >= 200;
  log(`\n--- CASE 2/5/6/7: uniqueness, soundness, no-guess, gate-necessity (${BATCH}/tier) ---`);
  if (!full) {
    log(`  NOTE: this is a REDUCED batch (${BATCH}/tier, not the spec's 200/tier).`);
    log(`  Reason: generation costs ~0.4-1.9s per board, so 200/tier = ~1,200 boards ~= 19 min wall time.`);
    log(`  Run STRATA_BATCH=200 node test/verify.js for the full batch.`);
  }
  const t0 = Date.now();
  let nonUnique = 0,
    wrongSolution = 0,
    wrongTier = 0,
    genFail = 0;
  let soundnessViolations = 0,
    soundnessChecked = 0,
    deductionsChecked = 0;
  let needsSearch = 0,
    notDeducible = 0;
  const gateFailByTier = {};
  const perTier = {};
  case2Fingerprints = {};

  for (let ti = 0; ti < TIERS.length; ti++) {
    const tier = TIERS[ti];
    const fp = { solutions: [], givenMasks: [] };
    case2Fingerprints[tier] = fp;
    const givens = [];
    const extras = [];
    const roundsArr = [];
    gateFailByTier[tier] = 0;
    for (let k = 0; k < BATCH; k++) {
      const seed = (SEED + ti * 1000003 + k * 7919) >>> 0;
      const r = gen.generate({ tier, seed });
      if (!r.puzzle) {
        genFail++;
        continue;
      }
      givens.push(r.givenCount);
      extras.push(r.extraGivens);
      roundsArr.push(r.rounds);
      fp.solutions.push(Array.from(r.solution).join(""));
      fp.givenMasks.push(Array.from(r.puzzle.givens).map((v) => (v === M.UNKNOWN ? "." : v)).join(""));

      // --- CASE 2: independent re-solve from scratch, cap 2 solutions
      const res = solver.solve({ clues: r.puzzle.clues, givens: r.puzzle.givens }, { maxSolutions: 2 });
      if (res.status !== "unique") nonUnique++;
      else if (!M.gridsEqual(res.solution, r.solution)) wrongSolution++;

      // grade must land exactly on the requested tier
      const graded = solver.grade(r.puzzle);
      const rule = gen.TIER_RULES[tier];
      if (graded.technique !== rule.technique || !gen.tierAccepts(tier, graded)) wrongTier++;

      // --- CASE 6: deduction alone, zero backtracking
      const d = solver.deduce(r.puzzle, { techniques: M.TECHNIQUES });
      if (!d.solved || d.contradiction) notDeducible++;
      if (res.searched) needsSearch++;

      // --- CASE 7: gate necessary — the technique set BELOW this tier must fail
      const below = M.TECHNIQUES.slice(0, M.TECHNIQUES.indexOf(rule.technique));
      if (below.length) {
        const weak = solver.deduce(r.puzzle, { techniques: below });
        if (weak.solved) gateFailByTier[tier]++;
      }

      // --- CASE 5: soundness vs ground truth (sampled to keep wall time sane)
      if (k % 5 === 0) {
        const chk = solver.checkAgainstTruth(r.puzzle, r.solution);
        soundnessChecked++;
        soundnessViolations += chk.violations.length;
        for (const p of chk.perTier) deductionsChecked += p.deductions || 0;
      }
    }
    perTier[tier] = { n: givens.length, givens: mean(givens), extras: mean(extras), rounds: mean(roundsArr) };
  }

  log(`  elapsed: ${ms(t0)}`);
  log("  tier      n    mean givens   mean extra-givens (dig)   mean rounds");
  for (const tier of TIERS) {
    const p = perTier[tier];
    log(`  ${tier.padEnd(9)} ${String(p.n).padStart(3)}   ${f(p.givens).padStart(10)}   ${f(p.extras).padStart(21)}   ${f(p.rounds, 1).padStart(11)}`);
  }
  log(`  generation failures:        ${genFail}   (must be 0)`);
  log(`  non-unique puzzles:         ${nonUnique}   (must be 0)`);
  log(`  solution != ground truth:   ${wrongSolution}   (must be 0)`);
  log(`  graded to the wrong tier:   ${wrongTier}   (must be 0)`);
  log(`  soundness: ${soundnessChecked} puzzles truth-checked, ${deductionsChecked} deductions inspected, ${soundnessViolations} violations   (must be 0)`);
  log(`  needed backtracking search: ${needsSearch}   (must be 0)`);
  log(`  not solvable by deduce():   ${notDeducible}   (must be 0)`);
  for (const tier of TIERS) {
    if (gen.TIER_RULES[tier].technique === "sums") continue;
    log(`  gate-necessity ${tier.padEnd(9)}: ${gateFailByTier[tier]} board(s) solvable WITHOUT ${gen.TIER_RULES[tier].technique}   (must be 0)`);
  }

  assert("2.a every tier generated a full batch", genFail === 0, `${genFail} failures`);
  assert("2.b zero non-unique puzzles", nonUnique === 0, `${nonUnique}`);
  assert("2.c re-solve returns the generator's ground truth", wrongSolution === 0, `${wrongSolution} mismatches`);
  assert("2.d grade() returns exactly the requested tier", wrongTier === 0, `${wrongTier} mis-tiered`);
  assert("5 soundness: zero deductions contradict ground truth", soundnessViolations === 0, `${soundnessViolations} violations over ${deductionsChecked} deductions`);
  assert("6 no-guess: every puzzle finished by deduce() alone, no search", needsSearch === 0 && notDeducible === 0, `${needsSearch} searched, ${notDeducible} undeducible`);
  const gateOk = TIERS.every((t) => gen.TIER_RULES[t].technique === "sums" || gateFailByTier[t] === 0);
  assert("7 gate necessary: no tier is solvable by the technique set below it", gateOk, JSON.stringify(gateFailByTier));
}

// ===================================================================== CASE 3
function case3() {
  log("\n--- CASE 3: rotation identity ---");
  const rng = mulberry32(SEED ^ 0x5bf03635);
  let fourFail = 0,
    twiceFail = 0,
    pointFail = 0,
    probeFail = 0;

  // randomized grids
  for (let k = 0; k < 500; k++) {
    const g = new Int8Array(M.CELLS);
    for (let i = 0; i < M.CELLS; i++) g[i] = Math.floor(rng() * 6);
    const r4 = M.rotate90(M.rotate90(M.rotate90(M.rotate90(g))));
    if (!M.gridsEqual(r4, g)) fourFail++;
    if (!M.gridsEqual(M.rotate90(M.rotate90(g)), M.rotate180(g))) twiceFail++;
  }

  // asymmetric single-stone probes at all 49 cells
  for (let i = 0; i < M.CELLS; i++) {
    const g = new Int8Array(M.CELLS);
    g[i] = 3;
    const r4 = M.rotate90(M.rotate90(M.rotate90(M.rotate90(g))));
    if (!M.gridsEqual(r4, g)) probeFail++;
    if (!M.gridsEqual(M.rotate90(M.rotate90(g)), M.rotate180(g))) probeFail++;
    // rotatePoint must agree with rotate90's placement of that lone stone
    const p = M.rotatePoint(M.rowOf(i), M.colOf(i));
    const r1 = M.rotate90(g);
    if (r1[M.idx(p.r, p.c)] !== 3) pointFail++;
    let placed = 0;
    for (let j = 0; j < M.CELLS; j++) if (r1[j] > 0) placed++;
    if (placed !== 1) pointFail++;
  }

  // bedrock list round-trip through four rotations
  let listFail = 0;
  for (let k = 0; k < 200; k++) {
    let bed = [];
    const used = new Set();
    while (bed.length < 5) {
      const i = Math.floor(rng() * M.CELLS);
      if (used.has(i)) continue;
      used.add(i);
      bed.push(M.makeBedrock(M.rowOf(i), M.colOf(i), 1 + Math.floor(rng() * 5), 1 + Math.floor(rng() * 4)));
    }
    const before = JSON.stringify([...bed].sort((a, b) => M.idx(a.r, a.c) - M.idx(b.r, b.c)));
    let cur = bed;
    for (let t = 0; t < 4; t++) {
      cur = cur.map((b) => {
        const p = M.rotatePoint(b.r, b.c);
        return M.makeBedrock(p.r, p.c, b.w, b.age);
      });
    }
    const after = JSON.stringify([...cur].sort((a, b) => M.idx(a.r, a.c) - M.idx(b.r, b.c)));
    if (before !== after) listFail++;
  }

  log(`  random grids tested: 500   rotate90^4 != id: ${fourFail}   rotate90^2 != rotate180: ${twiceFail}`);
  log(`  single-stone probes: 49 cells   failures: ${probeFail}   rotatePoint disagreements: ${pointFail}`);
  log(`  bedrock lists round-tripped: 200   mismatches: ${listFail}`);
  assert("3.a rotate90 applied four times is the identity", fourFail === 0 && probeFail === 0);
  assert("3.b rotate90 twice === independent rotate180", twiceFail === 0);
  assert("3.c rotatePoint agrees with rotate90 at all 49 cells", pointFail === 0);
  assert("3.d bedrock list survives four rotations unchanged", listFail === 0);
}

// ===================================================================== CASE 4
function case4() {
  const DAYS = 60;
  log(`\n--- CASE 4: chain simulation, ${DAYS} consecutive days ---`);
  const t0 = Date.now();
  const rng = mulberry32(SEED ^ 0x1a2b3c4d);
  let chain = M.newChain();
  let nullDays = 0,
    overCap = 0,
    misfit = 0,
    ageBad = 0,
    erosionDays = 0,
    threw = 0;
  const bedrockSizes = [];
  const cappedTotal = [];
  const day0 = Date.UTC(2026, 0, 1);

  for (let d = 0; d < DAYS; d++) {
    const dt = new Date(day0 + d * 86400000);
    const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    const tier = TIERS[d % TIERS.length];
    let r = null;
    try {
      r = gen.generate({ tier, seed: (SEED + d * 2654435761) >>> 0, bedrock: chain.bedrock });
    } catch (e) {
      threw++;
      log(`  DAY ${d} THREW: ${e && e.message}`);
      continue;
    }
    if (!r || !r.puzzle) {
      nullDays++;
      log(`  DAY ${d} produced NO puzzle (tier ${tier}, bedrock ${chain.bedrock.length})`);
      continue;
    }
    if (r.erosions > 0) erosionDays++;
    // bedrock actually placed into the board must fit the solution
    if (!M.bedrockFits(r.solution, r.bedrock)) misfit++;

    // "solve" it with the ground truth, pick a seed stone
    const stones = [];
    for (let i = 0; i < M.CELLS; i++) if (r.solution[i] > 0) stones.push(i);
    const seedIndex = stones[Math.floor(rng() * stones.length)];

    const prev = r.bedrock; // what this board was actually built on (post-erosion)
    const before = { ...chain, bedrock: prev };
    const step = M.recordSolve(before, r.solution, seedIndex, key);
    const next = step.chain;

    if (next.bedrock.length > M.BEDROCK_CAP) overCap++;
    bedrockSizes.push(next.bedrock.length);
    cappedTotal.push(step.capped.length);

    // ages: each new stone is age 1, or exactly one more than a prev stone
    for (const b of next.bedrock) {
      if (b.age === 1) continue;
      const ok = prev.some((p) => p.age === b.age - 1);
      if (!ok || b.age < 1) ageBad++;
    }
    chain = next;
  }

  const erosionPct = (erosionDays / DAYS) * 100;
  log(`  elapsed: ${ms(t0)}`);
  log(`  days simulated:             ${DAYS}`);
  log(`  days with no puzzle:        ${nullDays}   (must be 0)`);
  log(`  days that threw:            ${threw}   (must be 0)`);
  log(`  bedrock over cap (${M.BEDROCK_CAP}):      ${overCap}   (must be 0)`);
  log(`  bedrock/solution misfits:   ${misfit}   (must be 0)`);
  log(`  bad age transitions:        ${ageBad}   (must be 0)`);
  log(`  mean bedrock carried:       ${f(mean(bedrockSizes))} stones (max ${Math.max(...bedrockSizes)})`);
  log(`  mean stones crumbled by cap/day: ${f(mean(cappedTotal))}`);
  log(`  EROSION-FALLBACK RATE:      ${f(erosionPct, 1)}% of boards (${erosionDays}/${DAYS})`);
  if (erosionPct > 3) {
    log(`  *** LOUD WARNING: erosion fallback fires on ${f(erosionPct, 1)}% of boards. The bedrock`);
    log(`  *** cap of ${M.BEDROCK_CAP} is too high — the generator regularly cannot honour the pins`);
    log(`  *** it was handed and has to quietly drop a stone the player earned.`);
  }
  assert("4.a every day generated a puzzle", nullDays === 0 && threw === 0);
  assert("4.b bedrock never exceeds the cap", overCap === 0);
  assert("4.c bedrock always fits the solution it was placed into", misfit === 0);
  assert("4.d ages only increment by 1 or reset to 1", ageBad === 0);
  assert("4.e chain length tracked all 60 days", chain.length === DAYS - nullDays - threw, `length ${chain.length}`);
  return erosionPct;
}

// ===================================================================== CASE 8
function case8() {
  log("\n--- CASE 8: chain break semantics ---");
  const base = { ...M.newChain(), length: 7, longest: 7, lastSolvedDate: "2026-03-10", bedrock: [M.makeBedrock(0, 0, 3, 2)], day: 7 };

  const sameDay = M.chainStatus(base, "2026-03-10");
  const nextDay = M.chainStatus(base, "2026-03-11");
  const skipped = M.chainStatus(base, "2026-03-12");
  const fresh = M.chainStatus(M.newChain(), "2026-03-12");

  log(`  same-day reopen: ${sameDay.status}, bedrock ${sameDay.chain.bedrock.length}`);
  log(`  next day:        ${nextDay.status}, bedrock ${nextDay.chain.bedrock.length}`);
  log(`  after a skip:    ${skipped.status}, bedrock ${skipped.chain.bedrock.length}, message ${JSON.stringify(skipped.message)}`);
  log(`  never played:    ${fresh.status}`);

  assert("8.a same-day reopen stays intact with bedrock", sameDay.status === "intact" && sameDay.chain.bedrock.length === 1);
  assert("8.b next day stays intact with bedrock", nextDay.status === "intact" && nextDay.chain.bedrock.length === 1);
  assert("8.c a skipped day breaks the chain", skipped.status === "broken");
  assert("8.d break clears bedrock and zeroes length", skipped.chain.bedrock.length === 0 && skipped.chain.length === 0 && skipped.chain.brokenAt === 7);
  assert("8.e break message is exact", skipped.message === "Chain broken at 7. Starting again.", JSON.stringify(skipped.message));
  assert("8.f never-played is fresh with no bedrock", fresh.status === "fresh" && fresh.chain.bedrock.length === 0);
}

// ===================================================== CASE 9: hand-crafted units
function case9() {
  log("\n--- CASE 9: hand-crafted edge cases ---");

  // (i) Survival on a hand-built grid with a deliberate plateau-free ridge.
  // Survival takes BOTH conditions: weight >= SURVIVAL_MIN_WEIGHT and strictly
  // heavier than every stone neighbour. So: a heavy local max survives; a heavy
  // stone beaten by a heavier neighbour does not; an isolated stone survives
  // only if it is heavy enough, which is what makes 5 bedrock stones hard-won.
  const g = M.emptyGrid();
  g[M.idx(3, 3)] = 5;
  g[M.idx(3, 4)] = 4; // beaten by the 5, despite being heavy enough
  g[M.idx(0, 0)] = 1; // isolated but far too light
  g[M.idx(6, 6)] = M.SURVIVAL_MIN_WEIGHT; // isolated and exactly heavy enough
  const s = M.survivors(g).slice().sort((a, b) => a - b);
  const sa = M.survivorsAlt(g).slice().sort((a, b) => a - b);
  const want = [M.idx(3, 3), M.idx(6, 6)].sort((a, b) => a - b);
  assert("9.a survival: heavy local max and heavy isolate survive; light isolate and beaten stone do not", JSON.stringify(s) === JSON.stringify(want) && JSON.stringify(sa) === JSON.stringify(want), `got ${JSON.stringify(s)} / ${JSON.stringify(sa)} want ${JSON.stringify(want)}`);
  assert("9.a2 a stone one below the survival weight never survives, however isolated", (() => {
    const h = M.emptyGrid();
    h[M.idx(2, 2)] = M.SURVIVAL_MIN_WEIGHT - 1;
    return M.survivors(h).length === 0 && M.survivorsAlt(h).length === 0;
  })());

  // (ii) A tie must be reported by BOTH survivor methods as "neither survives",
  // even though a legal grid can never contain one. This is the trickiest
  // correctness issue in STRATA: if a tie ever slipped through (bedrock pinned
  // next to an equal weight), survivors must not silently keep both.
  const t = M.emptyGrid();
  t[M.idx(2, 2)] = 4;
  t[M.idx(2, 3)] = 4;
  const ts = M.survivors(t);
  const tsa = M.survivorsAlt(t);
  assert("9.b a tied pair survives in neither implementation", ts.length === 0 && tsa.length === 0, `${JSON.stringify(ts)} / ${JSON.stringify(tsa)}`);
  assert("9.c countTies sees the planted tie", M.countTies(t) === 1, `${M.countTies(t)}`);
  assert("9.d gridViolations rejects the tied grid", M.gridViolations(t).length > 0);

  // (iii) Erosion takes the YOUNGEST stone, ties broken by position — and the
  // cap must hold when 6 stones try to carry forward.
  const bed = [M.makeBedrock(0, 0, 1, 5), M.makeBedrock(1, 1, 2, 1), M.makeBedrock(2, 2, 3, 1), M.makeBedrock(3, 3, 4, 9)];
  const er = M.erodeYoungest(bed);
  assert("9.e erodeYoungest removes the youngest, lowest-index stone", er.eroded.r === 1 && er.eroded.c === 1 && er.eroded.age === 1, JSON.stringify(er.eroded));
  assert("9.f erodeYoungest on an empty list is safe", M.erodeYoungest([]).eroded === null && M.erodeYoungest([]).bedrock.length === 0);

  // Cap enforcement through nextBedrock: build a grid with 6+ survivors.
  const rng = mulberry32(SEED ^ 99);
  let big = null;
  for (let k = 0; k < 400 && !big; k++) {
    const cand = gen.generateFullGrid(rng, null);
    if (cand && M.survivors(cand).length >= 6) big = cand;
  }
  if (!big) {
    report("9.g cap enforced when >5 stones carry forward", false, "could not find a grid with >=6 survivors");
  } else {
    const nb = M.nextBedrock(big, M.survivors(big)[0], []);
    assert("9.g cap enforced when >5 stones carry forward", nb.bedrock.length === M.BEDROCK_CAP && nb.capped.length === M.survivors(big).length - M.BEDROCK_CAP, `${nb.bedrock.length} kept, ${nb.capped.length} crumbled from ${M.survivors(big).length} survivors`);
  }

  // (iv) recordSolve is idempotent on the same date key.
  const c0 = { ...M.newChain(), length: 3, lastSolvedDate: "2026-05-05", day: 3 };
  const again = M.recordSolve(c0, M.emptyGrid(), null, "2026-05-05");
  assert("9.h recordSolve on the same day does not double-count", again.chain.length === 3 && again.chain.day === 3);
}

// ==================================================================== CASE 10
/* Structural diversity of generateFullGrid.

   WHY THIS EXISTS: a shipped defect had generateFullGrid emitting the IDENTICAL
   empty-cell mask on every single board — 300 seeds, 1 distinct mask. Every
   check in this file passed throughout, because every one of them asked "is
   this grid legal?" and not one asked "is this grid DIFFERENT from the last
   one?". Density ("exactly 4 stones and 3 empties per row and column") is one
   of the three rules AND a solver deduction source, so a frozen mask hands a
   returning player the location of every empty cell for free.

   These checks measure distribution, not legality. Thresholds are stated in
   the output so a regression fails loudly with a number attached. */

const DIV_N = 300;
const DIV_DISTINCT_FRAC = 0.9; // >=90% of sampled masks must be distinct
const DIV_TOP_FRAC = 0.05; // no single mask may own >5% of the sample
const DIV_CELL_TOL = 0.12; // per-cell stone rate must be 4/7 +/- this
const DIV_W_TOL = 0.05; // each weight's share must be 1/5 +/- this

function maskOf(g) {
  let s = "";
  for (let i = 0; i < M.CELLS; i++) s += g[i] > 0 ? "1" : "0";
  return s;
}
function gridKey(g) {
  let s = "";
  for (let i = 0; i < M.CELLS; i++) s += g[i];
  return s;
}

function case10() {
  log("\n--- CASE 10: structural diversity of generateFullGrid (anti-frozen-mask) ---");
  const t0 = Date.now();
  const EXPECT_CELL = M.STONES_PER_LINE / M.N; // 4/7 = 0.571
  const EXPECT_W = 1 / (M.MAX_WEIGHT - M.MIN_WEIGHT + 1); // 1/5 = 0.200

  // ---- 10.a/10.c unpinned sample
  const masks = new Map();
  const cellStone = new Array(M.CELLS).fill(0);
  const wCount = new Array(M.MAX_WEIGHT + 1).fill(0);
  let made = 0;
  const gridsBySeed = new Map();
  for (let k = 0; k < DIV_N; k++) {
    const seed = (SEED + k * 7919) >>> 0;
    const g = gen.generateFullGrid(mulberry32(seed), null);
    if (!g) continue;
    made++;
    gridsBySeed.set(seed, gridKey(g));
    const mk = maskOf(g);
    masks.set(mk, (masks.get(mk) || 0) + 1);
    for (let i = 0; i < M.CELLS; i++) {
      if (g[i] > 0) {
        cellStone[i]++;
        wCount[g[i]]++;
      }
    }
  }
  const topMask = Math.max(...masks.values());
  const cellRates = cellStone.map((c) => c / made);
  const minRate = Math.min(...cellRates);
  const maxRate = Math.max(...cellRates);
  const worstDev = Math.max(Math.abs(minRate - EXPECT_CELL), Math.abs(maxRate - EXPECT_CELL));
  const constantCells = cellRates.filter((r) => r === 0 || r === 1).length;
  const stoneTotal = wCount.reduce((a, b) => a + b, 0);
  const wShare = [];
  for (let v = M.MIN_WEIGHT; v <= M.MAX_WEIGHT; v++) wShare.push(wCount[v] / stoneTotal);
  const worstW = Math.max(...wShare.map((s) => Math.abs(s - EXPECT_W)));

  log(`  grids sampled (no pins):    ${made} of ${DIV_N}   (${ms(t0)})`);
  log(`  DISTINCT empty-cell masks:  ${masks.size}   (threshold: >= ${Math.ceil(DIV_DISTINCT_FRAC * made)} = ${f(DIV_DISTINCT_FRAC * 100, 0)}% of ${made})`);
  log(`  most common mask appears:   ${topMask}x   (threshold: <= ${Math.floor(DIV_TOP_FRAC * made)} = ${f(DIV_TOP_FRAC * 100, 0)}% of sample)`);
  log(`  per-cell stone rate:        min ${f(minRate, 3)}, max ${f(maxRate, 3)}, expected ${f(EXPECT_CELL, 3)} (4/7), worst deviation ${f(worstDev, 3)}   (tol ${DIV_CELL_TOL})`);
  log(`  cells always/never a stone: ${constantCells}   (must be 0)`);
  log(`  weight shares 1..5:         ${wShare.map((s) => f(s, 3)).join("  ")}   expected ${f(EXPECT_W, 3)} each, worst deviation ${f(worstW, 3)}   (tol ${DIV_W_TOL})`);

  assert("10.a generateFullGrid produced the full sample", made === DIV_N, `${made}/${DIV_N}`);
  assert(`10.b >= ${f(DIV_DISTINCT_FRAC * 100, 0)}% of empty-cell masks are DISTINCT`, masks.size >= DIV_DISTINCT_FRAC * made, `${masks.size} distinct of ${made}`);
  assert(`10.c no single mask owns > ${f(DIV_TOP_FRAC * 100, 0)}% of the sample`, topMask <= Math.max(2, Math.floor(DIV_TOP_FRAC * made)), `most common appears ${topMask}x`);
  assert("10.d no cell is always a stone or always empty", constantCells === 0, `${constantCells} constant cells`);
  assert(`10.e every cell's stone rate is 4/7 +/- ${DIV_CELL_TOL}`, worstDev <= DIV_CELL_TOL, `worst deviation ${f(worstDev, 3)} (min ${f(minRate, 3)}, max ${f(maxRate, 3)})`);
  assert(`10.f no weight starved or dominant beyond +/- ${DIV_W_TOL}`, worstW <= DIV_W_TOL, `shares ${wShare.map((s) => f(s, 3)).join(",")}`);

  // ---- 10.g/10.h diversity UNDER PINS, built the way the chain builds them:
  // survivors of a solved board, rotated 90 CW. This is the path the daily
  // actually takes, so a mask frozen only under pins would still be a leak.
  const pinRng = mulberry32(SEED ^ 0x0d1ce);
  const pinSets = [];
  for (let s = 1; pinSets.length < 3 && s < 600; s++) {
    const g = gen.generateFullGrid(mulberry32((SEED + s * 2654435761) >>> 0), null);
    if (!g) continue;
    const surv = M.survivors(g);
    const want = 3 + (pinSets.length % 3); // 3, 4, 5 bedrock stones
    if (surv.length < want) continue;
    shuffle(surv, pinRng);
    pinSets.push(surv.slice(0, want).map((i) => {
      const p = M.rotatePoint(M.rowOf(i), M.colOf(i));
      return M.makeBedrock(p.r, p.c, g[i], 1);
    }));
  }
  const PIN_N = 100;
  let pinMisfit = 0,
    pinMade = 0,
    pinWorstTop = 0,
    pinWorstDistinct = 1;
  assert("10.g built 3 chain-style pin sets (3/4/5 stones)", pinSets.length === 3, `${pinSets.length} sets`);
  for (let si = 0; si < pinSets.length; si++) {
    const bed = pinSets[si];
    const pins = new Int8Array(M.CELLS).fill(-1);
    for (const b of bed) pins[M.idx(b.r, b.c)] = b.w;
    const pm = new Map();
    let n = 0;
    for (let k = 0; k < PIN_N; k++) {
      const g = gen.generateFullGrid(mulberry32((SEED + 5501 + k * 7919) >>> 0), pins);
      if (!g) continue;
      n++;
      if (!M.bedrockFits(g, bed)) pinMisfit++;
      const mk = maskOf(g);
      pm.set(mk, (pm.get(mk) || 0) + 1);
    }
    pinMade += n;
    const top = pm.size ? Math.max(...pm.values()) : PIN_N;
    pinWorstTop = Math.max(pinWorstTop, top);
    pinWorstDistinct = Math.min(pinWorstDistinct, n ? pm.size / n : 0);
    log(`  pin set ${si + 1} (${bed.length} bedrock): ${n}/${PIN_N} grids, ${pm.size} distinct masks, most common ${top}x, misfits ${pinMisfit}`);
  }
  log(`  pinned worst distinct fraction: ${f(pinWorstDistinct, 3)}   (threshold >= ${DIV_DISTINCT_FRAC})`);
  assert("10.h every pinned grid fits its bedrock", pinMisfit === 0 && pinMade === PIN_N * pinSets.length, `${pinMisfit} misfits, ${pinMade} grids`);
  assert(`10.i masks stay >= ${f(DIV_DISTINCT_FRAC * 100, 0)}% distinct under 3-5 pinned bedrock stones`, pinWorstDistinct >= DIV_DISTINCT_FRAC, `worst ${f(pinWorstDistinct, 3)}, most common mask ${pinWorstTop}x`);

  // ---- 10.j determinism in-process
  let drift = 0;
  for (const [seed, key] of gridsBySeed) {
    const g2 = gen.generateFullGrid(mulberry32(seed), null);
    if (!g2 || gridKey(g2) !== key) drift++;
  }
  log(`  in-process replay of all ${gridsBySeed.size} seeds: ${drift} drifted   (must be 0)`);
  assert("10.j same seed reproduces a byte-identical grid in-process", drift === 0, `${drift} drifted`);

  // ---- 10.k determinism ACROSS PROCESSES. The daily board is regenerated from
  // (dateKey, tier) and never stored, so a cross-process difference would hand
  // two players different boards for the same day.
  const { execFileSync } = require("child_process");
  const probe = [
    "const p=require('path');",
    `const M=require(${JSON.stringify(path.join(__dirname, "..", "js", "model.js"))});`,
    `const gen=require(${JSON.stringify(path.join(__dirname, "..", "js", "generator.js"))});`,
    `const {mulberry32}=require(${JSON.stringify(path.join(__dirname, "..", "js", "rng.js"))});`,
    "const out=[];for(let k=0;k<25;k++){const g=gen.generateFullGrid(mulberry32((" + SEED + "+k*7919)>>>0),null);out.push(g?Array.from(g).join(''):'null');}",
    "console.log(out.join('|'));",
  ].join("");
  let childA = "",
    childB = "";
  try {
    childA = execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" }).trim();
    childB = execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" }).trim();
  } catch (e) {
    log(`  child process probe failed: ${e && e.message}`);
  }
  const localA = [];
  for (let k = 0; k < 25; k++) {
    const g = gen.generateFullGrid(mulberry32((SEED + k * 7919) >>> 0), null);
    localA.push(g ? Array.from(g).join("") : "null");
  }
  const local = localA.join("|");
  log(`  cross-process: 25 seeds regenerated in 2 fresh node processes`);
  log(`  child A === child B: ${childA === childB && childA.length > 0}   child A === this process: ${childA === local}`);
  assert("10.k two fresh node processes produce byte-identical grids", childA.length > 0 && childA === childB, `A==B: ${childA === childB}, probe len ${childA.length}`);
  assert("10.l child process matches this process byte for byte", childA === local, `A==local: ${childA === local}`);

  // ---- 10.m NEGATIVE CONTROL. A diversity check that cannot fail is worth
  // nothing, so feed the exact shipped defect (one mask, repeated) through the
  // same thresholds and confirm they reject it.
  const frozen = [];
  const g0 = gen.generateFullGrid(mulberry32(SEED), null);
  for (let k = 0; k < DIV_N; k++) frozen.push(maskOf(g0));
  const fm = new Set(frozen);
  const frozenTop = DIV_N;
  const caught = !(fm.size >= DIV_DISTINCT_FRAC * DIV_N) && !(frozenTop <= Math.max(2, Math.floor(DIV_TOP_FRAC * DIV_N)));
  log(`  negative control (the shipped defect: ${DIV_N} grids, 1 mask): distinct ${fm.size}, top ${frozenTop}x -> rejected by 10.b/10.c: ${caught}`);
  assert("10.m the diversity thresholds reject a frozen-mask sample", caught, `distinct ${fm.size}, top ${frozenTop}`);
}

// ==================================================================== CASE 11
/* Puzzle-level diversity. Same blind spot one level up: CASE 2 proves every
   generated puzzle is legal/unique/correctly tiered, but never that two seeds
   give two DIFFERENT puzzles. Fed by the data CASE 2 already collects. */
let case2Fingerprints = null;
function case11() {
  log("\n--- CASE 11: puzzle-level diversity across seeds ---");
  let bad = 0;
  for (const tier of TIERS) {
    const fp = case2Fingerprints[tier];
    const sol = new Set(fp.solutions);
    const giv = new Set(fp.givenMasks);
    const ok = sol.size === fp.solutions.length && giv.size >= fp.givenMasks.length * 0.9;
    if (!ok) bad++;
    log(`  ${tier.padEnd(9)} ${String(fp.solutions.length).padStart(3)} boards -> ${String(sol.size).padStart(3)} distinct solutions, ${String(giv.size).padStart(3)} distinct given-masks   ${ok ? "" : "<-- LOW"}`);
  }
  assert("11.a every seed yields a distinct solution grid, and >=90% distinct given-masks per tier", bad === 0, `${bad} tier(s) below threshold`);
}

// ==================================================================== CASE 12
/* The actual production entry point. Every other case drives generate() with a
   raw integer seed, but the shipping game calls dailySeed(dateKey, tier) and
   NEVER stores the board — it is rebuilt from the date on every load. So this
   path has to be both stable (same date => same board, in any process, forever)
   and varied (consecutive dates => different boards; same date, different tier
   => different boards). Nothing above was asking either question. */
function case12() {
  const DAYS = 8;
  log(`\n--- CASE 12: dailySeed production path, ${DAYS} consecutive dates ---`);
  const t0 = Date.now();
  const keys = [];
  for (let d = 0; d < DAYS; d++) keys.push(new Date(Date.UTC(2026, 7, 1 + d)).toISOString().slice(0, 10));

  const sols = new Map();
  let nulls = 0;
  for (const k of keys) {
    const r = gen.generate({ tier: "slate", seed: gen.dailySeed(k, "slate") });
    if (!r.puzzle) {
      nulls++;
      continue;
    }
    sols.set(k, gridKey(r.solution));
  }
  const distinct = new Set(sols.values()).size;

  let drift = 0;
  for (const k of keys) {
    if (!sols.has(k)) continue;
    const r = gen.generate({ tier: "slate", seed: gen.dailySeed(k, "slate") });
    if (!r.puzzle || gridKey(r.solution) !== sols.get(k)) drift++;
  }

  const a = gen.generate({ tier: "silt", seed: gen.dailySeed(keys[0], "silt") });
  const b = gen.generate({ tier: "slate", seed: gen.dailySeed(keys[0], "slate") });
  const tierSplit = a.puzzle && b.puzzle && gridKey(a.solution) !== gridKey(b.solution);

  const seedsDistinct = new Set(keys.map((k) => gen.dailySeed(k, "slate"))).size;

  log(`  elapsed: ${ms(t0)}`);
  log(`  dates generated:            ${sols.size}/${DAYS}   (${nulls} null)`);
  log(`  distinct dailySeed values:  ${seedsDistinct}/${DAYS}   (must be ${DAYS})`);
  log(`  distinct daily solutions:   ${distinct}/${sols.size}   (must be ${sols.size})`);
  log(`  rebuild drift for same date: ${drift}   (must be 0)`);
  log(`  same date, silt vs slate differ: ${tierSplit}`);
  assert("12.a every date produced a puzzle", nulls === 0, `${nulls} null days`);
  assert("12.b dailySeed is distinct per date", seedsDistinct === DAYS, `${seedsDistinct}/${DAYS}`);
  assert("12.c consecutive dates give different boards", distinct === sols.size, `${distinct}/${sols.size} distinct`);
  assert("12.d the same date rebuilds byte-identically", drift === 0, `${drift} drifted`);
  assert("12.e same date, different tier gives a different board", tierSplit === true, `${tierSplit}`);
}

// ========================================================================= run
const T0 = Date.now();
log(`STRATA correctness gate — seed ${SEED}, batch ${BATCH}/tier${BATCH >= 200 ? " (FULL SPEC BATCH)" : " (REDUCED)"}`);
case1();
case3();
case8();
case9();
case10();
case2();
case11();
case12();
const erosionPct = case4();

log("\n=======================================================");
log(`checks: ${lines.length}   failed: ${failures}   total wall time: ${ms(T0)}`);
for (const l of lines) if (!l.ok) log(`  FAILED: ${l.name}`);
log(failures === 0 ? "VERDICT: PASS — gate is green." : `VERDICT: FAIL — ${failures} check(s) red.`);
process.exit(failures === 0 ? 0 : 1);
