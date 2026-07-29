"use strict";

/* STRATA — meta-layer surfaces: the streak line, the daily calendar, the
   records panel, the rank badge, the three stones, and the text share.

   Everything here READS js/meta-config.js and renders it. It never computes
   progression itself, and it never touches the chain: the chain is model.js's,
   and this file only ever displays what the daily layer already recorded.

   It lives apart from ui.js on purpose — the board controller has a different
   job, and mixing the two is how a 600-line UI becomes 1,600. */

var MetaUI = (function () {

  var meta = null;
  var M = null;         // the game model, for tier names
  var hooks = {};

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function $(id) { return document.getElementById(id); }

  function fmt(ms) {
    var s = Math.max(0, Math.round((ms || 0) / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function init(opts) {
    meta = opts.meta;
    M = opts.model;
    hooks = opts.hooks || {};
  }

  // ------------------------------------------------------------ home streak
  /* The chain is the hero number on the home screen and stays untouched. This
     is the quieter second line: how many dailies have actually been solved,
     the streak the meta layer tracks, and the best it has seen. */
  function renderStreak(host) {
    var s = meta.daily.stats();
    var live = meta.daily.currentStreak();
    host.innerHTML = "";
    var bits = [
      (live.dead ? 0 : live.streak) + " day streak",
      "best " + Math.max(s.best, live.streak),
      s.solved + " core" + (s.solved === 1 ? "" : "s") + " logged"
    ];
    bits.forEach(function (b, i) {
      if (i) host.appendChild(el("span", "dot", "·"));
      host.appendChild(el("span", null, b));
    });
  }

  // --------------------------------------------------------------- stones
  /* Three filled cells, in the weight ramp — STRATA's own vocabulary for "a
     thing worth having". They land one at a time; all three at once would make
     the whole meta-layer read as a popup. */
  function renderStones(host, n, animate) {
    host.innerHTML = "";
    for (var i = 0; i < 3; i++) {
      var s = el("i", "stone" + (i < n ? " got" : " lost"));
      if (i < n && animate) {
        s.style.animationDelay = 180 + i * 260 + "ms";
        s.classList.add("lands");
      }
      host.appendChild(s);
    }
  }

  /* Why a stone was lost, in one line, so par never feels arbitrary. */
  function stoneReason(res, par) {
    if (res.mistakes && res.hints) return "A hint and a wrong stone cost you two.";
    if (res.mistakes) return "A wrong stone cost you one.";
    if (res.hints) return "A hint cost you one.";
    if (par && res.ms > par) return "Clean, but over par of " + fmt(par) + ".";
    return "Clean, and under par.";
  }

  // ------------------------------------------------------------ rank badge
  function renderRank(host, result) {
    if (!result || !result.rankPercentile) { host.hidden = true; return; }
    host.hidden = false;
    host.textContent = result.rankPercentile.label.toUpperCase() + " · YOUR PACE";
  }

  // ---------------------------------------------------------------- records
  /* Per tier: best, average, and whether they are actually getting better.
     records.trend() compares the recent window against everything before it,
     so it reads "flat" only when it really is. */
  function renderRecords(host) {
    host.innerHTML = "";
    meta.tierDefs.forEach(function (def, i) {
      var r = meta.records.get(def.key);
      var t = meta.records.trend(def.key);
      var row = el("div", "recrow");
      var bar = el("span", "bar");
      bar.style.background = i < 5 ? "var(--w" + (i + 1) + ")" : "var(--accent)";
      row.appendChild(bar);
      row.appendChild(el("span", "nm", def.name));
      var v;
      if (!r.wins) {
        v = "not cut yet";
      } else {
        v = "best " + fmt(r.bestMs) + " · avg " + fmt(r.avgMs) + " · " + r.wins;
        if (t.enough) {
          v += t.improving ? "  ↓ " + fmt(Math.abs(t.trendMs)) : (t.trendMs ? "  ↑ " + fmt(t.trendMs) : "  —");
        }
      }
      row.appendChild(el("span", "v", v));
      host.appendChild(row);
    });
  }

  // --------------------------------------------------------------- calendar
  var calMonth = null;   // a ms timestamp inside the shown month

  function shiftMonth(delta) {
    var d = new Date(calMonth);
    d.setUTCMonth(d.getUTCMonth() + delta);
    calMonth = d.getTime();
  }

  var MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  var DOW = ["S", "M", "T", "W", "T", "F", "S"];

  function renderCalendar(hostGrid, hostTitle, delta) {
    if (calMonth === null || delta === "reset") calMonth = Date.now();
    if (typeof delta === "number") shiftMonth(delta);

    var cal = meta.daily.calendar(calMonth);
    hostTitle.textContent = MONTHS[cal.month] + " " + cal.year;

    hostGrid.innerHTML = "";
    DOW.forEach(function (d) { hostGrid.appendChild(el("span", "cal-dow", d)); });

    // pad to the first weekday
    for (var p = 0; p < cal.days[0].dow; p++) hostGrid.appendChild(el("span", "cal-pad"));

    cal.days.forEach(function (day) {
      var b = el("button", "cal-day");
      b.type = "button";
      b.appendChild(el("span", "n", String(day.dom)));
      if (day.isToday) b.classList.add("today");

      if (day.solved) {
        b.classList.add("solved");
        var pips = el("span", "cal-stones");
        for (var s = 0; s < (day.stars || 0); s++) pips.appendChild(el("i"));
        b.appendChild(pips);
        b.title = fmt(day.ms);
      } else if (!day.playable) {
        b.classList.add("future");   // dimmed, never tappable
        b.disabled = true;
      } else {
        b.classList.add("open");
      }

      if (day.playable) {
        b.addEventListener("click", function () {
          if (hooks.onReplay) hooks.onReplay(day.dateKey, day.solved);
        });
      }
      hostGrid.appendChild(b);
    });

    var s = meta.daily.stats();
    return { solved: s.solved, streak: s.streak, best: s.best };
  }

  // ------------------------------------------------------------ text share
  /* A solved daily, in text, giving nothing away: no grid, no weights, no
     positions — only what it cost you. The core-sample image is the other,
     richer share and stays exactly as it is. */
  function summaryText(ctx) {
    var tier = M.tierByKey(ctx.tier);
    var lines = [
      "STRATA · " + ctx.dateKey,
      (tier ? tier.name : ctx.tier) + " — " + fmt(ctx.ms),
      "chain " + ctx.chain + " day" + (ctx.chain === 1 ? "" : "s"),
      ctx.hints
        ? ctx.hints + " hint" + (ctx.hints === 1 ? "" : "s") + ", " + ctx.mistakes + " mistake" + (ctx.mistakes === 1 ? "" : "s")
        : (ctx.mistakes ? ctx.mistakes + " mistake" + (ctx.mistakes === 1 ? "" : "s") + ", no hints" : "no hints, no mistakes")
    ];
    if (ctx.stones) lines.push("stones " + ctx.stones + "/3");
    return lines.join("\n");
  }

  function shareSummary(ctx, onNote) {
    var text = summaryText(ctx);
    if (navigator.share) {
      return navigator.share({ text: text, title: "STRATA" })
        .then(function () { return "share"; })
        .catch(function () { return copy(text, onNote); });
    }
    return Promise.resolve(copy(text, onNote));
  }

  function copy(text, onNote) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        if (onNote) onNote("Summary copied.");
        return "clipboard";
      }
    } catch (e) {}
    // last resort: a selectable box, because a share that silently does
    // nothing is worse than one that asks for a long-press
    var wrap = el("div", "imgwrap");
    var box = el("div", "imgbox");
    var pre = el("pre", "sharetext", text);
    var close = el("button", "btn ghost", "Close");
    box.appendChild(el("p", "say", "Copy your summary:"));
    box.appendChild(pre);
    box.appendChild(close);
    var scrim = el("div", "scrim");
    wrap.appendChild(scrim); wrap.appendChild(box);
    document.body.appendChild(wrap);
    function bye() { wrap.remove(); }
    scrim.addEventListener("click", bye);
    close.addEventListener("click", bye);
    return "inline";
  }

  return {
    init: init,
    renderStreak: renderStreak,
    renderStones: renderStones,
    stoneReason: stoneReason,
    renderRank: renderRank,
    renderRecords: renderRecords,
    renderCalendar: renderCalendar,
    shareSummary: shareSummary,
    summaryText: summaryText,
    fmt: fmt
  };
})();
