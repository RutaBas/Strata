"use strict";

/* Longest hint explanation solver.nextDeduction can emit.

   Not a gate — a measuring tool. It walks a batch of generated boards across
   every tier, replaying the whole deduction chain from the givens, and reports
   the longest text string the hint toast will ever have to lay out. The UI's
   two-line wrap budget is checked against whatever this prints. */

const path = require("path");
const model = require(path.join(__dirname, "..", "js", "model.js"));
const solver = require(path.join(__dirname, "..", "js", "solver.js"));
const generator = require(path.join(__dirname, "..", "js", "generator.js"));

const PER_TIER = Number(process.argv[2] || 30);
const UNKNOWN = model.UNKNOWN;

let best = { len: 0, text: "", tier: null };
const byTier = {};
let samples = 0;

for (const tier of model.TIERS) {
  let longest = { len: 0, text: "" };
  let made = 0;
  for (let k = 0; made < PER_TIER && k < PER_TIER * 40; k++) {
    const seed = (0x51a7a + k * 0x9e3779b1) >>> 0;
    let gen;
    try {
      gen = generator.generate({ tier: tier.key, seed, maxAttempts: 6 });
    } catch (e) { continue; }
    if (!gen || !gen.puzzle) continue;
    made++;

    const board = Int8Array.from(gen.puzzle.givens);
    for (let step = 0; step < model.CELLS + 4; step++) {
      const h = solver.nextDeduction(gen.puzzle, board);
      if (!h.found) break;
      samples++;
      const len = h.text.length;
      if (len > longest.len) longest = { len, text: h.text };
      if (len > best.len) best = { len, text: h.text, tier: tier.key };
      board[h.index] = h.value;
    }
    // and from a partially-played state: clear a random third back to UNKNOWN
    // so hints fire from mid-game positions too, not only the opening chain
    const mid = Int8Array.from(gen.solution);
    for (let i = 0; i < model.CELLS; i++) {
      if (gen.puzzle.givens[i] === UNKNOWN && (i * 7 + k) % 3 === 0) mid[i] = UNKNOWN;
    }
    for (let step = 0; step < model.CELLS + 4; step++) {
      const h = solver.nextDeduction(gen.puzzle, mid);
      if (!h.found) break;
      samples++;
      const len = h.text.length;
      if (len > longest.len) longest = { len, text: h.text };
      if (len > best.len) best = { len, text: h.text, tier: tier.key };
      mid[h.index] = h.value;
    }
  }
  byTier[tier.key] = longest;
  console.log(
    tier.name.padEnd(9) + " " + made + " boards · longest " +
    String(longest.len).padStart(3) + "  " + JSON.stringify(longest.text)
  );
}

console.log("\n" + samples + " hint strings sampled.");
console.log("WORST CASE (" + best.tier + "), " + best.len + " chars:");
console.log(best.text);
