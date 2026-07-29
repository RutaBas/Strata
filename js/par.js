"use strict";

/* Par time — one formula, every consumer.

   STRATA has no campaign, so par is not baked into a level table: the daily and
   any replay compute it at runtime from the board actually generated. It still
   lives in its own file because two things need to agree — the win handler that
   awards the third stone, and any future tool that wants to reason about
   difficulty — and a par that disagreed with itself would make the same board
   worth different stars in different places.

   Deliberately FORGIVING. Par derived from how fast a board CAN be solved turns
   the third stone into a speedrun, and STRATA is a game you are supposed to sit
   and think about. This is calibrated so an unhurried, focused solve lands
   comfortably under par — the stone you lose should come from a hint or a
   mistake, never from thinking.

   Two inputs:
     tierKey     which technique the board demands, i.e. how much of the time
                 goes on reasoning rather than typing
     openCells   how many cells the player actually has to fill. Bedrock and
                 givens are free, so a board inherited from a long chain is
                 genuinely shorter and its par shortens with it. */

(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StrataPar = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  /* Seconds of unhurried thinking per open cell, by tier. The ladder is graded
     by required technique, so the step from Shale to Slate (repulsion → parity)
     is bigger than the step from Silt to Shale (same technique, longer chain of
     it) — the numbers follow the ladder rather than a straight line. */
  var SEC_PER_CELL = {
    topsoil: 4.0,
    silt: 5.0,
    shale: 6.5,
    slate: 8.0,
    basalt: 9.5,
    bedrock: 11.0
  };

  /* Headroom on top of that unhurried pace. This is the forgiveness: at 1.6x a
     player who reads every clue twice, pauses, and comes back to it still beats
     par. */
  var HEADROOM = 1.6;

  /* No board should ever demand a sub-two-minute solve, however much bedrock
     it inherited. */
  var FLOOR_MS = 120000;

  function parMsFor(tierKey, openCells) {
    var per = SEC_PER_CELL[tierKey] || SEC_PER_CELL.shale;
    var cells = Math.max(1, openCells || 0);
    var raw = cells * per * HEADROOM * 1000;
    return Math.round(Math.max(FLOOR_MS, raw) / 1000) * 1000;
  }

  /* Count the cells the player has to decide: everything not already given.
     Takes the puzzle's givens array (UNKNOWN === -1 where open). */
  function openCellsOf(givens) {
    var n = 0;
    for (var i = 0; i < givens.length; i++) if (givens[i] === -1) n++;
    return n;
  }

  function parForPuzzle(tierKey, givens) {
    return parMsFor(tierKey, openCellsOf(givens));
  }

  return {
    parMsFor: parMsFor,
    openCellsOf: openCellsOf,
    parForPuzzle: parForPuzzle,
    SEC_PER_CELL: SEC_PER_CELL,
    HEADROOM: HEADROOM,
    FLOOR_MS: FLOOR_MS
  };
});
