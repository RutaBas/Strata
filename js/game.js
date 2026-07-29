"use strict";

/* STRATA — game state machine.

   No DOM, no localStorage calls, no timers of its own: it is handed the logic
   core (model / solver / generator) and exposes pure-ish transitions that the
   UI drives. That keeps the solver headlessly testable and lets this file run
   under node.

   PHASES
     drilling  a board is being generated (the UI shows the drilling state)
     playing   the board is live, the clock runs
     won       solved; the win screen is up
     survival  the survival animation is running
     seed      the player is picking the one stone to carry forward
     rotated   recordSolve has run; tomorrow's bedrock exists
*/

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.StrataGame = factory();
})(typeof self !== "undefined" ? self : this, function () {

  function create(logic) {
    var M = logic.model;
    var solver = logic.solver;
    var generator = logic.generator;
    var UNKNOWN = M.UNKNOWN;
    var CELLS = M.CELLS;
    var N = M.N;

    var g = {
      phase: "idle",
      tier: "topsoil",
      isDaily: false,
      dateKey: null,
      seed: 0,
      clues: null,        // {rows:[7], cols:[7]}
      givens: null,       // Int8Array(49), UNKNOWN where open
      solution: null,     // Int8Array(49)
      board: null,        // Int8Array(49), UNKNOWN where undecided
      bedrock: [],        // [{r,c,w,age}] inherited, weight-locked
      technique: null,
      moves: 0,
      mistakes: 0,
      hints: 0,
      elapsedMs: 0,
      runningSince: null,
      undoStack: [],
      seedIndex: null
    };

    // ------------------------------------------------------------- helpers
    function toArray(a) { var o = []; for (var i = 0; i < a.length; i++) o.push(a[i]); return o; }
    function fromArray(a) { return Int8Array.from(a); }

    function bedrockIndexSet() {
      var s = {};
      g.bedrock.forEach(function (b) { s[M.idx(b.r, b.c)] = b; });
      return s;
    }

    // -------------------------------------------------------------- start
    /* `gen` is a generator.generate() result. */
    function begin(gen, opts) {
      var o = opts || {};
      g.phase = "playing";
      g.tier = gen.tier;
      g.isDaily = !!o.isDaily;
      g.dateKey = o.dateKey || M.dateKey();
      g.seed = gen.seed;
      g.clues = { rows: gen.puzzle.clues.rows.slice(), cols: gen.puzzle.clues.cols.slice() };
      g.givens = Int8Array.from(gen.puzzle.givens);
      g.solution = Int8Array.from(gen.solution);
      g.board = Int8Array.from(gen.puzzle.givens);
      g.bedrock = (gen.bedrock || []).map(function (b) { return { r: b.r, c: b.c, w: b.w, age: b.age }; });
      g.technique = gen.technique || null;
      g.moves = 0; g.mistakes = 0; g.hints = 0;
      g.elapsedMs = 0; g.runningSince = null;
      g.undoStack = [];
      g.seedIndex = null;
      startClock();
      return g;
    }

    function puzzle() { return { clues: g.clues, givens: g.givens }; }

    // -------------------------------------------------------------- clock
    function startClock() { if (g.runningSince === null) g.runningSince = Date.now(); }
    function pauseClock() {
      if (g.runningSince !== null) { g.elapsedMs += Date.now() - g.runningSince; g.runningSince = null; }
    }
    function elapsed() {
      return g.elapsedMs + (g.runningSince === null ? 0 : Date.now() - g.runningSince);
    }

    // ---------------------------------------------------------------- cells
    function isLocked(i) { return g.givens[i] !== UNKNOWN; }
    function isBedrock(i) {
      for (var k = 0; k < g.bedrock.length; k++) {
        if (M.idx(g.bedrock[k].r, g.bedrock[k].c) === i) return true;
      }
      return false;
    }

    /* Why a value cannot go in a cell, or null if it can.
       A stone that breaks repulsion, or a value that over-fills or over-loads
       its line, is refused outright — the board never holds a state the rules
       forbid. A legal-but-wrong value is allowed (and counted as a mistake). */
    function refusal(i, v) {
      if (v === UNKNOWN) return null;
      if (v > 0) {
        var ns = M.neighbors(i);
        for (var k = 0; k < ns.length; k++) if (g.board[ns[k]] === v) return "repulsion";
      }
      var r = M.rowOf(i), c = M.colOf(i);
      var lines = [
        { cells: rowCells(r), clue: g.clues.rows[r], what: "row" },
        { cells: colCells(c), clue: g.clues.cols[c], what: "col" }
      ];
      for (var L = 0; L < lines.length; L++) {
        var stones = 0, empties = 0, sum = 0;
        var cs = lines[L].cells;
        for (var q = 0; q < cs.length; q++) {
          var val = cs[q] === i ? v : g.board[cs[q]];
          if (val === UNKNOWN) continue;
          if (val === 0) empties++; else { stones++; sum += val; }
        }
        if (stones > M.STONES_PER_LINE) return "overfill";
        if (empties > M.EMPTIES_PER_LINE) return "overempty";
        if (sum > lines[L].clue) return "overload";
      }
      return null;
    }

    function rowCells(r) { var o = []; for (var c = 0; c < N; c++) o.push(M.idx(r, c)); return o; }
    function colCells(c) { var o = []; for (var r = 0; r < N; r++) o.push(M.idx(r, c)); return o; }

    /* place(i, v) — v is 1..5, 0 for a known empty, UNKNOWN to clear.
       Returns {ok, code, lines:[...newly satisfied...], solved} */
    function place(i, v, opts) {
      var o = opts || {};
      if (g.phase !== "playing") return { ok: false, code: "not-playing" };
      if (isLocked(i)) return { ok: false, code: isBedrock(i) ? "bedrock" : "given" };
      if (g.board[i] === v) {
        if (v === UNKNOWN) return { ok: false, code: "noop" };
        // tapping the same value again lifts the stone
        return place(i, UNKNOWN, o);
      }
      if (!o.force) {
        var why = refusal(i, v);
        if (why) return { ok: false, code: why };
      }

      var before = lineFlags();
      g.undoStack.push({ i: i, prev: g.board[i], moves: g.moves, mistakes: g.mistakes });
      g.board[i] = v;
      g.moves += 1;
      var mistake = false;
      if (v !== UNKNOWN && v !== g.solution[i]) { g.mistakes += 1; mistake = true; }
      var after = lineFlags();

      var done = [];
      for (var k = 0; k < N; k++) {
        if (after.rows[k] && !before.rows[k]) done.push({ kind: "row", n: k });
        if (after.cols[k] && !before.cols[k]) done.push({ kind: "col", n: k });
      }
      var solved = isSolved();
      if (solved) { g.phase = "won"; pauseClock(); }
      return { ok: true, code: "placed", mistake: mistake, lines: done, solved: solved };
    }

    function erase(i) { return place(i, UNKNOWN); }

    function undo() {
      if (!g.undoStack.length) return { ok: false };
      var u = g.undoStack.pop();
      g.board[u.i] = u.prev;
      g.moves = u.moves;
      g.mistakes = u.mistakes;
      return { ok: true, index: u.i };
    }

    /* Clear every cell the player put down; givens and bedrock stay. */
    function clearBoard() {
      for (var i = 0; i < CELLS; i++) if (g.givens[i] === UNKNOWN) g.board[i] = UNKNOWN;
      g.undoStack = [];
      return true;
    }

    function restart() {
      clearBoard();
      g.moves = 0; g.mistakes = 0; g.hints = 0;
      g.elapsedMs = 0; g.runningSince = Date.now();
      g.phase = "playing";
    }

    // ----------------------------------------------------------- line state
    /* Per line: stone count, load so far, and whether BOTH are satisfied —
       count == 4 and load == clue. That pair is what turns the numeral moss. */
    function lineFlags() {
      var st = lineState();
      var rows = st.rows.map(function (x) { return x.done; });
      var cols = st.cols.map(function (x) { return x.done; });
      return { rows: rows, cols: cols };
    }

    function lineState() {
      var out = { rows: [], cols: [] };
      for (var k = 0; k < N; k++) {
        out.rows.push(measure(rowCells(k), g.clues.rows[k]));
        out.cols.push(measure(colCells(k), g.clues.cols[k]));
      }
      return out;
    }

    function measure(cells, clue) {
      var stones = 0, sum = 0, open = 0;
      for (var q = 0; q < cells.length; q++) {
        var v = g.board[cells[q]];
        if (v === UNKNOWN) { open++; continue; }
        if (v > 0) { stones++; sum += v; }
      }
      return {
        stones: stones, sum: sum, clue: clue, open: open,
        done: open === 0 && stones === M.STONES_PER_LINE && sum === clue,
        over: sum > clue || stones > M.STONES_PER_LINE
      };
    }

    /* Solved WITHOUT peeking at the stored solution: every cell decided, the
       grid legal under model's own rules, and every clue met. */
    function isSolved() {
      for (var i = 0; i < CELLS; i++) if (g.board[i] === UNKNOWN) return false;
      if (!M.isValidGrid(g.board)) return false;
      var s = M.lineSums(g.board);
      for (var k = 0; k < N; k++) {
        if (s.rows[k] !== g.clues.rows[k]) return false;
        if (s.cols[k] !== g.clues.cols[k]) return false;
      }
      return true;
    }

    // ----------------------------------------------------------------- hint
    /* The next LOGICAL deduction from the current board, with the rule named.
       Never the solution, never a random cell. */
    function hint() {
      var res = solver.nextDeduction(puzzle(), g.board);
      if (!res.found) return { ok: false, text: res.text, reason: res.reason };
      g.hints += 1;
      var r = place(res.index, res.value, { force: true });
      return {
        ok: true, index: res.index, value: res.value,
        technique: res.technique, text: res.text, result: r
      };
    }

    // ------------------------------------------------------- the chain end
    function survivorSet() { return M.survivors(g.solution); }

    /* What tomorrow looks like if the player seeds cell `index`. Pure preview —
       nothing is committed until commitSeed. */
    function previewNext(index, chain) {
      return M.nextBedrock(g.solution, index, (chain && chain.bedrock) || []);
    }

    function chooseSeed(index) {
      if (g.solution[index] <= 0) return { ok: false, code: "empty" };
      g.seedIndex = index;
      return { ok: true, index: index };
    }

    /* Hand the solved daily to the model. The state transition is model's, not
       ours — recordSolve does the ageing, the rotation and the cap. */
    function commitSeed(chain, today) {
      var res = M.recordSolve(chain, g.solution, g.seedIndex, today || g.dateKey);
      g.phase = "rotated";
      return res;
    }

    // ------------------------------------------------------------- persist
    function snapshot() {
      return {
        v: 1,
        tier: g.tier, isDaily: g.isDaily, dateKey: g.dateKey, seed: g.seed,
        clues: { rows: g.clues.rows.slice(), cols: g.clues.cols.slice() },
        givens: toArray(g.givens),
        solution: toArray(g.solution),
        board: toArray(g.board),
        bedrock: g.bedrock.map(function (b) { return { r: b.r, c: b.c, w: b.w, age: b.age }; }),
        technique: g.technique,
        moves: g.moves, mistakes: g.mistakes, hints: g.hints,
        elapsedMs: elapsed(),
        undo: g.undoStack.slice(-80),
        phase: g.phase === "playing" ? "playing" : g.phase,
        seedIndex: g.seedIndex
      };
    }

    function restore(s) {
      if (!s || s.v !== 1 || !s.clues || !s.board) return false;
      g.tier = s.tier; g.isDaily = !!s.isDaily; g.dateKey = s.dateKey; g.seed = s.seed;
      g.clues = { rows: s.clues.rows.slice(), cols: s.clues.cols.slice() };
      g.givens = fromArray(s.givens);
      g.solution = fromArray(s.solution);
      g.board = fromArray(s.board);
      g.bedrock = (s.bedrock || []).slice();
      g.technique = s.technique || null;
      g.moves = s.moves || 0; g.mistakes = s.mistakes || 0; g.hints = s.hints || 0;
      g.elapsedMs = s.elapsedMs || 0;
      g.runningSince = null;
      g.undoStack = s.undo || [];
      g.seedIndex = s.seedIndex === undefined ? null : s.seedIndex;
      g.phase = s.phase || "playing";
      return true;
    }

    return {
      state: g,
      begin: begin, restore: restore, snapshot: snapshot,
      puzzle: puzzle,
      place: place, erase: erase, undo: undo, clearBoard: clearBoard, restart: restart,
      isLocked: isLocked, isBedrock: isBedrock, refusal: refusal,
      lineState: lineState, isSolved: isSolved,
      hint: hint,
      survivorSet: survivorSet, previewNext: previewNext,
      chooseSeed: chooseSeed, commitSeed: commitSeed,
      startClock: startClock, pauseClock: pauseClock, elapsed: elapsed
    };
  }

  /* Generation costs 0.4–1.9s and Bedrock can burn several candidate grids, so
     it is sliced: each slice asks the generator for a bounded run of attempts
     and the seed for the next slice continues the SAME deterministic attempt
     sequence (generate() derives attempt k's rng from seed + k*0x9e3779b1), so
     a daily board is identical however many slices it took. */
  function generateSliced(logic, opts, onProgress) {
    var o = opts || {};
    var per = o.attemptsPerSlice || 24;
    var maxSlices = o.maxSlices || 24;
    var seed = o.seed >>> 0;
    var bedrock = o.bedrock || [];
    var slice = 0;

    return new Promise(function (resolve, reject) {
      function step() {
        if (slice >= maxSlices) { reject(new Error("could not cut a core for " + o.tier)); return; }
        var res;
        try {
          res = logic.generator.generate({
            tier: o.tier, seed: seed, bedrock: bedrock, maxAttempts: per
          });
        } catch (e) { reject(e); return; }
        if (res && res.puzzle) { resolve(res); return; }
        // continue the same attempt sequence, and keep any erosion the
        // generator had to perform to make this bedrock placeable at all
        if (res && res.bedrock) bedrock = res.bedrock;
        seed = (seed + per * 0x9e3779b1) >>> 0;
        slice += 1;
        if (onProgress) onProgress(slice, maxSlices);
        setTimeout(step, 0);
      }
      setTimeout(step, 0);
    });
  }

  return { create: create, generateSliced: generateSliced };
});
