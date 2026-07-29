"use strict";

/* STRATA — persistence. Every key is namespaced `strata:`; there is no backend
   and no account. Nothing here knows the rules — it moves plain JSON. */

var Store = (function () {

  var P = "strata:";
  var K = {
    save: "save",          // the in-progress board (daily or free play)
    chain: "chain",        // model.newChain() shape
    stats: "stats",        // per-tier records + totals
    settings: "settings",  // sound / haptics / dark
    history: "history",    // completed boards, for the lineage view (next pass)
    seen: "seen"           // one-off notices (chain break acknowledgements)
  };

  function get(key, fallback) {
    try {
      var raw = localStorage.getItem(P + key);
      if (raw === null || raw === undefined) return fallback;
      var v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function set(key, value) {
    try { localStorage.setItem(P + key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  function remove(key) {
    try { localStorage.removeItem(P + key); } catch (e) {}
  }

  // ------------------------------------------------------------- settings
  function defaultSettings() {
    return { sound: true, haptics: true, dark: false };
  }
  function loadSettings() {
    var s = get(K.settings, null) || {};
    var d = defaultSettings();
    return {
      sound: typeof s.sound === "boolean" ? s.sound : d.sound,
      haptics: typeof s.haptics === "boolean" ? s.haptics : d.haptics,
      dark: typeof s.dark === "boolean" ? s.dark : d.dark
    };
  }
  function saveSettings(s) { set(K.settings, s); }

  // ----------------------------------------------------------------- save
  function loadSave() { return get(K.save, null); }
  function saveSave(s) { set(K.save, s); }
  function clearSave() { remove(K.save); }

  // ---------------------------------------------------------------- chain
  function loadChain(blank) { return get(K.chain, null) || blank; }
  function saveChain(c) { set(K.chain, c); }

  // ---------------------------------------------------------------- stats
  function defaultStats() {
    return { solved: 0, byTier: {}, deepestAge: 0, longestChain: 0, totalMs: 0 };
  }
  function loadStats() {
    var s = get(K.stats, null) || defaultStats();
    if (!s.byTier) s.byTier = {};
    return s;
  }
  function saveStats(s) { set(K.stats, s); }

  /* One solved DAILY board. Free play never reaches here.

     Per-tier bests, averages and trend are NOT kept here — those belong to the
     shared meta-layer (js/meta-config.js → Meta.records), and keeping a second
     copy is how two record screens start disagreeing. What stays here is only
     what the meta-layer has no concept of: how many cores have been cut, and
     the chain-specific numbers. */
  function recordResult(tierKey, ms) {
    var s = loadStats();
    s.solved += 1;
    s.totalMs += ms;
    saveStats(s);
    return { stats: s };
  }

  function noteChain(chain) {
    var s = loadStats();
    s.longestChain = Math.max(s.longestChain || 0, chain.longest || 0);
    var deep = 0;
    (chain.bedrock || []).forEach(function (b) { if (b.age > deep) deep = b.age; });
    s.deepestAge = Math.max(s.deepestAge || 0, deep);
    saveStats(s);
    return s;
  }

  // -------------------------------------------------------------- history
  /* Completed boards, most recent last. The lineage view (next pass) reads
     exactly this; it is stored now so there is data waiting for it. */
  function loadHistory() { return get(K.history, []) || []; }
  function pushHistory(entry) {
    var h = loadHistory();
    h.push(entry);
    if (h.length > 400) h = h.slice(h.length - 400);
    set(K.history, h);
    return h;
  }

  // ----------------------------------------------------------------- seen
  function seen(flag) { return !!(get(K.seen, {}) || {})[flag]; }
  function markSeen(flag) {
    var s = get(K.seen, {}) || {};
    s[flag] = true;
    set(K.seen, s);
  }

  return {
    PREFIX: P, KEYS: K, get: get, set: set, remove: remove,
    defaultSettings: defaultSettings, loadSettings: loadSettings, saveSettings: saveSettings,
    loadSave: loadSave, saveSave: saveSave, clearSave: clearSave,
    loadChain: loadChain, saveChain: saveChain,
    defaultStats: defaultStats, loadStats: loadStats, saveStats: saveStats,
    recordResult: recordResult, noteChain: noteChain,
    loadHistory: loadHistory, pushHistory: pushHistory,
    seen: seen, markSeen: markSeen
  };
})();
