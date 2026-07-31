"use strict";

/* STRATA — THE TALLY STRIKE on a finished line.
   Run: node test/strike.test.js

   A struck clue is a claim: "this line is done and it is right." The claim is
   worth less than nothing if it can be true while the line is illegal, or if
   it survives the move that undoes it. So this file pins the exact condition
   in game.js's lineState() —

     four stones placed  AND  the load matched  AND  no repulsion inside the
     line (no two orthogonally adjacent stones in it sharing a weight)

   — and then pins the DOM that renders it, by driving the REAL ui.js through
   the shim: the clue node must gain `.done`, must say so in its aria-label,
   and must lose both the instant an undo takes the line apart again.

   Part 1 uses a HAND-BUILT board rather than a generated one, because the
   interesting case (a line that adds up while breaking repulsion) cannot be
   reached by legal play at all — place() refuses it — and must be forced. */

const path = require("path");
const M = require(path.join(__dirname, "..", "js", "model.js"));
const solver = require(path.join(__dirname, "..", "js", "solver.js"));
const generator = require(path.join(__dirname, "..", "js", "generator.js"));
const rng = require(path.join(__dirname, "..", "js", "rng.js"));
const StrataGame = require(path.join(__dirname, "..", "js", "game.js"));
const { bootApp } = require(path.join(__dirname, "dom-shim.js"));

const logic = { model: M, solver, generator, rng };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { fails++; console.log(`  FAIL  ${name}${extra ? "  — " + extra : ""}`); }
}

/* A blank 7x7 with row 0's load set to 12 and every other clue set high enough
   that nothing else interferes. game.begin() copies what it is given; the
   rules under test all live in lineState(). */
function bench(rowClue) {
  const blank = new Int8Array(M.CELLS).fill(M.UNKNOWN);
  const g = StrataGame.create(logic);
  g.begin({
    tier: "topsoil", seed: 1,
    puzzle: {
      clues: { rows: [rowClue, 40, 40, 40, 40, 40, 40], cols: [40, 40, 40, 40, 40, 40, 40] },
      givens: blank
    },
    solution: new Int8Array(M.CELLS).fill(0),
    bedrock: []
  }, { isDaily: false, dateKey: "2026-07-31" });
  return g;
}
const row0 = () => [0, 1, 2, 3, 4, 5, 6];
const struck = (g, r) => g.lineState().rows[r].done;

// =================================================== 1. the strike condition
console.log("\nstrike: when a line is ticked off");
{
  // 2 4 x 1 5 x x  — four stones, load 12, no two adjacent alike
  const g = bench(12);
  const cells = row0();
  g.place(cells[0], 2); g.place(cells[1], 4); g.place(cells[3], 1);
  ok("three of the four stones down: NOT struck", struck(g, 0) === false,
    JSON.stringify(g.lineState().rows[0]));
  ok("...and the load is not met yet", g.lineState().rows[0].sum === 7);

  g.place(cells[4], 5);
  ok("the fourth stone completes the line: STRUCK", struck(g, 0) === true,
    JSON.stringify(g.lineState().rows[0]));
  ok("striking does not wait for the leftover cells to be crossed",
    g.lineState().rows[0].open === 3);

  // undo the last stone: the strike must retract with it
  g.undo();
  ok("undo takes the fourth stone back off: UN-STRUCK", struck(g, 0) === false,
    JSON.stringify(g.lineState().rows[0]));
  g.place(cells[4], 5);
  ok("replacing it strikes again", struck(g, 0) === true);
  g.place(cells[4], M.UNKNOWN);
  ok("lifting a stone out of a struck line un-strikes it", struck(g, 0) === false);
  g.place(cells[4], 5);
  g.clearBoard();
  ok("clearing the board un-strikes every line",
    g.lineState().rows.every((m) => m.done === false));
}

console.log("\nstrike: a line that adds up but is illegal is NEVER ticked off");
{
  // 3 3 x 1 5 x x — also four stones, also load 12, but the two 3s are
  // orthogonally adjacent. place() refuses this; a force writes it anyway.
  const g = bench(12);
  const cells = row0();
  g.place(cells[0], 3);
  ok("the rules refuse the adjacent twin outright",
    g.refusal(cells[1], 3) === "repulsion", String(g.refusal(cells[1], 3)));

  g.place(cells[1], 3, { force: true });
  g.place(cells[3], 1);
  g.place(cells[4], 5);
  const m = g.lineState().rows[0];
  ok("the count is right", m.stones === M.STONES_PER_LINE, String(m.stones));
  ok("the load is right", m.sum === m.clue, `${m.sum} vs ${m.clue}`);
  ok("the line is flagged internally illegal", m.clean === false);
  ok("...and it is NOT struck", m.done === false, JSON.stringify(m));

  // fix the violation — 2 4 x 1 5, the same load of 12, legally — and it
  // ticks off at once
  g.place(cells[1], M.UNKNOWN);
  g.place(cells[0], M.UNKNOWN);
  g.place(cells[0], 2);
  g.place(cells[1], 4);
  ok("re-laying the pair legally to the same load of 12 strikes the line",
    struck(g, 0) === true,
    JSON.stringify(g.lineState().rows[0]));
}

console.log("\nstrike: columns are measured the same way");
{
  const g = bench(40);
  const col = [0, 1, 2, 3, 4, 5, 6].map((r) => M.idx(r, 0));
  g.state.clues.cols[0] = 12;
  g.place(col[0], 2); g.place(col[1], 4); g.place(col[3], 1); g.place(col[4], 5);
  ok("a completed column is struck", g.lineState().cols[0].done === true);
  g.place(col[1], M.UNKNOWN, { force: true });
  g.place(col[1], 2, { force: true });      // 2 above a 2 at col[0]: repulsion
  const m = g.lineState().cols[0];
  ok("a vertical repulsion pair is caught too", m.clean === false && m.done === false,
    JSON.stringify(m));
}

console.log("\nstrike: the line-complete SOUND fires on exactly that condition");
{
  const g = bench(12);
  const cells = row0();
  g.place(cells[0], 2); g.place(cells[1], 4); g.place(cells[3], 1);
  const before = g.place(cells[4], 5);
  ok("the completing move reports the line as newly done",
    before.lines.length === 1 && before.lines[0].kind === "row" && before.lines[0].n === 0,
    JSON.stringify(before.lines));
  const after = g.place(cells[2], 0);
  ok("crossing a leftover cell afterwards reports NO new line (no second beep)",
    after.lines.length === 0, JSON.stringify(after.lines));
}

// ============================================================= 2. the DOM
async function domChecks() {
  console.log("\nstrike: the clue node in the real ui.js");
  const app = bootApp();
  app.T.setClock(() => new Date(2026, 6, 20, 21, 0, 0));
  app.sandbox.UI.boot();
  await sleep(50);
  app.T.startTier("topsoil");
  for (let i = 0; i < 400 && !(app.T.game() && app.T.game().state.phase === "playing"); i++) {
    await sleep(25);
  }
  const G = app.T.game();
  const MM = app.sandbox.StrataModel;
  const board = app.dom.document.getElementById("board");
  const clues = board.querySelectorAll(".clue");
  // document order: corner, 7 column clues, then 7 row clues
  const rowClue = (r) => clues[1 + MM.N + r];

  ok("every clue carries its numeral in a .v span the rule can be drawn on",
    clues.slice(1).every((n) => n.children.length === 1 &&
      n.children[0].classList.contains("v") && /^\d+$/.test(n.children[0].textContent)),
    JSON.stringify(clues[1] && clues[1].children.map((c) => c.className + ":" + c.textContent)));

  // find a row that is not already finished, and fill it through the real taps
  let target = -1;
  for (let r = 0; r < MM.N; r++) if (!G.lineState().rows[r].done) { target = r; break; }
  ok("found an unfinished row to work on", target >= 0);

  ok("an unfinished row's clue is not struck",
    rowClue(target).classList.contains("done") === false);
  ok("...and it says so", /placed/.test(rowClue(target).getAttribute("aria-label")),
    rowClue(target).getAttribute("aria-label"));

  let armed = null;
  let taps = 0;
  for (let c = 0; c < MM.N; c++) {
    const i = MM.idx(target, c);
    if (G.state.board[i] !== MM.UNKNOWN) continue;
    const want = G.state.solution[i];
    if (armed !== want) { app.dom.document.dispatch("keydown", { key: String(want) }); armed = want; }
    board.querySelectorAll(`[data-i="${i}"]`)[0].click();
    taps++;
    if (G.lineState().rows[target].done) break;
  }
  ok(`the row was finished in ${taps} real taps`, G.lineState().rows[target].done === true);
  ok("the clue node is struck", rowClue(target).classList.contains("done") === true,
    rowClue(target).className);
  ok("the struck clue announces the line as complete",
    /complete/.test(rowClue(target).getAttribute("aria-label")),
    rowClue(target).getAttribute("aria-label"));
  ok("striking did not disturb the numeral itself",
    rowClue(target).children[0].textContent === String(G.state.clues.rows[target]));

  // the stale-strike check: undo, and the mark must go with the stone
  app.dom.document.getElementById("tool-undo").click();
  ok("after an undo the line really is unfinished again",
    G.lineState().rows[target].done === false);
  ok("the strike is retracted — no stale tick",
    rowClue(target).classList.contains("done") === false, rowClue(target).className);
  ok("the aria-label goes back to a progress reading",
    /placed/.test(rowClue(target).getAttribute("aria-label")),
    rowClue(target).getAttribute("aria-label"));

  console.log(fails ? `\n${fails} FAILED\n` : "\nall tally-strike checks passed\n");
  process.exit(fails ? 1 : 0);
}

domChecks().catch((e) => { console.error(e); process.exit(1); });
