"use strict";

/* STRATA — the DOM layer. Everything visual lives here; every rule lives in
   js/game.js and the logic core. This file never decides whether a move is
   legal, whether a line is done, or what tomorrow inherits — it asks. */

var UI = (function () {

  var L = null;      // {model, solver, generator, rng}
  var M = null;
  var G = null;      // the current game instance
  var settings = Store.loadSettings();
  var chain = null;
  var today = null;

  /* THE CLOCK SEAM. Everything in this file that asks "what day is it NOW?"
     goes through clock.now() — never `new Date()` inline — so test/chain.test.js
     can roll the date forward without a reload and prove the resume path.
     In the browser this is a plain new Date(). */
  var clock = { now: function () { return new Date(); } };
  var pendingRollover = false;   // the date moved while a board was open
  var currentScreen = null;      // which SCREENS entry is visible
  var dayTimer = null;           // the light idle poll for midnight
  var armed = null;  // weight armed on the keypad, or null for cycle mode
  var notesMode = false;   // the NOTES key: weights pencil instead of place
  var tickTimer = null;
  var recorded = false;
  var solvedInfo = null;
  var seedPick = null;
  var busy = false;

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  /* The empty-cell mark. ONE constant and ONE class, so the play board, the
     win and survival minis, the seed and rotation minis, the field lesson's
     board and the keypad's erase key can never drift apart. The size is set
     per surface in css/style.css (.cell.empty), not here. */
  var EMPTY_MARK = "×";

  var SCREENS = ["home", "drill", "play", "win", "seed", "break", "records", "lineage", "calendar", "tutor"];
  var hintIndex = null;   // the cell the live hint names, or null

  function show(name) {
    // a hint belongs to the board it was asked on; leaving the board ends it
    if (name !== "play") clearHint();
    currentScreen = name;
    SCREENS.forEach(function (s) {
      var node = $("screen-" + s);
      if (!node) return;
      if (s === name) { node.hidden = false; node.classList.remove("enter"); void node.offsetWidth; node.classList.add("enter"); }
      else node.hidden = true;
    });
    window.scrollTo(0, 0);
    var pad = $("screen-" + name) && $("screen-" + name).querySelector(".pad");
    if (pad) pad.scrollTop = 0;
  }

  function fmt(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function toast(msg, ms) {
    var t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.hidden = true; }, ms || 3200);
  }

  /* ------------------------------------------------------------- the hint
     A hint is a piece of reasoning, not a notification, so it is NOT on a
     timer: it stays until the player acts on it. It lives below the tools,
     never over the board, so the cell it names is always readable and always
     tappable — and that cell is ringed while the words are up, so the board
     and the sentence say the same thing. */
  function showHint(text, index) {
    clearHint();
    $("hint-text").textContent = text;
    $("hintbar").hidden = false;
    $("play-foot").hidden = true;      // the hint takes the footer's line
    if (index !== undefined && index !== null) {
      hintIndex = index;
      var n = cellAt(index);
      if (n) n.classList.add("hintcell");
    }
  }

  function clearHint() {
    var bar = $("hintbar");
    if (!bar || bar.hidden) { hintIndex = null; return; }
    bar.hidden = true;
    $("play-foot").hidden = false;
    if (hintIndex !== null) {
      var n = cellAt(hintIndex);
      if (n) n.classList.remove("hintcell");
    }
    hintIndex = null;
  }

  // ==================================================================== boot
  function boot() {
    applySettings();
    document.addEventListener("pointerdown", function once() {
      Sound.unlock();
      document.removeEventListener("pointerdown", once);
    }, { passive: true });

    show("drill");
    $("drill-msg").textContent = "Opening the core log…";
    $("btn-drill-cancel").hidden = true;

    StrataLogic.load().then(function (logic) {
      L = logic; M = logic.model;
      today = todayKey();
      Lineage.init(M);
      MetaUI.init({
        meta: Meta, model: M,
        hooks: { onReplay: openReplay }
      });
      wire();
      startDayWatch();
      openChain();
    }).catch(function (err) {
      $("drill-msg").textContent = "The core log will not open.";
      $("screen-drill").querySelector(".plainsub").textContent = String(err.message || err);
    });
  }

  /* ================================================== the day boundary =====
     `today` is STATE, not a constant, and this is the only place it moves.

     THE BUG THIS EXISTS TO KILL: an installed iOS PWA — and any long-lived
     tab — is RESUMED, never reloaded. Before this, `today` was read once at
     boot and never again, so after midnight the app still held yesterday's
     key. Then `chain.lastSolvedDate !== today` was FALSE, the new day's board
     was silently demoted to FREE PLAY, the chain stopped advancing, and
     Meta.recordWin was never called with mode "daily" — so per-tier bests
     stopped updating too. Both of Ruta's symptoms, one root cause. Nothing
     looked broken, which is exactly why it must stay tested.

     Every path back into the app calls checkDate(): visibilitychange (not
     hidden), pageshow (bfcache), window focus, and a light 60s poll while the
     app sits idle. */
  function todayKey() { return M.dateKey(clock.now()); }

  function startDayWatch() {
    if (dayTimer) clearInterval(dayTimer);
    // cheap: one string compare a minute, and only while actually on screen
    dayTimer = setInterval(function () {
      if (!document.hidden) checkDate();
    }, 60000);
  }

  /* -> true if the date moved. Safe to call from anywhere, any number of
     times; a no-op on the same day. */
  function checkDate() {
    if (!M) return false;                 // still booting
    var k = todayKey();
    if (k === today) return false;
    today = k;

    /* A BOARD BELONGS TO THE DAY IT WAS STARTED. We never yank one out from
       under the player at midnight. G.state.dateKey is stamped at begin() and
       never rewritten, setStone commits with THAT key, and model.recordSolve
       refuses a day it has already logged — so a board begun on the 29th and
       finished on the 30th counts for the 29th, exactly once, and the 30th's
       own daily is still there to be played afterwards. The chain lifecycle
       (break notice, home refresh) simply waits until the player is back on
       the core log, which is where all of it is visible anyway. */
    if (currentScreen !== "home") { pendingRollover = true; return true; }

    runDayLifecycle();
    return true;
  }

  /* The same work openChain() does, re-run against the NEW date: re-read the
     chain, re-run M.chainStatus, show the break notice if the chain died
     overnight, and re-render the home screen (count, pips, Continue, today's
     copy). Clearing the flag FIRST is what stops openChain()'s own goHome()
     from recursing back in here. */
  function runDayLifecycle() {
    pendingRollover = false;
    openChain();
  }

  function onResume() {
    if (!L) return;                        // boot has not finished
    checkDate();
    if (G && G.state.phase === "playing" && currentScreen === "play") {
      G.startClock(); startTick();
    }
  }

  /* Chain state on open. The board is NEVER gated on this — a break only
     changes what today inherits and what the header says. */
  function openChain() {
    chain = Store.loadChain(M.newChain());
    var st = M.chainStatus(chain, today);
    if (st.status === "broken") {
      var flag = "break:" + chain.lastSolvedDate + ":" + chain.length;
      var brokeAt = chain.length;
      var missed = chain.lastSolvedDate;
      // Persist the break: length and bedrock go, longest and brokenAt stay,
      // and lastSolvedDate clears so the notice is stated exactly once.
      chain = st.chain;
      chain.lastSolvedDate = null;
      Store.saveChain(chain);
      Store.clearSave();
      if (!Store.seen(flag)) {
        Store.markSeen(flag);
        showBreak(st.message, brokeAt, missed);
        return;
      }
    } else {
      chain = st.chain;
      Store.saveChain(chain);
    }
    goHome();
  }

  function showBreak(message, brokeAt, lastDate) {
    $("break-msg").innerHTML = escapeHTML(message).replace(". ", ".<br>");
    var d = lastDate ? new Date(lastDate + "T12:00:00") : null;
    $("break-sub").textContent = d
      ? "Your last core was " + d.toLocaleDateString(undefined, { day: "numeric", month: "long" }) +
        ". The stones you were carrying are gone — today's board starts bare."
      : "The stones you were carrying are gone — today's board starts bare.";
    $("break-longest").textContent = chain.longest
      ? "Your longest chain is still " + chain.longest + "."
      : "";
    show("break");           // no sound, no colour, no shake. Stated once.
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }

  // ==================================================================== home
  function goHome() {
    stopTick();
    // a rollover that waited for an open board catches up here, on the one
    // screen where the chain, the pips and today's copy are actually shown
    if (pendingRollover) { runDayLifecycle(); return; }
    show("home");
    renderHome();
    maybeHowTo();   // first launch only
  }

  function renderHome() {
    var d = clock.now();
    $("home-date").textContent = "Core log · " +
      d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

    $("chain-n").textContent = chain.length;
    $("chain-lab").textContent = chain.length === 1 ? "day chain" : "day chain";

    var pips = $("chain-pips");
    pips.innerHTML = "";
    var bed = (chain.bedrock || []).slice().sort(function (a, b) { return b.age - a.age; });
    for (var i = 0; i < M.BEDROCK_CAP; i++) {
      var p = el("span", "pip" + (bed[i] ? "" : " gone"), bed[i] ? String(bed[i].w) : "");
      if (bed[i]) p.title = "weight " + bed[i].w + ", age " + bed[i].age;
      pips.appendChild(p);
    }

    MetaUI.renderStreak($("streak-line"));

    var save = Store.loadSave();
    var cont = $("btn-continue");
    if (save && save.g) {
      var tier = M.tierByKey(save.g.tier);
      cont.hidden = false;
      cont.textContent = save.g.phase === "won"
        ? "Continue — " + (tier ? tier.name : save.g.tier) + ", finish the chain"
        : "Continue — " + (tier ? tier.name : save.g.tier) + ", " + fmt(save.g.elapsedMs || 0);
    } else {
      cont.hidden = true;
    }

    var solvedToday = chain.lastSolvedDate === today;
    var list = $("tier-list");
    list.innerHTML = "";
    M.TIERS.forEach(function (t, i) {
      var b = el("button", "tier");
      b.type = "button";
      var bar = el("span", "bar");
      bar.style.background = i < 5 ? "var(--w" + (i + 1) + ")" : "var(--accent)";
      b.appendChild(bar);
      b.appendChild(el("span", "nm", t.name));
      b.appendChild(el("span", "tech", techLabel(t.key)));
      b.addEventListener("click", function () { startTier(t.key); });
      list.appendChild(b);
    });

    // The lineage entry point is visibly locked before day 7, never hidden.
    var lin = $("btn-lineage");
    var days = chain.day || 0;
    var open = days >= Lineage.UNLOCK_DAY;
    lin.classList.toggle("locked", !open);
    lin.textContent = open ? "Lineage" : "Lineage · unlocks on day 7";
    lin.setAttribute("aria-disabled", open ? "false" : "true");

    var carried = (chain.bedrock || []).length;
    $("home-foot").textContent = solvedToday
      ? "today's core is cut · anything now is free play"
      : "today's core is yours alone · " +
        (carried ? carried + " stone" + (carried === 1 ? "" : "s") + " inherited" : "starting bare");
  }

  function techLabel(key) {
    return ({
      topsoil: "sums only", silt: "+ repulsion", shale: "+ repulsion",
      slate: "+ parity", basalt: "+ parity", bedrock: "intersection"
    })[key] || "";
  }

  // =============================================================== new board
  function startTier(tierKey, opts) {
    if (busy) return;
    /* Last line of defence: a tier tapped after the app sat open past midnight
       must cut TODAY's core, not yesterday's, and must count as daily. The
       date is refreshed in place and we carry on — the ONE case we stop for is
       an overnight chain break, whose notice must not be buried under a board. */
    if (checkDate() && currentScreen === "break") return;
    var o = opts || {};
    /* A calendar replay is always free play — it re-cuts that day's core from
       the same seed, and the chain does not move. */
    var isDaily = !o.replayDate && chain.lastSolvedDate !== today;
    var tier = M.tierByKey(tierKey);
    var seed = o.replayDate
      ? L.generator.dailySeed(o.replayDate, tierKey)
      : isDaily
        ? L.generator.dailySeed(today, tierKey)
        : (L.rng.randomSeed ? L.rng.randomSeed() : (Math.random() * 0xffffffff) >>> 0);
    var bedrock = isDaily ? (chain.bedrock || []) : [];

    busy = true;
    show("drill");
    $("drill-tier").textContent = "drilling · " + (tier ? tier.name : tierKey);
    $("drill-msg").textContent = isDaily ? "Cutting today's core…" : "Cutting a practice core…";
    $("screen-drill").querySelector(".plainsub").textContent =
      "Cutting a core that has exactly one reading.";
    $("btn-drill-cancel").hidden = false;
    var cancelled = false;
    $("btn-drill-cancel").onclick = function () { cancelled = true; busy = false; goHome(); };

    StrataGame.generateSliced(L, {
      tier: tierKey, seed: seed, bedrock: bedrock,
      // small slices keep the longest main-thread block well under half a
      // second, so the drilling animation never visibly stalls
      attemptsPerSlice: tierKey === "bedrock" ? 4 : 12,
      maxSlices: 80
    }, function (slice) {
      $("screen-drill").querySelector(".plainsub").textContent =
        slice < 3 ? "Cutting a core that has exactly one reading."
                  : "This seam is stubborn — cutting again (" + slice + ").";
    }).then(function (gen) {
      busy = false;
      if (cancelled) return;
      G = StrataGame.create(L);
      G.begin(gen, { isDaily: isDaily, dateKey: o.replayDate || today });
      recorded = false; solvedInfo = null; seedPick = null;
      armed = null;
      saveNow();
      enterPlay();
    }).catch(function (e) {
      busy = false;
      if (cancelled) return;
      $("drill-msg").textContent = "This core would not cut cleanly.";
      $("screen-drill").querySelector(".plainsub").textContent =
        String(e.message || e) + " — try another tier.";
      $("btn-drill-cancel").textContent = "Back";
    });
  }

  function resume() {
    var save = Store.loadSave();
    if (!save || !save.g) { goHome(); return; }
    G = StrataGame.create(L);
    if (!G.restore(save.g)) { Store.clearSave(); goHome(); return; }
    recorded = !!save.recorded;
    seedPick = G.state.seedIndex;
    armed = null;
    if (G.state.phase === "won" || G.state.phase === "rotated") {
      solvedInfo = save.solved || { ms: G.state.elapsedMs, moves: G.state.moves, isBest: false };
      enterWin(true);
    } else {
      G.startClock();
      enterPlay();
    }
  }

  // =================================================================== play
  function enterPlay() {
    show("play");
    clearHint();
    var tier = M.tierByKey(G.state.tier);
    $("hud-tier").textContent = (tier ? tier.name : G.state.tier).toUpperCase() +
      (G.state.isDaily ? "" : " · FREE");
    setNotesMode(false);   // every board opens in stone mode, never mid-pencil
    buildKeypad();
    renderBoard();
    updateHUD();
    G.startClock();
    startTick();
  }

  function startTick() {
    stopTick();
    tickTimer = setInterval(function () {
      updateHUD();
      if (G && G.state.phase === "playing") saveNow();  // the clock survives a refresh
    }, 1000);
  }
  function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

  function updateHUD() {
    if (!G) return;
    $("hud-time").textContent = fmt(G.elapsed());
    $("hud-moves").textContent = G.state.moves + (G.state.moves === 1 ? " move" : " moves");
    $("tool-undo").disabled = G.state.undoStack.length === 0;
  }

  /* The keypad is a component, not a screen: the play HUD and the field lesson
     both mount one, and both get exactly the same five weights and the same
     erase key. `isArmed(v)` decides which one wears the oxide ring. */
  function makeKeypad(host, isArmed, onPick) {
    host.innerHTML = "";
    for (var w = 1; w <= 5; w++) {
      (function (w) {
        var k = el("button", "key k" + w, String(w));
        k.type = "button";
        k.style.background = "var(--w" + w + ")";
        k.setAttribute("aria-label", "weight " + w);
        k.addEventListener("click", function () { onPick(w); });
        host.appendChild(k);
      })(w);
    }
    var e = el("button", "key kerase", EMPTY_MARK);
    e.type = "button";
    e.setAttribute("aria-label", "mark empty / erase");
    e.addEventListener("click", function () { onPick(0); });
    host.appendChild(e);
    paintKeypad(host, isArmed);
  }

  function paintKeypad(host, isArmed) {
    var keys = host.children;
    for (var i = 0; i < keys.length; i++) {
      var val = i < 5 ? i + 1 : 0;
      keys[i].classList.toggle("armed", !!isArmed(val));
    }
  }

  function armedIs(v) { return armed === v; }
  function buildKeypad() { makeKeypad($("keypad"), armedIs, arm); }

  function arm(w) {
    /* In notes mode the erase key has nothing to toggle: an × is a decision,
       not a candidate. Say so rather than doing nothing. */
    if (notesMode && w === 0) {
      Sound.play("invalid");
      toast("An × is a decision, not a note — switch NOTES off to mark a cell empty.");
      return;
    }
    armed = (armed === w) ? null : w;
    paintArmed();
  }

  function paintArmed() { paintKeypad($("keypad"), armedIs); }

  /* ------------------------------------------------------------ the notes
     One mode flag, lit on the tools row, and it changes exactly one thing:
     what a tap on a cell does with the armed weight. Everything the notes
     touch lives in game.js; nothing here decides what a note means. */
  function setNotesMode(on) {
    notesMode = !!on;
    var key = $("tool-notes");
    key.classList.toggle("on", notesMode);
    key.setAttribute("aria-pressed", notesMode ? "true" : "false");
    $("keypad").classList.toggle("noting", notesMode);
    // the erase key is inert while pencilling, and looks it
    $("play-foot").dataset.notes = notesMode ? "1" : "";
    if (notesMode) armed = armed === 0 ? null : armed;
    paintArmed();
    setFoot();
  }

  function toggleNotesMode() {
    setNotesMode(!notesMode);
    Sound.play(notesMode ? "line" : "place");
    toast(notesMode
      ? "Notes on. Arm a weight, then tap a cell to pencil it in or out."
      : "Notes off. Weights place stones again.");
  }

  function setFoot() {
    if (notesMode) {
      $("play-foot").textContent = "notes mode · pencilling candidates, not stones";
      return;
    }
    $("play-foot").textContent = G && G.state.bedrock.length
      ? "bedrock is locked · ringed in oxide"
      : "givens are locked · four stones to a line";
  }

  function pencil(i, node) {
    if (armed === null || armed === 0) {
      flash(node, "shake", 200);
      Sound.play("invalid");
      toast("Arm a weight first — in notes mode a tap pencils it in.");
      return;
    }
    var res = G.toggleNote(i, armed);
    if (!res.ok) {
      flash(node, "shake", 200);
      Sound.play("invalid");
      toast(res.code === "decided"
        ? "That cell is already decided. Clear it to pencil in it."
        : refuseText(res.code));
      return;
    }
    /* A note is not a move: no move counter, no mistake, no win check, and no
       reason to dismiss a hint the player has not acted on yet. */
    paintCell(node, i, G.state.board[i]);
    flash(node, "press", 130);
    Sound.play("place");
    saveNow();
  }

  /* The board is a component too. Everything below takes the game instance it
     is drawing, so the field lesson renders its fixed board through exactly
     the same code as a live daily — there is only one board in this game. */
  function renderBoardInto(host, game, onTap) {
    host.innerHTML = "";
    host.appendChild(el("div", "clue"));
    var st = game.lineState();
    for (var c = 0; c < M.N; c++) {
      host.appendChild(el("div", "clue" + clueClass(st.cols[c]), String(game.state.clues.cols[c])));
    }
    for (var r = 0; r < M.N; r++) {
      host.appendChild(el("div", "clue" + clueClass(st.rows[r]), String(game.state.clues.rows[r])));
      for (var c2 = 0; c2 < M.N; c2++) {
        host.appendChild(cellNode(M.idx(r, c2), game, onTap));
      }
    }
  }

  function renderBoard() { renderBoardInto($("board"), G, tapCell); }

  function clueClass(m) { return m.done ? " done" : (m.over ? " over" : ""); }

  function cellNode(i, game, onTap) {
    var v = game.state.board[i];
    var node = el("button", "cell");
    node.type = "button";
    node.dataset.i = String(i);
    paintCell(node, i, v, game);
    node.addEventListener("click", function () { onTap(i, node); });
    return node;
  }

  function paintCell(node, i, v, game) {
    var g = game || G;
    node.className = "cell";
    node.innerHTML = "";
    if (v === M.UNKNOWN) {
      node.classList.add("blank");
      node.textContent = "?";
      /* Pencil notes, on an undecided cell only — a cluster of the surviving
         candidates along the bottom edge, so the top of the cell stays clear
         and a numeral can never share the space with them. */
      var notes = g.notesAt ? g.notesAt(i) : [];
      if (notes.length) {
        node.textContent = "";
        node.classList.add("noted");
        node.appendChild(el("span", "notes", notes.join("")));
      }
    } else if (v === 0) {
      node.classList.add("empty");
      node.textContent = EMPTY_MARK;
    } else {
      node.classList.add("w" + v);
      node.textContent = String(v);
    }
    var bed = M.bedrockAt(g.state.bedrock, M.rowOf(i), M.colOf(i));
    if (bed && v > 0) {
      node.classList.add("bed");
      var a = el("span", "age", String(bed.age));
      node.appendChild(a);
      node.setAttribute("aria-label", "bedrock stone, weight " + v + ", age " + bed.age + ", locked");
    } else if (g.isLocked(i)) {
      node.classList.add("given");
      node.setAttribute("aria-label", "given " + (v > 0 ? "weight " + v : "empty") + ", locked");
    } else {
      var pencilled = v === M.UNKNOWN && g.notesAt ? g.notesAt(i) : [];
      node.setAttribute("aria-label", "row " + (M.rowOf(i) + 1) + " column " + (M.colOf(i) + 1) +
        ", " + (v === M.UNKNOWN ? "open" : v === 0 ? "empty" : "weight " + v) +
        (pencilled.length ? ", pencilled " + pencilled.join(" ") : ""));
    }
  }

  function cellAt(i, host) {
    return (host || $("board")).querySelector('[data-i="' + i + '"]');
  }

  function flash(node, cls, ms) {
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
    setTimeout(function () { node.classList.remove(cls); }, ms || 400);
  }

  function tapCell(i, node) {
    if (!G || G.state.phase !== "playing") return;
    if (G.isLocked(i)) {
      flash(node, "refuse", 220);
      Sound.play("invalid");
      toast(G.isBedrock(i) ? "Bedrock is weight-locked — it came with you." : "That stone was given.");
      return;
    }
    if (notesMode) { pencil(i, node); return; }
    var want = armed === null ? nextInCycle(i) : armed;
    if (want === null) { flash(node, "shake", 200); Sound.play("invalid"); return; }
    apply(i, want, node);
  }

  /* Cycle mode: UNKNOWN -> 1..5 -> empty -> UNKNOWN, skipping values the rules
     refuse, so a tap always lands somewhere legal or does nothing. */
  function nextInCycle(i) {
    var order = [1, 2, 3, 4, 5, 0, M.UNKNOWN];
    var cur = G.state.board[i];
    var start = order.indexOf(cur);
    for (var k = 1; k <= order.length; k++) {
      var v = order[(start + k) % order.length];
      if (v === M.UNKNOWN) return M.UNKNOWN;
      if (!G.refusal(i, v)) return v;
    }
    return M.UNKNOWN;
  }

  function apply(i, want, node) {
    var res = G.place(i, want);
    if (!res.ok) {
      if (res.code === "noop") return;
      flash(node, "shake", 200);
      Sound.play("invalid");
      toast(refuseText(res.code));
      return;
    }
    clearHint();          // the player moved; the hint has been acted on
    paintCell(node, i, G.state.board[i]);
    flash(node, "press", 130);
    Sound.play("place");
    repaintClues();
    if (res.lines.length) {
      Sound.play("line");
      res.lines.forEach(function (l) { markLine(l); });
    }
    updateHUD();
    saveNow();
    if (res.solved) onSolved();
  }

  function refuseText(code) {
    return ({
      repulsion: "No two touching stones may share a weight.",
      overfill: "That line already holds its four stones.",
      overempty: "That line already holds its three empties.",
      overload: "That would push the line past its load.",
      bedrock: "Bedrock is weight-locked.",
      given: "That stone was given."
    })[code] || "Not there.";
  }

  function repaintClues(host, game) {
    var st = (game || G).lineState();
    // .clue nodes in document order: corner, 7 column clues, then 7 row clues
    var clues = (host || $("board")).querySelectorAll(".clue");
    for (var c = 0; c < M.N; c++) clues[c + 1].className = "clue" + clueClass(st.cols[c]);
    for (var r = 0; r < M.N; r++) clues[1 + M.N + r].className = "clue" + clueClass(st.rows[r]);
  }

  function markLine(l) {
    var cells = [];
    for (var k = 0; k < M.N; k++) cells.push(l.kind === "row" ? M.idx(l.n, k) : M.idx(k, l.n));
    cells.forEach(function (i, n) {
      setTimeout(function () { flash(cellAt(i), "press", 130); }, n * 22);
    });
  }

  // ---------------------------------------------------------------- tools
  function doUndo() {
    if (!G || G.state.phase !== "playing") return;
    var r = G.undo();
    if (!r.ok) return;
    // undoing a note is not acting on a hint, so the hint stays up
    if (r.kind !== "note") clearHint();
    paintCell(cellAt(r.index), r.index, G.state.board[r.index]);
    flash(cellAt(r.index), "press", 130);
    repaintClues();
    updateHUD();
    saveNow();
  }

  function doHint() {
    if (!G || G.state.phase !== "playing") return;
    var h = G.hint();
    if (!h.ok) { showHint(h.text, null); return; }
    var node = cellAt(h.index);
    paintCell(node, h.index, G.state.board[h.index]);
    flash(node, "hinted", 950);
    Sound.play("place");
    repaintClues();
    updateHUD();
    saveNow();
    showHint(h.text, h.index);
    if (G.state.phase === "won") onSolved();
  }

  // ==================================================================== win
  function onSolved() {
    stopTick();
    G.pauseClock();
    var ms = G.elapsed();

    /* THE single meta hook. Mistakes come from the BOARD — game.js counts a
       wrong value placed in a cell — not from whether the player pressed
       anything. Free play passes mode "free", which the library treats as no
       achievement at all: no record, no streak, no rank. The chain is
       untouched either way; it moves only in setStone(), through
       model.recordSolve. */
    var meta = null;
    if (!recorded) {
      meta = Meta.recordWin({
        mode: G.state.isDaily ? "daily" : "free",
        tier: G.state.tier,
        dateKey: G.state.dateKey,
        ms: ms,
        hints: G.state.hints,
        mistakes: G.state.mistakes,
        par: StrataPar.parForPuzzle(G.state.tier, G.state.givens)
      });
      if (G.state.isDaily) Store.recordResult(G.state.tier, ms);
      recorded = true;
    }

    solvedInfo = {
      ms: ms, moves: G.state.moves,
      mistakes: G.state.mistakes, hints: G.state.hints,
      par: StrataPar.parForPuzzle(G.state.tier, G.state.givens),
      stones: meta ? (meta.stars || 0) : 0,
      // The library refuses to re-award a day it has already logged. Say so,
      // rather than showing yesterday's stones under today's par claim.
      alreadyLogged: !!(meta && meta.alreadySolved),
      isBest: !!(meta && meta.records && meta.records.isNewBest),
      deltaMs: meta && meta.records ? meta.records.deltaMs : 0,
      bestMs: meta && meta.records ? meta.records.bestMs : 0,
      rank: meta ? meta.rankPercentile : null
    };
    saveNow();
    Sound.play("win");
    confetti();
    // a beat on the solved board before the screen changes
    solvePop();
    setTimeout(function () { enterWin(false); }, 700);
  }

  function solvePop() {
    for (var i = 0; i < M.CELLS; i++) {
      (function (i) {
        setTimeout(function () { flash(cellAt(i), "solvepop", 440); },
          (M.rowOf(i) + M.colOf(i)) * 26);
      })(i);
    }
  }

  function enterWin(restored) {
    show("win");
    var tier = M.tierByKey(G.state.tier);
    var stats = Store.loadStats();
    var rec = Meta.records.get(G.state.tier);

    $("win-stamp").textContent = G.state.isDaily
      ? "Core recovered · no. " + (stats.solved || 1)
      : "Practice core";

    /* The hierarchy: solved board, then the stones, then the numbers, with the
       rank badge as the only saturated block. Stones land one at a time. */
    MetaUI.renderStones($("win-stones"), solvedInfo.stones, !restored);
    MetaUI.renderRank($("win-rank"), { rankPercentile: solvedInfo.rank });

    var clean = !solvedInfo.hints && !solvedInfo.mistakes;
    $("win-say").innerHTML = escapeHTML(tier ? tier.name : G.state.tier) + ", " +
      (clean ? "clean — <b>no hints, no mistakes</b>."
             : "<b>" + solvedInfo.hints + " hint" + (solvedInfo.hints === 1 ? "" : "s") +
               ", " + solvedInfo.mistakes + " mistake" + (solvedInfo.mistakes === 1 ? "" : "s") + "</b>.") +
      " " + escapeHTML(solvedInfo.alreadyLogged
        ? "Today was already logged — this one was for the pleasure of it."
        : MetaUI.stoneReason(solvedInfo, solvedInfo.par));

    var bestLabel = solvedInfo.isBest && solvedInfo.deltaMs
      ? fmt(rec.bestMs) + "  ↓" + fmt(solvedInfo.deltaMs)
      : rec.bestMs ? fmt(rec.bestMs) : "—";
    var boxes = [
      ["time", fmt(solvedInfo.ms)],
      ["moves", String(solvedInfo.moves)],
      ["chain", G.state.isDaily ? String(chain.length + 1) : String(chain.length)],
      // on free play the best is shown but explicitly marked as untouched,
      // so a fast practice run never looks like a record the game "lost"
      [(G.state.isDaily ? "best · " : "best · daily only · ") +
        (tier ? tier.name.toLowerCase() : ""), bestLabel]
    ];
    var box = $("win-stats");
    box.innerHTML = "";
    boxes.forEach(function (b, n) {
      var s = el("div", "stat late");
      s.style.animationDelay = (restored ? 0 : 90 + n * 90) + "ms";
      s.appendChild(el("div", "k", b[0]));
      s.appendChild(el("div", "v", b[1]));
      box.appendChild(s);
    });

    // The text share is for a chain-advancing daily only.
    $("btn-share-summary").hidden = !G.state.isDaily;

    if (!G.state.isDaily) {
      // Free play touches nothing: no chain, no seed, no record.
      $("surv-head").textContent = "free play";
      $("surv-board").innerHTML = "";
      /* Say the quiet part out loud. A free-play time that BEATS the stored
         best is the one case where "leaves no trace" looks like a bug rather
         than a rule, so it is named explicitly instead of being swallowed. */
      var beat = solvedInfo.ms > 0 && (!rec.bestMs || solvedInfo.ms < rec.bestMs);
      $("surv-say").innerHTML = "This was a practice core. <b>It leaves no trace</b> — " +
        "the chain only moves on today's daily board." +
        (beat
          ? " That was " + (rec.bestMs ? "faster than your " + escapeHTML(tier ? tier.name.toLowerCase() : "") +
              " best of " + fmt(rec.bestMs) : "your fastest " +
              escapeHTML(tier ? tier.name.toLowerCase() : "") + " core yet") +
            ", but <b>free play does not set records</b> — only the daily does."
          : "");
      $("btn-to-seed").textContent = "Back to the core log";
      $("btn-to-seed").onclick = function () { Store.clearSave(); goHome(); };
      return;
    }

    $("surv-head").textContent = "survival";
    $("btn-to-seed").textContent = "Choose your seed stone";
    $("btn-to-seed").onclick = goSeed;
    $("btn-to-seed").disabled = !restored;
    runSurvival(restored);
  }

  /* The signature moment: survivors pulse and darken to mineral, everything
     else washes away. Slow enough to be read, once. */
  function runSurvival(instant) {
    survivalInto({
      grid: G.state.solution,
      survivors: G.survivorSet(),
      board: $("surv-board"),
      say: $("surv-say"),
      instant: instant,
      onDone: function () { $("btn-to-seed").disabled = false; }
    });
  }

  /* The one implementation. The win screen runs it on the solved daily and the
     field lesson runs it on its fixed board — same timings, same sounds, same
     sentence, because a player who learns the chain here has to recognise it
     when it happens for real. */
  function survivalInto(o) {
    var surv = o.survivors;
    var isSurv = {};
    surv.forEach(function (i) { isSurv[i] = true; });
    var grid = o.grid;
    var wrap = o.board;
    wrap.innerHTML = "";
    var nodes = [];
    for (var i = 0; i < M.CELLS; i++) {
      var v = grid[i];
      var n = el("div", "cell");
      if (v === 0) { n.classList.add("empty"); n.textContent = EMPTY_MARK; }
      else { n.classList.add("w" + v); n.textContent = String(v); }
      wrap.appendChild(n);
      nodes.push(n);
    }
    if (o.say) {
      o.say.innerHTML = "<b>" + surv.length + " stone" + (surv.length === 1 ? "" : "s") +
        " survived.</b> Heavy enough, and heavier than everything they touch. The other " +
        (28 - surv.length) + " wash away.";
    }

    if (o.instant) {
      nodes.forEach(function (n, i) {
        if (isSurv[i]) n.classList.add("surv");
        else if (grid[i] > 0) n.classList.add("wash");
      });
      if (o.onDone) o.onDone();
      return;
    }

    var delay = 260;
    surv.forEach(function (i, k) {
      setTimeout(function () {
        nodes[i].classList.add("mineral");
        setTimeout(function () { nodes[i].classList.add("surv"); }, 380);
        Sound.play("mineral");
      }, delay + k * 240);
    });
    var after = delay + surv.length * 240 + 260;
    setTimeout(function () {
      nodes.forEach(function (n, i) { if (grid[i] > 0 && !isSurv[i]) n.classList.add("wash"); });
      Sound.play("crumble");
    }, after);
    setTimeout(function () { if (o.onDone) o.onDone(); }, after + 500);
  }

  // =================================================================== seed
  function goSeed() {
    show("seed");
    seedPick = G.state.seedIndex;
    renderSeedBoard();
    renderRotation();
    $("btn-set-stone").disabled = seedPick === null;
  }

  /* The pickable mini board: survivors ringed in moss, everything else washed
     out, the chosen stone in oxide. Shared with the field lesson. */
  function renderPickMini(host, grid, survSet, pick, onPick) {
    host.className = "mini pickable";
    host.innerHTML = "";
    for (var i = 0; i < M.CELLS; i++) {
      (function (i) {
        var v = grid[i];
        var n = el("div", "cell");
        if (v === 0) { n.classList.add("empty"); n.textContent = EMPTY_MARK; }
        else {
          n.classList.add("w" + v);
          n.textContent = String(v);
          if (survSet[i]) n.classList.add("surv");
          else if (i !== pick) n.classList.add("wash");
          if (i === pick) n.classList.add("pick");
          n.setAttribute("role", "button");
          n.addEventListener("click", function () { onPick(i); });
        }
        host.appendChild(n);
      })(i);
    }
  }

  /* Tomorrow's slab: bedrock stones with their age, the ones the cap will take
     washed out. Shared with the field lesson. */
  function renderBedMini(host, keep, gone) {
    host.className = "mini";
    host.innerHTML = "";
    for (var i = 0; i < M.CELLS; i++) {
      var b = keep[i] || gone[i];
      var n = el("div", "cell");
      // No mark here. On every other board an empty cell is a decision the
      // player made, and the x says so. This board is tomorrow's ground before
      // it has been drilled — the blank cells are simply "no bedrock", not
      // "known to be empty", and 44 crosses would say something untrue as well
      // as drowning the four stones the screen exists to show.
      if (!b) { n.classList.add("ground"); }
      else {
        n.classList.add("w" + b.w, "bed");
        n.textContent = String(b.w);
        n.appendChild(el("span", "age", String(b.age)));
        if (gone[i]) n.classList.add("wash");
      }
      host.appendChild(n);
    }
  }

  function renderSeedBoard() {
    var surv = {};
    G.survivorSet().forEach(function (i) { surv[i] = true; });
    var grid = G.state.solution;
    renderPickMini($("seed-board"), grid, surv, seedPick, pickSeed);
    if (seedPick === null) {
      $("seed-say").textContent = "Nothing chosen yet. Tap any stone.";
    } else {
      var r = M.rowOf(seedPick), c = M.colOf(seedPick);
      var p = M.rotatePoint(r, c);
      $("seed-say").innerHTML = "Chosen: <b>the " + grid[seedPick] + " at row " + (r + 1) +
        ", column " + (c + 1) + "</b>.<br>After rotation it lands at row " + (p.r + 1) +
        ", column " + (p.c + 1) + "." +
        (surv[seedPick] ? "<br>That stone already survives on its own — your pick buys nothing." : "");
    }
  }

  function pickSeed(i) {
    var res = G.chooseSeed(i);
    if (!res.ok) return;
    seedPick = i;
    Sound.play("place");
    renderSeedBoard();
    renderRotation();
    $("btn-set-stone").disabled = false;
    saveNow();
  }

  /* The rotated consequence, live, before the player commits. */
  function renderRotation() {
    var prev = G.previewNext(seedPick === null ? null : seedPick, chain);
    var keep = {}, gone = {};
    prev.bedrock.forEach(function (b) { keep[M.idx(b.r, b.c)] = b; });
    prev.capped.forEach(function (b) { gone[M.idx(b.r, b.c)] = b; });

    renderBedMini($("rot-board"), keep, gone);
    var carried = prev.bedrock.length + prev.capped.length;
    $("rot-head").textContent = "tomorrow's bedrock · rotated 90° clockwise · " +
      carried + " carried, " + prev.bedrock.length + " kept" +
      (prev.capped.length ? ", " + prev.capped.length + " crumbled to the cap" : "");
  }

  function setStone() {
    if (seedPick === null) return;
    /* The BOARD's day, not the ambient one. If midnight passed while this
       board was open, it still counts for the day it was started. */
    var boardDate = G.state.dateKey || today;
    var res = G.commitSeed(chain, boardDate);
    chain = res.chain;
    Store.saveChain(chain);
    Store.noteChain(chain);
    /* The age each carried stone leaves this board with — the same arithmetic
       model.nextBedrock does, recorded in BOARD coordinates so the lineage
       view can colour this slab by age without un-rotating anything. */
    var carriedAges = {};
    var carriedIdx = G.survivorSet().slice();
    if (carriedIdx.indexOf(seedPick) < 0) carriedIdx.push(seedPick);
    carriedIdx.forEach(function (i) {
      var was = M.bedrockAt(G.state.bedrock, M.rowOf(i), M.colOf(i));
      carriedAges[i] = was && was.w === G.state.solution[i] ? was.age + 1 : 1;
    });

    Store.pushHistory({
      date: boardDate, tier: G.state.tier,
      grid: Array.prototype.slice.call(G.state.solution),
      survivors: G.survivorSet(),
      ages: carriedAges,
      inherited: G.state.bedrock,
      seed: seedPick,
      bedrock: chain.bedrock,
      chain: chain.length,
      ms: solvedInfo ? solvedInfo.ms : 0,
      moves: G.state.moves, mistakes: G.state.mistakes, hints: G.state.hints
    });
    Store.clearSave();

    if (res.capped && res.capped.length) Sound.play("crumble");
    else Sound.play("line");

    // crumble the capped stones out of the preview, then home
    var wrap = $("rot-board");
    var goneIdx = (res.capped || []).map(function (b) { return M.idx(b.r, b.c); });
    goneIdx.forEach(function (i, k) {
      setTimeout(function () {
        if (wrap.children[i]) wrap.children[i].classList.add("crumble");
      }, k * 90);
    });
    $("btn-set-stone").disabled = true;
    setTimeout(function () {
      toast("Chain at " + chain.length + ". " + chain.bedrock.length +
            " stone" + (chain.bedrock.length === 1 ? "" : "s") + " waiting for tomorrow.");
      goHome();
    }, 620 + goneIdx.length * 90);
  }

  // ================================================================ records
  /* The per-tier rows come from the shared meta-layer (best / average / trend).
     Only the chain-specific numbers, which the library has no concept of, come
     from our own store. */
  function goRecords() {
    var s = Store.loadStats();
    var d = Meta.daily.stats();
    var top = $("rec-top");
    top.innerHTML = "";
    [["boards solved", String(s.solved || 0)],
     ["current chain", String(chain.length)],
     ["longest chain", String(Math.max(s.longestChain || 0, chain.longest || 0))],
     ["deepest bedrock", (s.deepestAge || 0) ? (s.deepestAge + " day" + (s.deepestAge === 1 ? "" : "s")) : "—"],
     ["day streak", String(Meta.daily.currentStreak().dead ? 0 : d.streak)],
     ["best daily", d.bestMs ? fmt(d.bestMs) : "—"]
    ].forEach(function (b) {
      var box = el("div", "stat");
      box.appendChild(el("div", "k", b[0]));
      box.appendChild(el("div", "v", b[1]));
      top.appendChild(box);
    });

    MetaUI.renderRecords($("rec-rows"));
    show("records");
  }

  // =============================================================== calendar
  function goCalendar(delta) {
    var s = MetaUI.renderCalendar($("cal-grid"), $("cal-title"),
      delta === undefined ? "reset" : delta);
    $("cal-say").innerHTML = "<b>" + s.solved + " day" + (s.solved === 1 ? "" : "s") +
      " solved.</b> Tap any past day to cut its core again — a replay is free " +
      "play and never moves the chain.";
    show("calendar");
  }

  /* A past day, replayed. Free play by construction: same seed, no bedrock,
     nothing recorded. The tier is the player's to choose, exactly as it is on
     the day itself. */
  function openReplay(dateKey, solved) {
    var head = $("replay-head");
    head.textContent = "replay · " + dateKey + (solved ? " · solved" : "");
    var host = $("replay-tiers");
    host.innerHTML = "";
    M.TIERS.forEach(function (t, i) {
      var b = el("button", "tier");
      b.type = "button";
      var bar = el("span", "bar");
      bar.style.background = i < 5 ? "var(--w" + (i + 1) + ")" : "var(--accent)";
      b.appendChild(bar);
      b.appendChild(el("span", "nm", t.name));
      b.appendChild(el("span", "tech", techLabel(t.key)));
      b.addEventListener("click", function () {
        sheet("sheet-replay", false);
        startTier(t.key, { replayDate: dateKey });
      });
      host.appendChild(b);
    });
    sheet("sheet-replay", true);
  }

  // =========================================================== text summary
  function shareSummary() {
    MetaUI.shareSummary({
      tier: G.state.tier,
      dateKey: G.state.dateKey,
      ms: solvedInfo.ms,
      chain: chain.length + 1,
      hints: solvedInfo.hints,
      mistakes: solvedInfo.mistakes,
      stones: solvedInfo.stones
    }, toast);
  }

  // ================================================================ lineage
  function goLineage() {
    var days = chain.day || 0;
    if (days < Lineage.UNLOCK_DAY) {
      toast("The lineage view opens on day " + Lineage.UNLOCK_DAY + " — " +
            (Lineage.UNLOCK_DAY - days) + " more board" +
            (Lineage.UNLOCK_DAY - days === 1 ? "" : "s") + " to go.");
      return;
    }
    var history = Store.loadHistory();
    var sum = Lineage.summarise(history);
    $("lin-say").innerHTML = "<b>" + sum.boards + " core" + (sum.boards === 1 ? "" : "s") +
      "</b> read top to bottom, newest first. Survivors darken as they age; " +
      "everything else is spoil.";
    Lineage.render($("lin-col"), history);

    var leg = $("lin-legend");
    leg.innerHTML = "";
    leg.appendChild(el("span", null, "age"));
    for (var a = 1; a <= 6; a++) {
      var i = el("i");
      i.style.background = Lineage.ageColor(a);
      i.title = "age " + a;
      leg.appendChild(i);
    }
    leg.appendChild(el("span", null, "1 → 6+"));
    show("lineage");
  }

  function shareCore() {
    var history = Store.loadHistory();
    if (!history.length) { toast("Nothing to share yet."); return; }
    var btn = $("btn-lin-share");
    btn.disabled = true;
    btn.textContent = "Drawing the core…";
    setTimeout(function () {
      var canvas = Lineage.toCanvas(history, chain);
      Lineage.share(canvas, Lineage.caption(history, chain), toast).then(function (route) {
        btn.disabled = false;
        btn.textContent = "Share the core sample";
        if (route === "failed") toast("The image could not be drawn here.");
      });
    }, 30);
  }

  // ============================================================ how to play
  /* Shown once, on the very first launch, and never again — but always
     reachable from the in-game menu. */
  function maybeHowTo() {
    if (Store.seen("howto")) return false;
    Store.markSeen("howto");
    openHowTo();
    return true;
  }

  function openHowTo() {
    var X = EMPTY_MARK;
    var art = {
      count: [["w2", "2"], ["w4", "4"], ["empty", X], ["w1", "1"], ["empty", X], ["w5", "5"], ["empty", X]],
      repel: [["w3", "3"], ["w3 bad", "3"], ["empty", X], ["w3", "3"], ["w1", "1"], ["w3", "3"], ["empty", X]],
      sum: [["clue", "12"], ["w2", "2"], ["w4", "4"], ["empty", X], ["w1", "1"], ["w5", "5"], ["empty", X]]
    };
    Array.prototype.forEach.call(document.querySelectorAll(".ruleart"), function (host) {
      host.innerHTML = "";
      (art[host.dataset.art] || []).forEach(function (pair) {
        var s = el("span", pair[0], pair[1]);
        if (/w[45]/.test(pair[0])) s.style.color = "var(--stone-ink-deep)";
        if (/w\d/.test(pair[0])) s.style.background = "var(--w" + pair[0].match(/w(\d)/)[1] + ")";
        host.appendChild(s);
      });
    });
    sheet("sheet-howto", true);
  }

  // =========================================================== field lesson
  /* The guided lesson is NEVER auto-shown — the first-launch "how to play"
     card is a different thing and stays exactly as it was. This is opt-in from
     the core log or the in-game menu. It records nothing a player earned: no
     chain, no record, no streak, no history, no stats. The ONE key it writes is
     strata:lesson, the "you have seen this" flag that lets a returning player
     click straight through the interactive steps. See js/tutorial.js. */
  function openTutor() {
    if (busy || !L) return;
    // a board left open behind the lesson keeps its place and stops its clock
    stopTick();
    if (G && G.state.phase === "playing") { G.pauseClock(); saveNow(); }
    StrataTutorial.open({
      logic: L, model: M, el: el, show: show, sheet: sheet, toast: toast,
      sound: Sound,
      makeKeypad: makeKeypad, paintKeypad: paintKeypad,
      renderBoardInto: renderBoardInto, paintCell: paintCell,
      repaintClues: repaintClues, cellAt: cellAt, flash: flash,
      refuseText: refuseText,
      survivalInto: survivalInto,
      renderPickMini: renderPickMini, renderBedMini: renderBedMini,
      onExit: goHome
    });
  }

  // =============================================================== settings
  function applySettings() {
    document.body.classList.toggle("dark", !!settings.dark);
    // oxide is the brand colour and matches the manifest; dark mode drops the
    // status bar to the dark ground so the chrome does not glow at night
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", settings.dark ? "#1b1915" : "#b4522a");
    Sound.setEnabled(settings.sound);
    Sound.setHaptics(settings.haptics);
    ["sound", "haptics", "dark"].forEach(function (k) {
      var b = $("set-" + k);
      if (b) b.setAttribute("aria-pressed", settings[k] ? "true" : "false");
    });
  }

  function toggleSetting(k) {
    settings[k] = !settings[k];
    Store.saveSettings(settings);
    applySettings();
    if (k === "sound" && settings.sound) Sound.play("place");
  }

  function sheet(id, open) { $(id).hidden = !open; }

  // ================================================================== save
  function saveNow() {
    if (!G) return;
    /* A "rotated" board is COMMITTED: setStone already cleared the save on
       purpose. Writing one again here would resurrect a ghost "Continue" on
       the home screen — which is exactly what a backgrounding right after the
       commit used to do, since visibilitychange and pagehide both saveNow(). */
    if (G.state.phase === "rotated") return;
    Store.saveSave({ g: G.snapshot(), recorded: recorded, solved: solvedInfo });
  }

  // =============================================================== confetti
  /* Dust off the core, in the weight ramp. Light: 26 particles, no library. */
  function confetti() {
    var host = $("confetti");
    var colors = ["--w1", "--w2", "--w3", "--w4", "--w5", "--accent"];
    var w = window.innerWidth, h = window.innerHeight;
    for (var k = 0; k < 26; k++) {
      (function (k) {
        var p = el("i");
        var size = 5 + Math.random() * 7;
        p.style.width = size + "px";
        p.style.height = size + "px";
        p.style.background = "var(" + colors[k % colors.length] + ")";
        p.style.left = (w * 0.5 + (Math.random() - 0.5) * 90) + "px";
        p.style.top = (h * 0.42) + "px";
        host.appendChild(p);
        var dx = (Math.random() - 0.5) * w * 0.9;
        var dy = -h * (0.18 + Math.random() * 0.28);
        var rot = (Math.random() - 0.5) * 720;
        var dur = 900 + Math.random() * 700;
        p.animate([
          { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
          { transform: "translate(" + dx * 0.6 + "px," + dy + "px) rotate(" + rot * 0.5 + "deg)", opacity: 1, offset: 0.4 },
          { transform: "translate(" + dx + "px," + (h * 0.6) + "px) rotate(" + rot + "deg)", opacity: 0 }
        ], { duration: dur, easing: "cubic-bezier(.22,.61,.36,1)", fill: "forwards" });
        setTimeout(function () { p.remove(); }, dur + 60);
      })(k);
    }
  }

  // =================================================================== wire
  function wire() {
    $("btn-continue").addEventListener("click", resume);
    $("btn-settings").addEventListener("click", function () { sheet("sheet-settings", true); });
    $("btn-records").addEventListener("click", goRecords);
    $("btn-rec-back").addEventListener("click", goHome);
    $("btn-lineage").addEventListener("click", goLineage);
    $("btn-calendar").addEventListener("click", function () { goCalendar(); });
    $("cal-prev").addEventListener("click", function () { goCalendar(-1); });
    $("cal-next").addEventListener("click", function () { goCalendar(1); });
    $("btn-cal-back").addEventListener("click", goHome);
    $("btn-share-summary").addEventListener("click", shareSummary);
    $("replay-cancel").addEventListener("click", function () { sheet("sheet-replay", false); });
    $("btn-lin-back").addEventListener("click", goHome);
    $("btn-lin-share").addEventListener("click", shareCore);
    $("mn-howto").addEventListener("click", function () {
      sheet("sheet-menu", false); openHowTo();
    });
    $("btn-tutor").addEventListener("click", openTutor);
    $("mn-tutor").addEventListener("click", function () {
      sheet("sheet-menu", false); saveNow(); openTutor();
    });
    $("hintbar").addEventListener("click", clearHint);
    $("howto-go").addEventListener("click", function () { sheet("sheet-howto", false); });
    $("btn-break-on").addEventListener("click", goHome);
    $("tool-undo").addEventListener("click", doUndo);
    $("tool-notes").addEventListener("click", toggleNotesMode);
    $("tool-hint").addEventListener("click", doHint);
    $("tool-menu").addEventListener("click", function () { sheet("sheet-menu", true); });
    $("btn-set-stone").addEventListener("click", setStone);

    $("mn-resume").addEventListener("click", function () { sheet("sheet-menu", false); });
    $("mn-restart").addEventListener("click", function () {
      sheet("sheet-menu", false); clearHint();
      G.restart(); renderBoard(); updateHUD(); saveNow(); startTick();
    });
    $("mn-clear").addEventListener("click", function () {
      sheet("sheet-menu", false); clearHint();
      G.clearBoard(); renderBoard(); updateHUD(); saveNow();
    });
    $("mn-settings").addEventListener("click", function () {
      sheet("sheet-menu", false); sheet("sheet-settings", true);
    });
    $("mn-home").addEventListener("click", function () {
      sheet("sheet-menu", false); saveNow(); goHome();
    });

    $("set-sound").addEventListener("click", function () { toggleSetting("sound"); });
    $("set-haptics").addEventListener("click", function () { toggleSetting("haptics"); });
    $("set-dark").addEventListener("click", function () { toggleSetting("dark"); });
    $("set-close").addEventListener("click", function () { sheet("sheet-settings", false); });

    Array.prototype.forEach.call(document.querySelectorAll(".scrim"), function (s) {
      s.addEventListener("click", function () {
        sheet("sheet-menu", false); sheet("sheet-settings", false);
        sheet("sheet-howto", false); sheet("sheet-replay", false);
      });
    });

    /* THREE resume paths, because no single one covers everything: an
       installed PWA comes back through visibilitychange, a bfcache restore
       comes back through pageshow, and a desktop tab re-focus fires neither
       reliably. All three re-check the date — see checkDate(). */
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (G) { G.pauseClock(); saveNow(); }
        stopTick();
        return;
      }
      onResume();
    });
    window.addEventListener("pageshow", onResume);
    window.addEventListener("focus", onResume);
    window.addEventListener("pagehide", function () { if (G) { G.pauseClock(); saveNow(); } });

    // desktop convenience only; nothing here is required to play
    document.addEventListener("keydown", function (e) {
      if ($("screen-play").hidden) return;
      if (e.key >= "1" && e.key <= "5") arm(parseInt(e.key, 10));
      else if (e.key === "0" || e.key === ".") arm(0);
      else if (e.key === "u") doUndo();
      else if (e.key === "n") toggleNotesMode();
      else if (e.key === "h") doHint();
      else if (e.key === "Escape") arm(armed);
    });

    // the board should never rubber-band or select
    $("screen-play").addEventListener("touchmove", function (e) {
      if (e.target.closest && e.target.closest(".board")) e.preventDefault();
    }, { passive: false });
  }

  /* `_test` is the seam test/chain.test.js drives. It exposes no new
     behaviour — only a settable clock and read-only views of state the tests
     assert on — so the shipped app is unchanged by its presence. */
  return {
    boot: boot,
    _test: {
      setClock: function (fn) { clock.now = fn; },
      checkDate: checkDate,
      onResume: onResume,
      today: function () { return today; },
      chain: function () { return chain; },
      game: function () { return G; },
      screen: function () { return currentScreen; },
      pending: function () { return pendingRollover; },
      startTier: startTier,
      setStone: setStone,
      solvedInfo: function () { return solvedInfo; }
    }
  };
})();

document.addEventListener("DOMContentLoaded", UI.boot);
