"use strict";

/* STRATA — the DAY BOUNDARY, end to end, headlessly.
   Run: node test/chain.test.js

   WHY THIS FILE EXISTS. An installed PWA is RESUMED, never reloaded. ui.js
   used to read the date once at boot and never again, so after midnight it
   still held yesterday's key. `chain.lastSolvedDate !== today` then went
   FALSE, the new day's board was silently demoted to free play, the chain
   stopped advancing and Meta.recordWin was never called with mode "daily".
   Nothing looked broken — the app just quietly stopped counting. That is a
   failure mode you cannot spot by playing for five minutes, so it is pinned
   here instead.

   The tests drive the REAL ui.js against a minimal DOM shim and the real
   model / generator / game / meta library. The only concession to testing is
   UI._test.setClock — a seam ui.js already routes every "what day is it now?"
   through. No library is patched. */

const path = require("path");

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { fails++; console.log(`  FAIL  ${name}${extra ? "  — " + extra : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The shim and the app boot live in test/dom-shim.js — test/strike.test.js
   drives the same seam. Nothing about them changed when they moved. */
const { bootApp } = require(path.join(__dirname, "dom-shim.js"));

/* Play the currently-open board to completion through the REAL tap path:
   arm a weight on the keypad (document keydown), then click the cell node. */
async function solveOpenBoard(app) {
  const { sandbox, dom, T } = app;
  const M = sandbox.StrataModel;
  const G = T.game();
  const board = dom.document.getElementById("board");
  // the keypad TOGGLES, so pressing an already-armed weight disarms it —
  // mirror that here rather than pressing blindly
  let armed = null;
  for (let i = 0; i < M.CELLS; i++) {
    if (G.state.board[i] !== M.UNKNOWN) continue;
    const want = G.state.solution[i];
    if (armed !== want) { dom.document.dispatch("keydown", { key: String(want) }); armed = want; }
    const cell = board.querySelectorAll(`[data-i="${i}"]`)[0];
    if (!cell) throw new Error("no cell node for index " + i);
    cell.click();
    if (G.state.board[i] !== want) {
      throw new Error("tap did not land at " + i + ": wanted " + want +
        ", board has " + G.state.board[i] + ", refusal " +
        JSON.stringify(G.refusal(i, want)));
    }
  }
  if (G.state.phase !== "won") throw new Error("board did not reach 'won' (phase " + G.state.phase + ")");
  await sleep(900);              // the solve beat before the win screen
}

/* Commit the seed stone: this is where the chain actually advances. */
async function commitChain(app) {
  const { sandbox, dom, T } = app;
  const M = sandbox.StrataModel;
  const G = T.game();
  dom.document.getElementById("btn-to-seed").click();     // -> the seed screen
  const mini = dom.document.getElementById("seed-board");
  // the first stone cell on the mini board; empties carry no listener
  let picked = false;
  for (let i = 0; i < M.CELLS; i++) {
    if (G.state.solution[i] > 0) { mini.children[i].click(); picked = true; break; }
  }
  if (!picked) throw new Error("no pickable seed stone on the board");
  dom.document.getElementById("btn-set-stone").click();
  await sleep(1800);
}

async function startDaily(app, tier) {
  app.T.startTier(tier || "topsoil");
  for (let i = 0; i < 400; i++) {
    await sleep(25);
    if (app.T.game() && app.T.game().state.phase === "playing") return;
  }
  throw new Error("board never opened");
}

// ------------------------------------------------------------------- tests
async function run() {
  console.log("\nSTRATA — day boundary / chain across a resume\n");

  // ============================================ 1. midnight without a reload
  {
    const app = bootApp();
    let fake = new Date(2026, 6, 20, 21, 0, 0);       // 2026-07-20, evening
    app.T.setClock(() => fake);
    app.sandbox.UI.boot();
    await sleep(50);

    ok("boots onto the home screen", app.T.screen() === "home", "screen " + app.T.screen());
    ok("day N: today is the injected date", app.T.today() === "2026-07-20", app.T.today());

    await startDaily(app);
    ok("day N board is DAILY", app.T.game().state.isDaily === true);
    ok("day N board is stamped 2026-07-20", app.T.game().state.dateKey === "2026-07-20");
    await solveOpenBoard(app);
    await commitChain(app);
    ok("day N: chain advances to 1", app.T.chain().length === 1, "len " + app.T.chain().length);

    const dailyWins = () => app.winCalls.filter((c) => c.mode === "daily");
    ok("day N: Meta.recordWin called with mode daily", dailyWins().length === 1,
       JSON.stringify(app.winCalls.map((c) => c.mode)));

    // --- midnight passes while the app sits open. NO reload. ---
    fake = new Date(2026, 6, 21, 0, 30, 0);           // 2026-07-21, 00:30
    app.dom.document.hidden = true;
    app.dom.document.dispatch("visibilitychange", {});
    app.dom.document.hidden = false;
    app.dom.document.dispatch("visibilitychange", {}); // ← the resume path

    ok("resume re-reads the date", app.T.today() === "2026-07-21",
       "today is still " + app.T.today() + " — the app is stuck on yesterday");

    await startDaily(app);
    ok("day N+1 board is DAILY, not free play", app.T.game().state.isDaily === true,
       "isDaily=" + app.T.game().state.isDaily);
    ok("day N+1 board is stamped 2026-07-21", app.T.game().state.dateKey === "2026-07-21",
       app.T.game().state.dateKey);
    await solveOpenBoard(app);
    await commitChain(app);
    ok("day N+1: chain advances to 2", app.T.chain().length === 2, "len " + app.T.chain().length);
    ok("day N+1: Meta.recordWin called again as daily", dailyWins().length === 2,
       JSON.stringify(app.winCalls.map((c) => c.mode)));
    ok("day N+1: recordWin carries the new dateKey",
       dailyWins()[1].dateKey === "2026-07-21", dailyWins()[1].dateKey);
  }

  // ================================== 2. MUTATION CHECK — the test bites
  /* Stub the date refresh out (exactly the pre-fix behaviour: `today` frozen
     at boot) and confirm the assertions above go RED. A regression test for an
     invisible bug is worthless unless it is proven to fail without the fix. */
  {
    // the actual pre-fix code: checkDate() neutered, so `today` is whatever
    // boot() read and nothing ever moves it
    const app = bootApp((src) =>
      src.replace("function checkDate() {", "function checkDate() { return false;"));
    let fake = new Date(2026, 6, 20, 21, 0, 0);
    app.T.setClock(() => fake);
    app.sandbox.UI.boot();
    await sleep(50);
    await startDaily(app);
    await solveOpenBoard(app);
    await commitChain(app);
    const chainBefore = app.T.chain().length;
    ok("mutation: day N still works (the mutation is narrow)", chainBefore === 1,
       "len " + chainBefore);

    fake = new Date(2026, 6, 21, 0, 30, 0);
    app.dom.document.hidden = true;
    app.dom.document.dispatch("visibilitychange", {});
    app.dom.document.hidden = false;
    app.dom.document.dispatch("visibilitychange", {});
    app.dom.window.dispatch("pageshow", {});
    app.dom.window.dispatch("focus", {});

    ok("mutation: without the refresh, today stays stale",
       app.T.today() === "2026-07-20", "today " + app.T.today());
    await startDaily(app);
    ok("mutation: the new day's board IS silently demoted to free play",
       app.T.game().state.isDaily === false,
       "isDaily=" + app.T.game().state.isDaily + " — the mutation did not reproduce the bug");
    await solveOpenBoard(app);
    const freeWins = app.winCalls.filter((c) => c.mode === "free");
    ok("mutation: the solve is logged as free play — no record, no chain",
       freeWins.length === 1 && app.T.chain().length === chainBefore,
       "free=" + freeWins.length + " chain=" + app.T.chain().length);
  }

  // ============================== 3. a board started on N, finished on N+1
  {
    const app = bootApp();
    let fake = new Date(2026, 6, 20, 23, 50, 0);
    app.T.setClock(() => fake);
    app.sandbox.UI.boot();
    await sleep(50);
    await startDaily(app);
    ok("board opened on the 20th is stamped 2026-07-20",
       app.T.game().state.dateKey === "2026-07-20");

    fake = new Date(2026, 6, 21, 0, 5, 0);            // midnight, mid-board
    app.dom.window.dispatch("focus", {});
    ok("the open board is NOT yanked", app.T.screen() === "play", "screen " + app.T.screen());
    ok("the rollover is deferred until the player is back home", app.T.pending() === true);
    ok("the board keeps its own day", app.T.game().state.dateKey === "2026-07-20");

    await solveOpenBoard(app);
    await commitChain(app);
    ok("finished after midnight, it records against the day it was STARTED",
       app.T.chain().lastSolvedDate === "2026-07-20", app.T.chain().lastSolvedDate);
    ok("the chain advanced exactly once", app.T.chain().length === 1, "len " + app.T.chain().length);
    ok("the deferred lifecycle caught up on return home",
       app.T.pending() === false && app.T.today() === "2026-07-21",
       "pending=" + app.T.pending() + " today=" + app.T.today());

    // and the 21st's own daily is still there to be played
    await startDaily(app);
    ok("the 21st's daily is still available and still daily",
       app.T.game().state.isDaily === true && app.T.game().state.dateKey === "2026-07-21");
    await solveOpenBoard(app);
    await commitChain(app);
    ok("the chain then reaches 2", app.T.chain().length === 2, "len " + app.T.chain().length);
  }

  // ========================================= 4. a real gap breaks the chain
  {
    const app = bootApp();
    let fake = new Date(2026, 6, 20, 21, 0, 0);
    app.T.setClock(() => fake);
    app.sandbox.UI.boot();
    await sleep(50);
    await startDaily(app);
    await solveOpenBoard(app);
    await commitChain(app);
    ok("chain at 1 before the gap", app.T.chain().length === 1);

    fake = new Date(2026, 6, 23, 9, 0, 0);            // two clear days missed
    app.dom.window.dispatch("pageshow", {});

    ok("the break notice is shown on resume", app.T.screen() === "break",
       "screen " + app.T.screen());
    // ui.js breaks the sentence onto two lines with a <br>; the words must be
    // the model's, verbatim
    const msg = app.dom.document.getElementById("break-msg").innerHTML
      .replace(/<br\s*\/?>/g, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    ok('the message is exactly "Chain broken at 1. Starting again."',
       msg === "Chain broken at 1. Starting again.", JSON.stringify(msg));
    ok("the chain is reset to 0 and the bedrock cleared",
       app.T.chain().length === 0 && (app.T.chain().bedrock || []).length === 0);
    ok("the longest chain survives the break", app.T.chain().longest === 1);
  }

  // ============================ 5. the 60s idle poll also catches midnight
  {
    const app = bootApp();
    let fake = new Date(2026, 6, 20, 23, 59, 0);
    app.T.setClock(() => fake);
    app.sandbox.UI.boot();
    await sleep(50);
    fake = new Date(2026, 6, 21, 0, 0, 30);
    ok("sitting idle on home, checkDate rolls the day over",
       app.T.checkDate() === true && app.T.today() === "2026-07-21", app.T.today());
    ok("and a second call is a no-op", app.T.checkDate() === false);
  }

  console.log(fails ? `\n${fails} FAILED\n` : "\nall day-boundary checks passed\n");
  process.exit(fails ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
