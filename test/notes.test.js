"use strict";

/* STRATA — pencil notes: behaviour and NON-INTERFERENCE.
   Run: node test/notes.test.js

   The point of this file is the second half. Notes are the player's private
   working-out, so the claim under test is not "notes work" but "notes are
   invisible to everything that reads a board": the solver, the hint, the win
   check, the survival computation, the lineage/share payload and the mistake
   tally must all behave IDENTICALLY whether or not notes are present. Each of
   those is checked by running the same operation twice on two instances of the
   same board — one pencilled all over, one bare — and comparing the results,
   rather than by inspecting the notes and asserting they look harmless. */

const path = require("path");
const M = require(path.join(__dirname, "..", "js", "model.js"));
const solver = require(path.join(__dirname, "..", "js", "solver.js"));
const generator = require(path.join(__dirname, "..", "js", "generator.js"));
const rng = require(path.join(__dirname, "..", "js", "rng.js"));
const StrataGame = require(path.join(__dirname, "..", "js", "game.js"));

const logic = { model: M, solver, generator, rng };
const SEED = parseInt(process.env.STRATA_SEED || "20260729", 10);

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { fails++; console.log(`  FAIL  ${name}${extra ? "  — " + extra : ""}`); }
}

function fresh() {
  const gen = generator.generate({ tier: "silt", seed: SEED });
  if (!gen.puzzle) throw new Error("could not cut a board for the notes test");
  const g = StrataGame.create(logic);
  g.begin(gen, { isDaily: false, dateKey: "2026-07-29" });
  return { g, gen };
}

/* Every open cell on the board, pencilled with a deliberately WRONG-heavy
   candidate set. Every third cell gets exactly ONE candidate, and that one is
   chosen to be wrong — the most seductive leak in this feature is a solver or
   hint that treats a single surviving candidate as a decided cell, so the
   fixture has to contain that shape or the comparison proves nothing. */
function pencilEverywhere(g) {
  let n = 0;
  for (let i = 0; i < M.CELLS; i++) {
    if (g.isLocked(i)) continue;
    if (n % 3 === 0) {
      const truth = g.state.solution[i];
      g.toggleNote(i, truth === 1 ? 2 : 1);      // a lone, WRONG candidate
    } else {
      for (const w of [1, 3, 5]) g.toggleNote(i, w);
    }
    n++;
  }
  return n;
}

function openCells(g) {
  const o = [];
  for (let i = 0; i < M.CELLS; i++) if (!g.isLocked(i)) o.push(i);
  return o;
}

// ============================================================== behaviour
console.log("\nnotes: behaviour");
{
  const { g } = fresh();
  const i = openCells(g)[0];

  ok("a fresh board has no notes", g.noteCount() === 0 && g.notesAt(i).length === 0);

  g.toggleNote(i, 3);
  g.toggleNote(i, 1);
  ok("notes come back in ascending order", g.notesAt(i).join("") === "13", g.notesAt(i).join(""));

  g.toggleNote(i, 3);
  ok("toggling the same weight removes it", g.notesAt(i).join("") === "1");

  ok("weights 1-5 only: 0 is refused", g.toggleNote(i, 0).ok === false);
  ok("weights 1-5 only: 6 is refused", g.toggleNote(i, 6).ok === false);
  ok("there is no empty candidate", g.notesAt(i).indexOf(0) < 0);

  const locked = [];
  for (let k = 0; k < M.CELLS; k++) if (g.isLocked(k)) locked.push(k);
  ok("a given cannot be pencilled", locked.length > 0 && g.toggleNote(locked[0], 2).ok === false);

  const movesBefore = g.state.moves, mistakesBefore = g.state.mistakes;
  g.toggleNote(i, 4); g.toggleNote(i, 5); g.toggleNote(i, 4);
  ok("a note is not a move", g.state.moves === movesBefore, `${g.state.moves}`);
  ok("a wrong note is not a mistake", g.state.mistakes === mistakesBefore, `${g.state.mistakes}`);
}

console.log("\nnotes: clearing and undo");
{
  const { g } = fresh();
  const i = openCells(g).find((k) => g.refusal(k, 2) === null);
  g.toggleNote(i, 1); g.toggleNote(i, 2); g.toggleNote(i, 5);
  const before = g.notesAt(i).join("");

  g.place(i, 2);
  ok("filling a cell with a stone clears its notes", g.notesAt(i).length === 0);
  const u1 = g.undo();
  ok("undoing that placement restores the notes exactly",
    u1.kind === "place" && g.notesAt(i).join("") === before, g.notesAt(i).join(""));

  g.place(i, 0);
  ok("marking a cell empty clears its notes too", g.notesAt(i).length === 0);
  g.undo();
  ok("undoing the x restores the notes", g.notesAt(i).join("") === before);

  const moves = g.state.moves;
  g.toggleNote(i, 4);
  const u2 = g.undo();
  ok("undo pops a note as its own entry", u2.kind === "note" && u2.index === i);
  ok("undoing a note restores the previous note state", g.notesAt(i).join("") === before);
  ok("undoing a note does not move the move counter", g.state.moves === moves, `${g.state.moves} vs ${moves}`);

  g.clearBoard();
  ok("clearing the board clears every note", g.noteCount() === 0);
}

console.log("\nnotes: persistence");
{
  const { g } = fresh();
  const cells = openCells(g).slice(0, 4);
  cells.forEach((i, k) => { g.toggleNote(i, 1 + k); g.toggleNote(i, 5); });
  const snap = JSON.parse(JSON.stringify(g.snapshot()));

  const g2 = StrataGame.create(logic);
  ok("a snapshot with notes restores", g2.restore(snap) === true);
  ok("every note survives the round trip",
    cells.every((i) => g2.notesAt(i).join("") === g.notesAt(i).join("")));
  ok("the save keeps v:1 so old readers are not broken", snap.v === 1);

  // an OLD save, written before notes existed: no `notes` key at all
  const old = JSON.parse(JSON.stringify(g.snapshot()));
  delete old.notes;
  old.undo = [{ i: cells[0], prev: M.UNKNOWN, moves: 0, mistakes: 0 }];  // pre-notes shape
  const g3 = StrataGame.create(logic);
  let threw = null;
  try { g3.restore(old); } catch (e) { threw = e; }
  ok("a pre-notes save loads without throwing", threw === null, threw && threw.message);
  ok("a pre-notes save loads with an empty note set", g3.noteCount() === 0);
  const u = g3.undo();
  ok("a pre-notes undo entry is still treated as a placement", u.ok === true && u.kind === "place");

  // junk in the save must not become junk in memory
  const dirty = JSON.parse(JSON.stringify(g.snapshot()));
  dirty.notes = { 3: 999, 900: 7, x: 3, 5: 0 };
  const g4 = StrataGame.create(logic);
  g4.restore(dirty);
  ok("out-of-range note indexes are dropped", g4.notesAt(900) !== undefined && g4.noteCount() === 1);
  ok("note bits outside weights 1-5 are masked off",
    g4.notesAt(3).every((w) => w >= 1 && w <= 5), JSON.stringify(g4.notesAt(3)));
}

// ================================================== NON-INTERFERENCE
/* Two instances of the same board, one pencilled everywhere and one bare,
   driven through identical operations. Any divergence is a leak. */
console.log("\nnotes: non-interference (pencilled board vs bare board)");
{
  const a = fresh().g;   // pencilled
  const b = fresh().g;   // bare
  const pencilled = pencilEverywhere(a);
  ok(`${pencilled} open cells pencilled (two thirds {1,3,5}, one third a lone wrong candidate)`,
    pencilled > 0 && a.noteCount() === pencilled);

  const boardKey = (g) => Array.from(g.state.board).join(",");
  ok("pencilling changes no cell on the board", boardKey(a) === boardKey(b));

  // --- the solver / hint
  const ha = a.hint(), hb = b.hint();
  ok("the hint names the same cell, value and reason",
    ha.ok === hb.ok && ha.index === hb.index && ha.value === hb.value && ha.text === hb.text,
    `${JSON.stringify([ha.index, ha.value])} vs ${JSON.stringify([hb.index, hb.value])}`);

  const da = solver.deduce(a.puzzle(), { techniques: M.TECHNIQUES });
  const db = solver.deduce(b.puzzle(), { techniques: M.TECHNIQUES });
  ok("deduce() reaches an identical grid",
    Array.from(da.grid).join(",") === Array.from(db.grid).join(","));

  // --- refusals and line state, cell by cell
  let refuseDiff = 0;
  for (let i = 0; i < M.CELLS; i++) {
    for (let v = 0; v <= 5; v++) if (a.refusal(i, v) !== b.refusal(i, v)) refuseDiff++;
  }
  ok("every refusal is identical", refuseDiff === 0, `${refuseDiff} differences`);
  ok("lineState() is identical",
    JSON.stringify(a.lineState()) === JSON.stringify(b.lineState()));

  // --- half solve first: the notes on cells that are STILL open must survive
  const half = openCells(a).filter((i) => a.state.board[i] === M.UNKNOWN);
  const filled = half.slice(0, Math.floor(half.length / 2));
  const stillOpen = half.slice(Math.floor(half.length / 2));
  filled.forEach((i) => {
    a.place(i, a.state.solution[i], { force: true });
    b.place(i, b.state.solution[i], { force: true });
  });
  ok("filling half the board pruned no note on a cell that stayed open",
    stillOpen.every((i) => a.notesAt(i).length > 0),
    `${stillOpen.filter((i) => a.notesAt(i).length === 0).length} pruned`);
  ok("every cell that WAS filled lost its notes",
    filled.every((i) => a.notesAt(i).length === 0));

  // --- then finish both, the same way, and compare everything
  for (let i = 0; i < M.CELLS; i++) {
    if (a.isLocked(i)) continue;
    if (a.state.board[i] !== a.state.solution[i]) a.place(i, a.state.solution[i], { force: true });
    if (b.state.board[i] !== b.state.solution[i]) b.place(i, b.state.solution[i], { force: true });
  }
  ok("the pencilled board solves", a.isSolved() === true);
  ok("the win check agrees on both", a.isSolved() === b.isSolved());
  ok("both reached the same phase", a.state.phase === b.state.phase, a.state.phase);
  ok("the move counts match", a.state.moves === b.state.moves, `${a.state.moves} vs ${b.state.moves}`);
  ok("the mistake counts match (a wrong note is never a mistake)",
    a.state.mistakes === b.state.mistakes, `${a.state.mistakes} vs ${b.state.mistakes}`);
  ok("survivorSet() is identical",
    a.survivorSet().join(",") === b.survivorSet().join(","));
  ok("previewNext() — tomorrow's bedrock — is identical",
    JSON.stringify(a.previewNext(a.survivorSet()[0], M.newChain())) ===
    JSON.stringify(b.previewNext(b.survivorSet()[0], M.newChain())));

  // --- the lineage / share payload is built from solution + survivors + ages
  const payload = (g) => JSON.stringify({
    grid: Array.from(g.state.solution),
    survivors: g.survivorSet(),
    bedrock: g.state.bedrock
  });
  ok("the lineage / share payload is byte-identical", payload(a) === payload(b));

  // a fully decided board has no undecided cell left to hold a note
  ok("a solved board carries no notes at all", a.noteCount() === 0, `${a.noteCount()}`);
}

console.log("\nnotes: never auto-filled or auto-pruned");
{
  const { g } = fresh();
  const open = openCells(g);
  const target = open[0];
  g.toggleNote(target, 1); g.toggleNote(target, 2); g.toggleNote(target, 3);

  // place stones all around it; the notes must not move a single bit
  const before = g.notesAt(target).join("");
  M.neighbors(target).forEach((n) => {
    if (g.isLocked(n)) return;
    const v = g.state.solution[n];
    if (v !== M.UNKNOWN) g.place(n, v, { force: true });
  });
  ok("a neighbouring stone never prunes a note", g.notesAt(target).join("") === before, g.notesAt(target).join(""));

  // and the solver never writes one
  const untouched = open.filter((i) => i !== target);
  ok("no cell was ever auto-filled with notes",
    untouched.every((i) => g.notesAt(i).length === 0));

  g.hint();
  ok("a hint writes no notes", g.noteCount() === 1);
}

console.log(fails ? `\n${fails} FAILED\n` : "\nall pencil-note checks passed\n");
process.exit(fails ? 1 : 0);
