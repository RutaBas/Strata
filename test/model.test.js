"use strict";

/* Scaffold-stage sanity check for the data model.
   Run: node test/model.test.js
   The real correctness gate is test/verify.js, added with the solver. */

const M = require("../js/model.js");

let fails = 0;
function ok(name, cond, extra) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    fails++;
    console.log(`  FAIL  ${name}${extra ? "  — " + extra : ""}`);
  }
}

// A grid of arbitrary values, only used to exercise index arithmetic.
const probe = new Int8Array(M.CELLS);
for (let i = 0; i < M.CELLS; i++) probe[i] = (i % 5) + 1;

console.log("\nrotation");
ok("rotate90 x4 is the identity", M.gridsEqual(M.rotate90(M.rotate90(M.rotate90(M.rotate90(probe)))), probe));
ok("rotate90 x2 equals rotate180", M.gridsEqual(M.rotate90(M.rotate90(probe)), M.rotate180(probe)));
ok("rotate90 moves (0,0) to (0,N-1)", M.rotate90(oneAt(0, 0))[M.idx(0, M.N - 1)] === 9, "clockwise check");
ok("rotatePoint agrees with rotate90", agreesOnAllPoints());

function oneAt(r, c) {
  const g = new Int8Array(M.CELLS);
  g[M.idx(r, c)] = 9;
  return g;
}
function agreesOnAllPoints() {
  for (let r = 0; r < M.N; r++) {
    for (let c = 0; c < M.N; c++) {
      const p = M.rotatePoint(r, c);
      if (M.rotate90(oneAt(r, c))[M.idx(p.r, p.c)] !== 9) return false;
    }
  }
  return true;
}

console.log("\nsurvival");
// Hand-built legal-ish patch: a lone 5 among smaller stones, plus an isolated 2.
const g = new Int8Array(M.CELLS);
g[M.idx(1, 1)] = 5;
g[M.idx(0, 1)] = 3;
g[M.idx(2, 1)] = 1;
g[M.idx(1, 0)] = 4;
g[M.idx(1, 2)] = 2;
g[M.idx(5, 5)] = 2; // isolated but too light to survive
g[M.idx(3, 5)] = 4; // isolated and heavy enough
const a = M.survivors(g).join(",");
const b = M.survivorsAlt(g).join(",");
ok("two independent survivor methods agree", a === b, `${a} vs ${b}`);
ok("the local maximum survives", M.survivors(g).includes(M.idx(1, 1)));
ok("a dominated stone does not", !M.survivors(g).includes(M.idx(1, 2)));
ok("a heavy isolated stone survives vacuously", M.survivors(g).includes(M.idx(3, 5)));
ok("a light isolated stone is too weak to survive", !M.survivors(g).includes(M.idx(5, 5)));
ok("no ties in the probe patch", M.countTies(g) === 0);

console.log("\nbedrock cap and erosion");
let bed = [
  M.makeBedrock(0, 0, 3, 4),
  M.makeBedrock(0, 1, 2, 1),
  M.makeBedrock(0, 2, 5, 9),
  M.makeBedrock(0, 3, 4, 2),
];
const er = M.erodeYoungest(bed);
ok("erosion takes the youngest stone", er.eroded.age === 1);
ok("the ancient stone is untouched", er.bedrock.some((b) => b.age === 9));
ok("erosion leaves the rest intact", er.bedrock.length === 3);

// A grid with more than BEDROCK_CAP survivors must come out capped.
const many = new Int8Array(M.CELLS);
for (let r = 0; r < M.N; r += 2) for (let c = 0; c < M.N; c += 2) many[M.idx(r, c)] = 5;
const nb = M.nextBedrock(many, null, []);
ok(`inheritance capped at ${M.BEDROCK_CAP}`, nb.bedrock.length === M.BEDROCK_CAP, `got ${nb.bedrock.length}`);
ok("capped stones are reported", nb.capped.length > 0);

console.log("\nchain state");
let chain = M.newChain();
ok("a fresh chain has no bedrock", M.chainStatus(chain, "2026-07-27").status === "fresh");
chain = M.recordSolve(chain, many, null, "2026-07-27").chain;
ok("solving advances the chain", chain.length === 1);
ok("chain intact the next day", M.chainStatus(chain, "2026-07-28").status === "intact");
ok("chain intact when re-opened same day", M.chainStatus(chain, "2026-07-27").status === "intact");
const broke = M.chainStatus(chain, "2026-07-30");
ok("missing a day breaks the chain", broke.status === "broken");
ok("break clears the bedrock", broke.chain.bedrock.length === 0);
ok("break says so plainly", broke.message === "Chain broken at 1. Starting again.", broke.message);

console.log(fails ? `\n${fails} FAILED\n` : "\nall model checks passed\n");
process.exit(fails ? 1 : 0);
