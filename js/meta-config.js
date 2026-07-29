"use strict";

/* Mounts the shared meta-layer for STRATA.

   SCOPE. STRATA is a TRUE DAILY game — one chain-advancing board per calendar
   day, at a tier the player picks — so there is deliberately NO campaign here:
   no level table, no per-level stars, no unlock gating. Only the parts of the
   library that fit a daily game are mounted:

     · daily      streak, calendar and per-day history (DISPLAY ONLY)
     · records    personal bests, averages and improvement trend per tier
     · rank       the rank badge, from a local par-relative curve

   THE CHAIN IS NOT THE STREAK. model.js owns the chain — the bedrock you
   inherit, the rotation, the cap, and the "Chain broken at N" notice — and
   nothing in this file may gate or alter it. The meta daily layer is a second,
   parallel record of which days were solved, used for the streak bar, the
   calendar and the records panel. If the two ever disagree the chain wins; it
   is the one with a rule attached.

   DAY BOUNDARY. daily.js works in UTC so that a future leaderboard means the
   same thing everywhere. STRATA's chain runs on the player's LOCAL calendar
   (model.dateKey), which is the promise the game makes on the home screen. So
   the clock handed to the library is shifted by the local offset: the library's
   UTC day arithmetic then lands on exactly the same day as model.dateKey, and
   one player never sees two different "todays".

   KEY PREFIX. The library writes "<prefix>:<name>". Our own keys are already
   strata:save / chain / stats / settings / history / seen, so prefix "strata"
   shares the namespace without colliding with any of them — which is what we
   want: one clear() wipes the whole game, and nothing already saved is
   orphaned under a second prefix. */

var Meta = (function () {

  /* The six Hardness tiers, as tier records for records/bests only. No
     `levels`, no `requires` — a tier with no requirement is always open, so
     mounting this cannot introduce campaign gating by accident. */
  var TIER_DEFS = [
    { key: "topsoil", name: "Topsoil", technique: "sums only" },
    { key: "silt", name: "Silt", technique: "+ repulsion" },
    { key: "shale", name: "Shale", technique: "+ repulsion" },
    { key: "slate", name: "Slate", technique: "+ parity" },
    { key: "basalt", name: "Basalt", technique: "+ parity" },
    { key: "bedrock", name: "Bedrock", technique: "intersection" }
  ];

  /* A representative board is ~30 open cells, so the tier's mid time is par at
     that size. Curves are par-relative and say so (rank.js reports
     source:"local") — they model "fast for this tier", not a real population. */
  function curveFor(tierKey) {
    var mid = StrataPar.parMsFor(tierKey, 30);
    return [
      [Math.round(mid * 0.35), 3],
      [Math.round(mid * 0.55), 12],
      [Math.round(mid * 0.80), 30],
      [Math.round(mid * 1.00), 50],
      [Math.round(mid * 1.45), 75],
      [Math.round(mid * 2.30), 94]
    ];
  }

  var curves = {};
  TIER_DEFS.forEach(function (t) { curves[t.key] = curveFor(t.key); });

  /* Three stones, not three stars — rendered as filled cells in meta-ui.js,
     because STRATA already has a vocabulary for "a thing worth having".
     Forgiving by construction: only a hint or a mistake can cost you the second
     stone, and par (js/par.js) is generous enough that thinking never costs the
     third. */
  function stonesFor(res, par) {
    var blemishes = (res.hints || 0) + (res.mistakes || 0);
    // Clean and inside par: everything.
    if (blemishes === 0 && par && res.ms <= par) return 3;
    // One slip — a single hint OR a single wrong stone — costs exactly one
    // stone, and so does being clean but over par. The library's default would
    // drop straight to one for any hint at all, which punishes asking for help
    // as hard as playing badly.
    if (blemishes <= 1) return 2;
    return 1;
  }

  /* The library's clock, shifted so its UTC day matches the player's local
     calendar day. Recomputed per call so it stays correct across a DST change
     or a device that travels. */
  function localNow() {
    var t = Date.now();
    return t - new Date(t).getTimezoneOffset() * 60000;
  }

  var meta = GameMeta.create({
    id: "strata",
    prefix: "strata",
    tiers: TIER_DEFS,
    curves: curves,
    now: localNow,
    starsFor: stonesFor,
    daily: {
      /* No freezes. The chain-break screen is deliberately undramatic and
         offers nothing to buy or spend; a freeze in the parallel streak would
         quietly contradict that. */
      freezes: { max: 0, earnEvery: 9999 },
      /* The tier is the player's choice each day, so there is no fixed plan —
         the plan just carries the date through. */
      plan: function (day, dateKey) {
        return { day: day, dateKey: dateKey, tier: null, index: day };
      }
    }
  });

  meta.tierDefs = TIER_DEFS;
  meta.stonesFor = stonesFor;

  /* ------------------------------------------------------------- migration
     Existing players already have strata:stats (per-tier bests) and
     strata:history (every solved daily). Both predate the meta layer, so seed
     the library from them once rather than starting everyone at zero.

     store.migrate() is idempotent and records its version even when the source
     data is absent, so this runs exactly once per install either way. */
  function migrate() {
    var store = meta.store;

    store.migrate("records", 1, function (existing) {
      if (existing) return undefined;                 // already populated
      var stats = store.getRaw("strata:stats", null);
      if (!stats || !stats.byTier) return undefined;
      var state = { v: 1, tiers: {} };
      Object.keys(stats.byTier).forEach(function (key) {
        var t = stats.byTier[key];
        if (!t || !t.n) return;
        state.tiers[key] = {
          wins: t.n,
          bestMs: t.best || 0,
          worstMs: t.last || t.best || 0,
          totalMs: t.totalMs || 0,
          recent: [t.prev, t.last].filter(function (x) { return !!x; })
        };
      });
      return Object.keys(state.tiers).length ? state : undefined;
    });

    store.migrate("daily", 1, function (existing) {
      if (existing) return undefined;
      var history = store.getRaw("strata:history", null);
      var chain = store.getRaw("strata:chain", null);
      if (!history || !history.length) return undefined;
      var days = {};
      history.forEach(function (e) {
        if (!e || !e.date) return;
        days[e.date] = {
          day: GameMeta.Daily.keyToDay(e.date),
          ms: e.ms || 0,
          stars: stonesFor({ ms: e.ms || 0, hints: e.hints || 0, mistakes: e.mistakes || 0 },
                           StrataPar.parMsFor(e.tier, 30)),
          tier: e.tier || null,
          hints: e.hints || 0,
          mistakes: e.mistakes || 0
        };
      });
      var last = history[history.length - 1];
      return {
        v: 1,
        streak: chain ? chain.length || 0 : 0,
        best: chain ? chain.longest || 0 : 0,
        lastDay: last && last.date ? GameMeta.Daily.keyToDay(last.date) : null,
        freezes: 0,
        freezeProgress: 0,
        totalSolved: Object.keys(days).length,
        days: days
      };
    });

    // Re-read whatever the migrations wrote, so the live objects agree with
    // the store rather than the blank state they were constructed with.
    meta.daily.state = store.get("daily", null) || meta.daily.state;
    meta.records.state = store.get("records", null) || meta.records.state;
  }

  migrate();

  return meta;
})();
