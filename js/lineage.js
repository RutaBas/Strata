"use strict";

/* STRATA — the lineage view and the core-sample image export.

   Unlocks on day 7 (chain.day >= 7). It reads `strata:history` and nothing
   else: a vertical drill core of every completed board, most recent at the
   TOP, continuous and layered top to bottom. Survivors are coloured BY AGE
   until an old stone reads as nearly black — that ramp is the whole point of
   the screen, so age 1 and age 6 are deliberately far apart.

   A chain break renders as a horizontal fault line across the column, using
   the dashed fault treatment from design-screens.html screen 5.

   The export is an IMAGE, never an emoji grid, and it deliberately leaks no
   solvable information: no numerals, and every non-surviving stone is drawn as
   one neutral tone, so the weights of a board someone else has not played yet
   cannot be read off it. */

var Lineage = (function () {

  var M = null;
  var onBack = null;

  /* Age ramp. Age 1 is warm ochre, age 6+ is nearly black — the ramp is the
     point of this screen, so it is stepped in LUMINANCE rather than by eye:
     each age is 1.54:1 against its neighbour and age 1 is 8.91:1 against age
     6, so no two adjacent ages are "two neighbouring browns". */
  var AGE = ["#d3aa72", "#a9885a", "#836945", "#624d32", "#40321f", "#140e06"];
  var NEUTRAL = "#b9ad95";   // a stone that did not survive
  var VOID_ = "#ddd6c7";     // an empty cell
  var PAPER = "#e6e0d4";
  var INK = "#241f19";
  var DIM = "#5a5245";
  var OXIDE = "#b4522a";

  function ageColor(age) {
    var a = Math.max(1, Math.min(AGE.length, age || 1));
    return AGE[a - 1];
  }

  function init(model) { M = model; }

  // ------------------------------------------------------------- the model
  /* Turn raw history into a top-down list of slabs plus the faults between
     them. History is stored oldest-first; the core reads newest-first. */
  function build(history) {
    var rows = [];
    var h = (history || []).slice();
    for (var k = h.length - 1; k >= 0; k--) {
      var e = h[k];
      var prev = h[k - 1];
      rows.push({ kind: "slab", entry: e });
      if (prev) {
        var gap = M.daysBetween(prev.date, e.date);
        if (gap > 1) {
          rows.push({ kind: "fault", days: gap - 1, at: prev.chain || 0, date: e.date });
        }
      }
    }
    return rows;
  }

  function survivorAges(entry) {
    var ages = {};
    var list = entry.survivors || [];
    for (var i = 0; i < list.length; i++) ages[list[i]] = 1;
    if (entry.seed !== null && entry.seed !== undefined) ages[entry.seed] = ages[entry.seed] || 1;
    // entries written since this pass carry the real outgoing age per stone
    if (entry.ages) {
      Object.keys(entry.ages).forEach(function (i) { ages[i] = entry.ages[i]; });
    }
    return ages;
  }

  function summarise(history) {
    var h = history || [];
    var tiers = {};
    h.forEach(function (e) { tiers[e.tier] = (tiers[e.tier] || 0) + 1; });
    var mix = Object.keys(tiers)
      .sort(function (a, b) { return tiers[b] - tiers[a]; })
      .map(function (t) {
        var tier = M.tierByKey(t);
        return (tier ? tier.name : t) + " ×" + tiers[t];
      });
    var longest = 0;
    h.forEach(function (e) { if ((e.chain || 0) > longest) longest = e.chain; });
    return {
      boards: h.length,
      first: h.length ? h[0].date : null,
      last: h.length ? h[h.length - 1].date : null,
      longest: longest,
      current: h.length ? h[h.length - 1].chain || 0 : 0,
      mix: mix,
    };
  }

  function pretty(dateKey) {
    if (!dateKey) return "";
    var d = new Date(dateKey + "T12:00:00");
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  // ------------------------------------------------------------ DOM render
  function render(host, history) {
    var rows = build(history);
    host.innerHTML = "";
    if (!rows.length) {
      var p = document.createElement("p");
      p.className = "say";
      p.textContent = "Nothing in the core yet.";
      host.appendChild(p);
      return;
    }
    rows.forEach(function (row) {
      host.appendChild(row.kind === "fault" ? faultNode(row) : slabNode(row.entry));
    });
  }

  function faultNode(row) {
    var wrap = document.createElement("div");
    wrap.className = "lin-fault";
    var line = document.createElement("div");
    line.className = "fault";
    var lab = document.createElement("div");
    lab.className = "lin-faultlab";
    lab.textContent = "chain broke · " + row.days + " day" + (row.days === 1 ? "" : "s") + " missed";
    wrap.appendChild(line);
    wrap.appendChild(lab);
    return wrap;
  }

  function slabNode(entry) {
    var ages = survivorAges(entry);
    var wrap = document.createElement("div");
    wrap.className = "lin-slab";

    var grid = document.createElement("div");
    grid.className = "lin-grid";
    for (var i = 0; i < 49; i++) {
      var v = entry.grid[i];
      var cell = document.createElement("i");
      if (v > 0 && ages[i]) {
        cell.style.background = ageColor(ages[i]);
        // the ramp crosses over at age 3, so the numeral flips with it
        cell.style.color = ages[i] <= 2 ? "rgba(36,31,25,.85)" : "rgba(242,236,224,.85)";
        cell.className = "surv";
        cell.textContent = String(ages[i]);
      } else if (v > 0) {
        cell.style.background = NEUTRAL;
      } else {
        cell.style.background = VOID_;
      }
      grid.appendChild(cell);
    }

    var meta = document.createElement("div");
    meta.className = "lin-meta";
    var tier = M.tierByKey(entry.tier);
    meta.innerHTML =
      '<span class="d">' + pretty(entry.date) + "</span>" +
      '<span class="t">' + (tier ? tier.name : entry.tier) + "</span>" +
      '<span class="c">day ' + (entry.chain || 0) + "</span>";

    wrap.appendChild(grid);
    wrap.appendChild(meta);
    return wrap;
  }

  // --------------------------------------------------------- canvas export
  /* The shareable core sample. Everything here is drawn, nothing is a font
     the device might not have beyond the mono/sans fallback chain. */
  function toCanvas(history, chain) {
    var rows = build(history);
    var MAXSLABS = 30;
    var shown = 0;
    var trimmed = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].kind === "slab") {
        if (shown >= MAXSLABS) break;
        shown++;
      }
      trimmed.push(rows[i]);
    }
    var sum = summarise(history);

    var S = 2;                       // 2x device scale
    var W = 420;
    var cell = 26;
    var colW = cell * 7;
    var colX = (W - colW) / 2;
    var headH = 132;
    var footH = 76;
    var faultH = 34;
    var bodyH = trimmed.reduce(function (a, r) { return a + (r.kind === "fault" ? faultH : colW); }, 0);
    var H = headH + bodyH + footH;

    var cv = document.createElement("canvas");
    cv.width = W * S;
    cv.height = H * S;
    var x = cv.getContext("2d");
    x.scale(S, S);
    x.textBaseline = "alphabetic";

    var mono = '600 13px "IBM Plex Mono", ui-monospace, monospace';
    var monoS = '11px "IBM Plex Mono", ui-monospace, monospace';

    // ground
    x.fillStyle = PAPER;
    x.fillRect(0, 0, W, H);

    // header
    x.fillStyle = INK;
    x.font = '700 30px "IBM Plex Mono", ui-monospace, monospace';
    x.letterSpacing = "6px";
    x.fillText("STRATA", colX, 52);
    x.letterSpacing = "0px";
    x.fillStyle = DIM;
    x.font = monoS;
    x.fillText("core sample · " + sum.boards + " board" + (sum.boards === 1 ? "" : "s"), colX, 72);

    x.fillStyle = OXIDE;
    x.fillRect(colX, 84, 46, 30);
    x.fillStyle = "#ffffff";
    x.font = '700 17px "IBM Plex Mono", ui-monospace, monospace';
    x.fillText(String(chain && chain.length ? chain.length : sum.current), colX + 8, 106);
    x.fillStyle = DIM;
    x.font = monoS;
    x.fillText("DAY CHAIN · LONGEST " + Math.max(sum.longest, (chain && chain.longest) || 0), colX + 56, 96);
    x.fillText(pretty(sum.first) + " – " + pretty(sum.last), colX + 56, 110);

    // the core itself
    var y = headH;
    trimmed.forEach(function (row) {
      if (row.kind === "fault") {
        x.strokeStyle = INK;
        x.lineWidth = 3;
        x.setLineDash([6, 5]);
        x.beginPath();
        x.moveTo(colX, y + faultH / 2);
        x.lineTo(colX + colW, y + faultH / 2);
        x.stroke();
        x.setLineDash([]);
        x.fillStyle = DIM;
        x.font = '9px "IBM Plex Mono", ui-monospace, monospace';
        x.fillText("chain broke", colX, y + faultH / 2 + 14);
        y += faultH;
        return;
      }
      var e = row.entry;
      var ages = survivorAges(e);
      for (var i = 0; i < 49; i++) {
        var v = e.grid[i];
        var cx = colX + (i % 7) * cell;
        var cy = y + Math.floor(i / 7) * cell;
        // No numerals anywhere, and every non-survivor is one flat tone, so
        // the image cannot be read as a solution to anyone else's board.
        x.fillStyle = v > 0 && ages[i] ? ageColor(ages[i]) : v > 0 ? NEUTRAL : VOID_;
        x.fillRect(cx, cy, cell - 1, cell - 1);
      }
      x.fillStyle = DIM;
      x.font = '9px "IBM Plex Mono", ui-monospace, monospace';
      x.fillText(pretty(e.date), colX + colW + 8, y + 12);
      y += colW;
    });

    // footer
    x.fillStyle = DIM;
    x.font = monoS;
    var mix = sum.mix.join(" · ");
    if (mix.length > 46) mix = mix.slice(0, 45) + "…";
    x.fillText(mix, colX, y + 24);
    x.fillStyle = INK;
    x.font = mono;
    x.fillText("older stones run darker", colX, y + 46);
    // the age ramp as a legend
    for (var a = 0; a < AGE.length; a++) {
      x.fillStyle = AGE[a];
      x.fillRect(colX + a * 16, y + 54, 14, 12);
    }

    return cv;
  }

  /* Offer the image: Web Share with the file, then a download, then the blob
     in a new tab, and finally inline with a press-and-hold prompt — which is
     the path iOS Safari from file:// actually takes. Returns the route used. */
  function share(canvas, caption, onNote) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        if (!blob) { resolve("failed"); return; }
        var name = "strata-core.png";

        function inline() {
          var url = URL.createObjectURL(blob);
          var wrap = document.createElement("div");
          wrap.className = "imgwrap";
          wrap.innerHTML =
            '<div class="scrim"></div><div class="imgbox">' +
            '<p class="say">Press and hold the core to save it.</p>' +
            '<img alt="Your STRATA core sample" src="' + url + '">' +
            '<button class="btn ghost" type="button">Close</button></div>';
          document.body.appendChild(wrap);
          function close() { wrap.remove(); URL.revokeObjectURL(url); }
          wrap.querySelector(".scrim").addEventListener("click", close);
          wrap.querySelector("button").addEventListener("click", close);
          resolve("inline");
        }

        // 1 · share sheet with the actual file
        try {
          if (typeof File === "function" && navigator.share && navigator.canShare) {
            var file = new File([blob], name, { type: "image/png" });
            if (navigator.canShare({ files: [file] })) {
              navigator.share({ files: [file], text: caption })
                .then(function () { resolve("share"); })
                .catch(function () { inline(); });
              return;
            }
          }
        } catch (e) { /* fall through */ }

        // 2 · download, where the browser supports the attribute
        var a = document.createElement("a");
        if ("download" in a && !isIOS()) {
          var url = URL.createObjectURL(blob);
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
          if (onNote) onNote("Saved as " + name + ".");
          resolve("download");
          return;
        }

        // 3 · the blob in a new tab
        try {
          var u = URL.createObjectURL(blob);
          var win = window.open(u, "_blank");
          if (win) { resolve("tab"); return; }
          URL.revokeObjectURL(u);
        } catch (e) { /* fall through */ }

        // 4 · inline, press and hold
        inline();
      }, "image/png");
    });
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function caption(history, chain) {
    var sum = summarise(history);
    return "STRATA — " + (chain ? chain.length : sum.current) + " day chain, " +
      sum.boards + " cores, " + pretty(sum.first) + " to " + pretty(sum.last) + ".";
  }

  return {
    init: init, render: render, build: build, summarise: summarise,
    toCanvas: toCanvas, share: share, caption: caption, ageColor: ageColor,
    UNLOCK_DAY: 7,
  };
})();
