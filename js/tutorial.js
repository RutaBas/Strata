"use strict";
/* One IIFE per browser file, publishing one namespaced global — the same shape
   as the logic core. See the note in js/logic.js. */
var StrataTutorial = (function (root) {

/* STRATA — the field lesson.

   A guided run through one core, start to finish: the three rules demonstrated
   on a real board, three deductions the player makes themselves, the technique
   ladder that the six tiers actually ride on, and then the chain — the survival
   animation, the seed choice and the rotation into tomorrow's bedrock. It is
   not the first-launch "how to play" card; that card still exists and still
   shows the three rules in words.

   THREE HARD RULES ABOUT THIS FILE.

   1. The board is a LITERAL. It is not generated, from a seed or otherwise, so
      the authored steps can never drift out from under it. `assertBoard()`
      re-derives every claim the steps make — validity, the clues, the survivor
      set, and each teaching cell's value — from the logic core at load, and
      throws loudly if any of them has moved.

   2. The four technique steps are PROVED, not written. Each one blanks a set of
      cells and claims "this cell falls to technique T and to nothing weaker".
      `assertDemos()` puts that claim to js/solver.js at load: it runs deduce()
      with the technique set below T and requires the cell to be unresolved, then
      runs it with T and requires the cell to be fixed to its true value. The
      intermediate candidate sets the copy quotes ("a 1 or a 3") are asserted
      too. If the solver's ladder ever shifts, the lesson refuses to open rather
      than teach something false.

   3. It records NOTHING that a player earned. No Store save, no Meta call, no
      model.recordSolve, no chain, streak, record or history movement. The ONE
      key it writes is `strata:lesson`, the "you have seen this" flag that lets a
      returning player click through the interactive steps (see NOT-FIRST-TIME
      below). Everything else is byte-identical across a run, a skip and a leave.

   NOT-FIRST-TIME
      `strata:lesson` is written when the player reaches the end of the lesson OR
      uses Leave lesson. Abandoning by closing the tab writes nothing, so an
      interrupted first run is still a first run. `returning` is latched once at
      open(), before anything is written, so finishing a first run does not make
      that same run skippable half way through.

   The board, the keypad, the tier rows, the survival sequence and both mini
   boards all come from js/ui.js and js/model.js, so this is the game teaching
   itself rather than a slideshow drawn alongside it. */

var api = null;      // the component handles ui.js hands over
var M = null;
var S = null;        // the solver — it proves the technique steps
var TG = null;       // a real StrataGame instance over the fixed board
var step = 0;
var armed = null;
var seedPick = null;
var nudgeTimer = null;
var opened = false;
var returning = false;   // latched at open: has this player seen the lesson?
var seq = 0;             // bumped on every render and on close; cancels timers

var LESSON_KEY = "lesson";   // -> localStorage "strata:lesson"

// ------------------------------------------------------------- the board
/* Picked once by scripts/pick-tutorial-board.js and pasted here. Chosen for
   three survivors (so the seed choice clearly adds a fourth and nothing hits
   the cap), and for holding one clean example of each rule. */
var GRID = [
  2, 1, 2, 1, 0, 0, 0,   // load 6
  1, 2, 4, 5, 0, 0, 0,   // load 12
  2, 4, 1, 2, 0, 0, 0,   // load 9
  3, 0, 0, 0, 2, 1, 3,   // load 9
  0, 2, 0, 0, 4, 2, 1,   // load 9
  0, 0, 3, 0, 5, 1, 3,   // load 12
  0, 0, 0, 2, 4, 2, 1    // load 9
];
var ROWS = [6, 12, 9, 9, 9, 12, 9];
var COLS = [8, 9, 10, 10, 15, 6, 8];
var SURVIVORS = [10, 15, 39];          // r2c4=5, r3c2=4, r6c5=5

// the cells the lesson talks about, by index
var CELL = {
  load: [21, 25, 26, 27],              // row 4's four stones
  loadRow: 3,
  repelOn: 39,                         // the 5 at r6c5
  repelNear: [32, 46, 38, 40],         // what it touches
  sum: 15,                             // r3c2 — forced by row 3's load
  dens: 4,                             // r1c5 — forced empty by the count
  rep: [7, 8]                          // r2c1, r2c2 — split by repulsion
};

// the stone a returning player is given when they click past the seed choice
var DEMO_SEED = 9;                     // r2c3 = 4, heavy but not a survivor

/* ------------------------------------------------------- technique demos

   Four scenarios on the SAME board, one per technique set. `hide` is blanked;
   `settle` is what the named technique then forces, in the order it is shown;
   `domains` is the candidate set the copy quotes for a cell at the moment just
   before the technique fires. All three are checked by assertDemos(). */
var DEMOS = {
  sums: {
    technique: "sums",
    hide: [5, 12, 19, 26, 33, 40, 47],           // the whole of column 6
    settle: [26, 33, 40, 47, 5, 12, 19],
    domains: {},
    lit: [5, 12, 19, 26, 33, 40, 47],
    litRow: 3
  },
  repulsion: {
    technique: "repulsion",
    hide: [26, 27, 33, 34],                      // r4c6, r4c7, r5c6, r5c7
    settle: [26, 33, 34, 27],                    // the three-link chain, then the leftover
    domains: { 26: [1, 2], 33: [1, 2], 34: [1, 2] },
    lit: [25, 26, 33, 34],
    litRow: null
  },
  parity: {
    technique: "parity",
    hide: [7, 10, 21, 24, 25, 45, 46],
    settle: [21, 25],                            // r4c1 = 3, r4c5 = 2
    domains: { 21: [1, 3], 24: [0, 3, 4], 25: [2, 3] },
    lit: [21, 24, 25],
    litRow: 3
  },
  intersection: {
    technique: "intersection",
    hide: [10, 11, 31, 32, 45, 46],              // row 7 keeps exactly two open cells
    settle: [45, 46],                            // r7c4 = 2, r7c5 = 4
    domains: { 45: [2, 3], 46: [3, 4] },
    lit: [45, 46],
    litRow: 6, litCols: [3, 4]
  }
};

/* Every claim the copy makes, checked against the logic core. If the core's
   rules ever move, this throws on open instead of teaching something false. */
function assertBoard() {
  var bad = function (m) { throw new Error("field lesson board is stale: " + m); };
  if (GRID.length !== M.CELLS) bad("wrong size");
  var g = Int8Array.from(GRID);
  if (!M.isValidGrid(g)) bad("the grid breaks the rules it is teaching");
  var s = M.lineSums(g);
  for (var k = 0; k < M.N; k++) {
    if (s.rows[k] !== ROWS[k]) bad("row " + (k + 1) + " load is " + s.rows[k] + ", not " + ROWS[k]);
    if (s.cols[k] !== COLS[k]) bad("col " + (k + 1) + " load is " + s.cols[k] + ", not " + COLS[k]);
  }
  var cnt = M.lineCounts(g);
  for (var q = 0; q < M.N; q++) {
    if (cnt.rows[q] !== M.STONES_PER_LINE || cnt.cols[q] !== M.STONES_PER_LINE) bad("line " + (q + 1) + " is not four stones");
  }
  var surv = M.survivors(g);
  if (surv.join(",") !== SURVIVORS.join(",")) bad("survivors are " + surv.join(",") + ", not " + SURVIVORS.join(","));
  // the three teaching cells hold what the copy says they hold
  if (g[CELL.sum] !== 4) bad("the load example is not a 4");
  if (g[CELL.dens] !== 0) bad("the density example is not an empty");
  if (g[CELL.rep[0]] !== 1 || g[CELL.rep[1]] !== 2) bad("the repulsion pair is not 1,2");
  // ...and the repulsion story: a 2 at r2c1 would touch a 2 above AND below
  if (g[M.idx(0, 0)] !== 2 || g[M.idx(2, 0)] !== 2) bad("the repulsion pair has no 2s around it");
  if (g[CELL.repelOn] !== 5) bad("the repulsion example is not a 5");
  // the seed a returning player is handed must be a stone that did NOT survive
  if (!(GRID[DEMO_SEED] > 0) || SURVIVORS.indexOf(DEMO_SEED) >= 0) bad("the demo seed is not a non-surviving stone");
  assertDemos();
}

/* The technique steps, put to the solver. See rule 2 in the header. */
function assertDemos() {
  var bad = function (m) { throw new Error("field lesson technique demo is stale: " + m); };
  var LADDER = M.TECHNIQUES;

  Object.keys(DEMOS).forEach(function (name) {
    var d = DEMOS[name];
    var k = LADDER.indexOf(d.technique);
    if (k < 0) bad(name + ": " + d.technique + " is not on the solver's ladder");

    var givens = Int8Array.from(GRID);
    d.hide.forEach(function (i) { givens[i] = M.UNKNOWN; });
    var puzzle = { clues: { rows: ROWS.slice(), cols: COLS.slice() }, givens: givens };

    var weak = S.deduce(puzzle, { techniques: LADDER.slice(0, k), truth: Int8Array.from(GRID) });
    var full = S.deduce(puzzle, { techniques: LADDER.slice(0, k + 1), truth: Int8Array.from(GRID) });
    if (weak.violations.length || full.violations.length) bad(name + ": the solver is unsound on this board");

    d.settle.forEach(function (i) {
      if (weak.grid[i] !== M.UNKNOWN) {
        bad(name + ": cell " + label(i) + " already falls to the set BELOW " + d.technique);
      }
      if (full.grid[i] !== GRID[i]) {
        bad(name + ": " + d.technique + " does not force " + label(i) + " to " + GRID[i]);
      }
    });

    // the candidate sets the copy quotes out loud
    Object.keys(d.domains).forEach(function (key) {
      var i = Number(key);
      var got = S.maskValues(weak.domains[i]).join(",");
      var want = d.domains[key].join(",");
      if (got !== want) bad(name + ": " + label(i) + " is {" + got + "} before " + d.technique + ", not {" + want + "}");
    });
  });
}

function label(i) { return "r" + (M.rowOf(i) + 1) + "c" + (M.colOf(i) + 1); }

// -------------------------------------------------------------- the steps
/* The arc, in order: the three rules, three deductions the player makes, the
   technique ladder that grades the six tiers, then the chain. The chain stays
   last because it is still the most important thing the lesson teaches. */
var STEPS = [
  {
    key: "load", mode: "show", tag: "the load",
    title: "The edge number is a load",
    body: "Not a count — a total. Read the <b>9</b> beside row 4: the stones in that row are " +
          "3, 2, 1 and 3, and they weigh 9 together. Every number around the edge works that way.",
    lit: function () { return CELL.load; }, litRow: 3
  },
  {
    key: "density", mode: "show", tag: "the count",
    title: "Four stones, three empties",
    body: "Always, in every row and every column. Row 4 again: four stones, and three cells " +
          "where nothing settled. Knowing a line is <b>full</b> is often worth more than knowing its load.",
    lit: function () { return [21, 22, 23, 24, 25, 26, 27]; }, litRow: 3
  },
  {
    key: "repulsion", mode: "show", tag: "repulsion",
    title: "Nothing touches its equal",
    body: "No two stones of the same weight may sit edge to edge. The <b>5</b> here has a 4 above it " +
          "and a 4 below it — and those two 4s never touch each other. Corners do not count.",
    lit: function () { return [CELL.repelOn].concat(CELL.repelNear); }
  },
  {
    key: "do-sum", mode: "play", tag: "your turn",
    title: "Read the load",
    body: "Row 3 carries a load of <b>9</b>, and the three stones you can see come to 5. " +
          "One cell is open. Pick its weight below, then tap it.",
    target: function () { return [CELL.sum]; },
    nudge: "9 − 5 = 4. Arm the 4 and tap the ringed cell."
  },
  {
    key: "do-density", mode: "play", tag: "your turn",
    title: "Count first",
    body: "Row 1 already shows four stones, and its load of <b>6</b> is already met. " +
          "So nothing can settle in the ringed cell. Arm the <b>×</b> key and mark it empty.",
    target: function () { return [CELL.dens]; },
    nudge: "The × key, at the right of the keypad, is how you say “empty”."
  },
  {
    key: "do-repel", mode: "play", tag: "your turn",
    title: "Let the neighbours decide",
    body: "Row 2's load is <b>12</b> and you can see a 4 and a 5, so the two ringed cells hold " +
          "3 between them: a 1 and a 2. The arithmetic cannot tell you which way round. " +
          "Look up and down instead — start with the left one. " +
          "(On a real board, <b>NOTES</b> in the tools row pencils possibilities like these " +
          "into a cell until you can prove one.)",
    target: function () { return CELL.rep; },
    nudge: "A 2 in the left cell would have a 2 above it and a 2 below it. So it is the 1.",
    after: {
      7: "That is it — a 2 there would touch a 2 above and a 2 below. Now finish the row.",
      8: "Solved, by pure deduction. Not one guess anywhere."
    }
  },

  // ------------------------------------------------------ the technique ladder
  {
    key: "ladder", mode: "ladder", tag: "the ladder",
    title: "Six tiers, four tools",
    body: "A tier is not a clue count. It is <b>which kind of thinking the board forces on you</b>. " +
          "Six tiers ride on four technique sets, so Silt and Shale are twins, and so are Slate and " +
          "Basalt — same tool, deeper deductions. What the generator proves about every single board " +
          "is narrow but exact: <b>it cannot be solved by the technique set below its tier</b>. " +
          "Nothing more is promised.",
    foot: "Harder tiers are not stingier. Over 200 boards a tier the givens barely move — 18.6 on " +
          "Topsoil, 16.5 on Shale, 18.5 on Slate — while the deduction rounds climb from 5.2 to 15.6. " +
          "A hard board is not a board with less on it. It is a board that demands a stronger tool. " +
          "The next four steps are those four tools, on this board."
  },
  {
    key: "tech-sums", mode: "tech", tag: "topsoil", demo: "sums",
    title: "Sums · one line at a time",
    body: "The whole of column 6 has been taken away, and pure arithmetic puts it back. " +
          "Row 4 already shows its three empties, so its last open cell has to be a stone; the row's " +
          "other three stones weigh 8 against a load of <b>9</b>, so it is a 1. No neighbours consulted, " +
          "no possibilities counted — just one line at a time. <b>Topsoil</b> never asks for more.",
    lead: "Column 6, by arithmetic alone."
  },
  {
    key: "tech-repulsion", mode: "tech", tag: "silt · shale", demo: "repulsion",
    title: "Repulsion · what the neighbours forbid",
    body: "Sums gets the three ringed cells to a coin flip and stops: each is <b>a 1 or a 2</b>. " +
          "The 2 already sitting at row 4, column 5 breaks the tie — nothing touches its equal, " +
          "so the cell beside it is the 1. That 1 forbids a 1 below, which forces a 2; that 2 forbids " +
          "a 2 beside it, which forces a 1. One stone, three cells, in a chain. " +
          "<b>Silt</b> and <b>Shale</b> both need this.",
    lead: "One forced stone, and the two it drags with it."
  },
  {
    key: "tech-parity", mode: "tech", tag: "slate · basalt", demo: "parity",
    title: "Parity · counting the possibilities",
    body: "Row 4 is stuck. Sums and neighbours together leave column 1 as <b>a 1 or a 3</b> and " +
          "column 5 as <b>a 2 or a 3</b>, and neither can go further. So stop looking at cells and " +
          "count <b>multisets</b> instead. The row still owes 5 across two stones — that is {1,4} or " +
          "{2,3}, and the only cell that could hold the 4 is the one that has to stay empty. " +
          "So the pair is exactly {2,3}, and only one open cell can still take a 2. " +
          "<b>Slate</b> and <b>Basalt</b> live here.",
    lead: "The line's possible weight sets, not its cells."
  },
  {
    key: "tech-intersection", mode: "tech", tag: "bedrock", demo: "intersection",
    title: "Intersection · two lines at once",
    body: "Row 7 needs <b>6</b> from its last two stones. The row alone allows 1+5, 2+4, 4+2 or 5+1 — " +
          "it cannot choose. The columns have cut those two cells to <b>a 2 or a 3</b> and " +
          "<b>a 3 or a 4</b>, and neither column can finish on its own either. Cross them: the row's " +
          "arrangements, filtered through what the columns have already ruled out, leave 2 then 4 — " +
          "3 and 3 makes 6, but they would be touching. Only <b>Bedrock</b> demands this.",
    lead: "Neither line alone. Both together."
  },

  // ----------------------------------------------------------------- the chain
  {
    key: "survival", mode: "chain", tag: "the chain",
    title: "What survives",
    body: "A stone survives only if it weighs <b>4 or more</b> and outweighs everything it touches. " +
          "It is meant to be rare — most of the core washes away."
  },
  {
    key: "seed", mode: "chain", tag: "the chain",
    title: "You choose one more",
    body: "One stone, any stone, earned or not. This is the only part of the chain you choose — " +
          "tap one on the board.",
  },
  {
    key: "rotate", mode: "chain", tag: "the chain",
    title: "It turns, and it waits",
    body: "The survivors and your seed rotate <b>90° clockwise</b> and are pre-placed in tomorrow's " +
          "board, weight-locked, as <b>bedrock stones</b>. Solve tomorrow and they turn again. " +
          "Nobody else's board looks like yours.",
  }
];

// ------------------------------------------------------------------ open
function open(handles) {
  api = handles;
  M = api.model;
  S = api.logic.solver;
  assertBoard();          // loud, before a single pixel is drawn

  /* Latched here, before anything is written, so completing THIS run does not
     unlock the middle of this same run. */
  returning = hasSeen();

  /* A real game instance over the fixed board — the same state machine the
     daily uses, so the lesson's board refuses exactly what a live board
     refuses, in exactly the same words. */
  TG = StrataGame.create(api.logic);
  step = 0;
  armed = null;
  seedPick = null;
  done = {};
  opened = true;
  resetBoard([]);
  api.show("tutor");
  render();
}

/* The one flag this file writes. See NOT-FIRST-TIME in the header. */
function hasSeen() {
  try { return !!(typeof Store !== "undefined" && Store.get(LESSON_KEY, null) || {}).seen; }
  catch (e) { return false; }
}
function markSeen() {
  try { if (typeof Store !== "undefined") Store.set(LESSON_KEY, { seen: true }); }
  catch (e) {}
}

/* Leaving, from any step, by any route. Nothing is half-finished afterwards:
   timers are dead, animations are off the DOM, and the next open() starts at
   step 0 with a clean board. */
function close() {
  clearTimeout(nudgeTimer);
  seq += 1;               // every pending settle/turn callback is now stale
  opened = false;
  var mini = document.getElementById("tutor-mini");
  if (mini) mini.classList.remove("preturn", "turning");
  markSeen();
  step = 0;
  armed = null;
  seedPick = null;
  done = {};
  TG = null;
  api.onExit();
}

// ---------------------------------------------------------------- render
function render() {
  clearTimeout(nudgeTimer);
  seq += 1;
  var mine = seq;
  var s = STEPS[step];
  var $ = function (id) { return document.getElementById(id); };

  $("tutor-tag").textContent = s.tag;
  $("tutor-count").textContent = (step + 1) + " / " + STEPS.length;
  $("tutor-title").textContent = s.title;
  $("tutor-body").innerHTML = s.body;
  $("tutor-foot").hidden = !s.foot;
  $("tutor-foot").innerHTML = s.foot || "";
  $("tutor-nudge").hidden = true;
  $("tutor-nudge").textContent = "";

  var onBoard = s.mode === "show" || s.mode === "play" || s.mode === "tech";
  $("tutor-board").hidden = !onBoard;
  $("tutor-keys").hidden = s.mode !== "play";
  $("tutor-ladder").hidden = s.mode !== "ladder";
  $("tutor-mini").hidden = s.mode !== "chain";
  $("tutor-say").hidden = s.key !== "survival";
  $("tutor-back").disabled = step === 0;

  /* The returning player's affordance: one line saying Next is live, shown on
     exactly the steps where a first-timer would be held. */
  var held = s.mode === "play" || s.key === "survival" || s.key === "seed";
  $("tutor-replay").hidden = !(returning && held);

  var next = $("tutor-next");
  next.hidden = false;
  next.disabled = false;
  next.textContent = step === STEPS.length - 1 ? "Cut my first core" : "Next";

  if (s.mode === "show") {
    // everything visible: this is a board being read, not solved
    resetBoard([]);
    drawBoard();
    highlight(s.lit(), s.litRow);
  } else if (s.mode === "play") {
    resetBoard(openCells());
    drawBoard();
    markTarget();
    api.makeKeypad($("tutor-keys"), function (v) { return armed === v; }, pick);
    // a first-timer earns this one; a returning player may watch it instead
    next.disabled = !returning && currentTarget() !== null;
    next.textContent = "Next";
    startNudge();
  } else if (s.mode === "ladder") {
    renderLadder($("tutor-ladder"));
  } else if (s.mode === "tech") {
    techStep(s, mine);
  } else {
    chainStep(s);
  }
}

/* Which of the three teaching cells are still open on a play step. */
function openCells() {
  return [CELL.sum, CELL.dens, CELL.rep[0], CELL.rep[1]].filter(function (i) { return !done[i]; });
}

/* `hide` is the list of cells to blank. Every other cell is a given, so the
   player can only act where the lesson is pointing. */
function resetBoard(hide) {
  var givens = Int8Array.from(GRID);
  (hide || []).forEach(function (i) { givens[i] = M.UNKNOWN; });
  TG.begin({
    tier: "topsoil", seed: 0,
    puzzle: { clues: { rows: ROWS.slice(), cols: COLS.slice() }, givens: givens },
    solution: Int8Array.from(GRID),
    bedrock: []
  }, { isDaily: false, dateKey: null });
  TG.pauseClock();        // the lesson is not timed and never will be
}

/* Which teaching cells the player has already filled — kept out of the game
   instance so stepping back and forth never un-does earned progress. */
var done = {};

function drawBoard() {
  api.renderBoardInto(document.getElementById("tutor-board"), TG, tapCell);
}

function boardEl() { return document.getElementById("tutor-board"); }

function highlight(indices, row, cols) {
  (indices || []).forEach(function (i) {
    var n = api.cellAt(i, boardEl());
    if (n) n.classList.add("lit");
  });
  var clues = boardEl().querySelectorAll(".clue");
  if (row !== undefined && row !== null) {
    // the row's own clue, so the number and the stones read as one thing
    var node = clues[1 + M.N + row];
    if (node) node.classList.add("lit");
  }
  (cols || []).forEach(function (c) {
    var node = clues[1 + c];
    if (node) node.classList.add("lit");
  });
}

function currentTarget() {
  var s = STEPS[step];
  if (!s.target) return null;
  var t = s.target();
  for (var k = 0; k < t.length; k++) if (!done[t[k]]) return t[k];
  return null;
}

function markTarget() {
  var s = STEPS[step];
  s.target().forEach(function (i) {
    if (done[i]) return;
    var n = api.cellAt(i, boardEl());
    if (n) n.classList.add("hintcell");
  });
}

// ------------------------------------------------------------- the player
function pick(v) {
  armed = (armed === v) ? null : v;
  api.paintKeypad(document.getElementById("tutor-keys"), function (x) { return armed === x; });
}

function tapCell(i, node) {
  var s = STEPS[step];
  if (s.mode !== "play") return;
  var t = s.target();
  if (t.indexOf(i) < 0 || done[i]) {
    api.flash(node, "refuse", 220);
    api.sound.play("invalid");
    say("Stay with the ringed cell for now.");
    return;
  }
  if (armed === null) {
    api.flash(node, "shake", 200);
    api.sound.play("invalid");
    say("Arm a weight on the keypad first — or the × key for an empty.");
    return;
  }

  // the real state machine decides. An illegal move is refused by the rules,
  // with the rules' own words; a legal-but-wrong one is lifted straight back
  // off the board, because a lesson should not let you walk away with it.
  var res = TG.place(i, armed);
  if (!res.ok) {
    api.flash(node, "shake", 200);
    api.sound.play("invalid");
    say(api.refuseText(res.code));
    return;
  }
  if (armed !== GRID[i]) {
    var why = wrongWhy(i, armed);
    TG.undo();
    api.paintCell(node, i, TG.state.board[i], TG);
    node.classList.add("hintcell");
    api.flash(node, "shake", 200);
    api.sound.play("invalid");
    say(why);
    return;
  }

  done[i] = true;
  armed = null;
  api.paintCell(node, i, TG.state.board[i], TG);
  api.flash(node, "press", 130);
  api.sound.play("place");
  api.paintKeypad(document.getElementById("tutor-keys"), function (x) { return armed === x; });
  api.repaintClues(boardEl(), TG);

  var rest = currentTarget();
  if (rest === null) {
    clearTimeout(nudgeTimer);
    api.sound.play("line");
    document.getElementById("tutor-next").disabled = false;
    document.getElementById("tutor-next").textContent = "Next";
    if (s.after && s.after[i]) say(s.after[i], true);
    else say("Right.", true);
  } else {
    markTarget();
    if (s.after && s.after[i]) say(s.after[i], true);
    startNudge();
  }
}

/* Why a legal-but-wrong value is still wrong, in the board's own arithmetic. */
function wrongWhy(i, v) {
  var r = M.rowOf(i), c = M.colOf(i);
  var rowSum = 0, rowStones = 0, colSum = 0, colStones = 0, k;
  for (k = 0; k < M.N; k++) {
    var rv = k === c ? v : TG.state.board[M.idx(r, k)];
    if (rv > 0) { rowSum += rv; rowStones++; }
    var cv = k === r ? v : TG.state.board[M.idx(k, c)];
    if (cv > 0) { colSum += cv; colStones++; }
  }
  if (v === 0 && rowStones < M.STONES_PER_LINE) {
    return "Row " + (r + 1) + " would be left with only " + rowStones + " stones, and every row holds four.";
  }
  if (v > 0 && rowSum !== ROWS[r]) {
    return "Row " + (r + 1) + " would come to " + rowSum + " — its load is " + ROWS[r] + ".";
  }
  if (v > 0 && colSum !== COLS[c]) {
    return "Column " + (c + 1) + " would come to " + colSum + " — its load is " + COLS[c] + ".";
  }
  return "Close, but not that one.";
}

function say(text, good) {
  var n = document.getElementById("tutor-nudge");
  n.textContent = text;
  n.classList.toggle("good", !!good);
  n.hidden = false;
}

function startNudge() {
  clearTimeout(nudgeTimer);
  var s = STEPS[step];
  if (!s.nudge) return;
  nudgeTimer = setTimeout(function () {
    if (!opened || STEPS[step] !== s) return;
    say(s.nudge);
  }, 14000);
}

// ------------------------------------------------------------- the ladder
/* The six tiers in the game's own tier rows — the same markup, colours and
   technique labels as the core log, grouped so the four sets are visible. */
function renderLadder(host) {
  host.innerHTML = "";
  var LABEL = {
    // the core log's own words for these, verbatim — one vocabulary, not two
    sums: "sums only", repulsion: "+ repulsion", parity: "+ parity", intersection: "intersection"
  };
  var prev = null;
  M.TIERS.forEach(function (t, i) {
    var row = api.el("div", "tier ladderrow");
    if (t.technique === prev) row.classList.add("twin");
    prev = t.technique;
    var bar = api.el("span", "bar");
    bar.style.background = i < 5 ? "var(--w" + (i + 1) + ")" : "var(--accent)";
    row.appendChild(bar);
    row.appendChild(api.el("span", "nm", t.name));
    row.appendChild(api.el("span", "tech", LABEL[t.technique] || t.technique));
    host.appendChild(row);
  });
}

// ---------------------------------------------------- the technique demos
/* Blank the demo's cells, light the lines the argument is about, then let the
   technique put the stones back one at a time. Nothing here decides anything:
   assertDemos() has already made the solver prove every cell in `settle`. */
function techStep(s, mine) {
  var d = DEMOS[s.demo];
  resetBoard(d.hide);
  drawBoard();
  highlight(d.lit, d.litRow, d.litCols);
  say(s.lead);
  settleRun(d.settle.slice(), mine, 460, null);
}

/* Drop `list` onto the board one cell at a time, through the real state
   machine, keeping any lit ring the step put there. */
function settleRun(list, mine, gap, onDone) {
  if (!list.length) { if (onDone) onDone(); return; }
  var i = list.shift();
  setTimeout(function () {
    if (!opened || seq !== mine) return;
    var node = api.cellAt(i, boardEl());
    var lit = node && node.classList.contains("lit");
    TG.place(i, GRID[i]);
    if (node) {
      api.paintCell(node, i, TG.state.board[i], TG);
      if (lit) node.classList.add("lit");
      api.flash(node, "press", 130);
    }
    api.sound.play("place");
    api.repaintClues(boardEl(), TG);
    settleRun(list, mine, gap, onDone);
  }, gap);
}

// ---------------------------------------------------------------- the chain
function chainStep(s) {
  var $ = function (id) { return document.getElementById(id); };
  var mini = $("tutor-mini");
  var grid = Int8Array.from(GRID);

  if (s.key === "survival") {
    $("tutor-next").disabled = !returning;
    // the REAL survival sequence, from js/ui.js — same timings, same sounds
    api.survivalInto({
      grid: grid, survivors: SURVIVORS.slice(),
      board: mini, say: $("tutor-say"),
      instant: false,
      onDone: function () { if (opened) $("tutor-next").disabled = false; }
    });
    return;
  }

  if (s.key === "seed") {
    var set = {};
    SURVIVORS.forEach(function (i) { set[i] = true; });
    api.renderPickMini(mini, grid, set, seedPick, function (i) {
      seedPick = i;
      api.sound.play("place");
      chainStep(s);
      $("tutor-next").disabled = false;
      sayPick(i, grid);
    });
    $("tutor-next").disabled = seedPick === null && !returning;
    if (seedPick === null) say("Nothing chosen yet. Tap any stone.");
    return;
  }

  // rotate — pure preview arithmetic from the model; nothing is committed
  var prev = M.nextBedrock(grid, seedPick, []);
  var keep = {}, gone = {};
  prev.bedrock.forEach(function (b) { keep[M.idx(b.r, b.c)] = b; });
  prev.capped.forEach(function (b) { gone[M.idx(b.r, b.c)] = b; });

  /* Turn it in front of them. The slab starts in the coordinates the player
     just left it in, rotates a quarter turn clockwise, and settles as the
     rotated bedrock — because "rotated 90° clockwise" is the one sentence in
     this game that has to be watched rather than read. It turns as one slab;
     the numerals come upright again when it settles. */
  var pre = {};
  var carried = SURVIVORS.slice();
  if (seedPick !== null && carried.indexOf(seedPick) < 0) carried.push(seedPick);
  carried.forEach(function (i) {
    pre[i] = { r: M.rowOf(i), c: M.colOf(i), w: grid[i], age: 1 };
  });
  api.renderBedMini(mini, pre, {});
  mini.classList.add("preturn");
  say("Watch the slab turn.");

  var mine = seq;
  void mini.offsetWidth;                       // commit the start state
  requestAnimationFrame(function () {
    if (!opened || seq !== mine) return;
    mini.classList.add("turning");
    api.sound.play("mineral");
  });
  setTimeout(function () {
    if (!opened || seq !== mine) return;
    mini.classList.remove("preturn", "turning");
    api.renderBedMini(mini, keep, gone);
    api.sound.play("line");
    say(prev.bedrock.length + " stones waiting: " + SURVIVORS.length +
        " that survived, plus the one you chose.", true);
  }, 780);
}

function sayPick(i, grid) {
  var p = M.rotatePoint(M.rowOf(i), M.colOf(i));
  say("The " + grid[i] + " at row " + (M.rowOf(i) + 1) + ", column " + (M.colOf(i) + 1) +
      " — after the turn it lands at row " + (p.r + 1) + ", column " + (p.c + 1) + ".", true);
}

// ------------------------------------------------------------------ nav
/* Next. On a first run the interactive steps have already been earned by the
   time this is reachable. On a later run they may not have been, so Next plays
   the step out first — the answer settles on the board, then we move on. It is
   a demonstration, never a blank skip. */
function next() {
  var s = STEPS[step];

  if (returning && s.mode === "play" && currentTarget() !== null) {
    demoPlayStep(s);
    return;
  }
  if (returning && s.key === "seed" && seedPick === null) {
    demoSeed();
    return;
  }
  advance();
}

function advance() {
  if (step >= STEPS.length - 1) { finish(); return; }
  step += 1;
  render();
}

/* Play an unfinished interactive step for a returning player, then advance. */
function demoPlayStep(s) {
  clearTimeout(nudgeTimer);
  var btn = document.getElementById("tutor-next");
  btn.disabled = true;
  var mine = seq;
  var list = s.target().filter(function (i) { return !done[i]; });
  list.forEach(function (i) { done[i] = true; });
  say("Watch it land.");
  settleRun(list.slice(), mine, 380, function () {
    if (!opened || seq !== mine) return;
    api.sound.play("line");
    btn.disabled = false;
    advance();
  });
}

function demoSeed() {
  seedPick = DEMO_SEED;
  api.sound.play("place");
  chainStep(STEPS[step]);
  sayPick(seedPick, Int8Array.from(GRID));
  var mine = seq;
  setTimeout(function () {
    if (!opened || seq !== mine || STEPS[step].key !== "seed") return;
    advance();
  }, 900);
}

function back() {
  if (step === 0) return;
  step -= 1;
  render();
}

function finish() {
  // nothing is written here except the "seen it" flag. See the header.
  close();
}

function wire() {
  document.getElementById("tutor-next").addEventListener("click", next);
  document.getElementById("tutor-back").addEventListener("click", back);
  document.getElementById("tutor-skip").addEventListener("click", close);
}

document.addEventListener("DOMContentLoaded", wire);

var API = {
  open: open, close: close, STEPS: STEPS, DEMOS: DEMOS,
  GRID: GRID, ROWS: ROWS, COLS: COLS, SURVIVORS: SURVIVORS, LESSON_KEY: LESSON_KEY
};
root.StrataTutorial = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
return API;
})(typeof globalThis !== "undefined" ? globalThis : this);
