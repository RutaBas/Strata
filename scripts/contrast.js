"use strict";

/* WCAG AA contrast audit for the STRATA palette.
   Run: node scripts/contrast.js
   Every numeral-on-stone pair is a hard 4.5:1 floor (design brief, stage 2). */

function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const LIGHT = {
  paper: "#e6e0d4", panel: "#d9d2c3", panel2: "#cfc6b4",
  ink: "#241f19", dim: "#5a5245", accent: "#b4522a", accentDark: "#8e3f20",
  accentInk: "#ffffff", accentStamp: "#8e3f20", moss: "#4f6b5e", mossInk: "#455e52",
};
const DARK = {
  paper: "#1b1915", panel: "#262219", panel2: "#2f2a20",
  ink: "#ece5d7", dim: "#a99c86", accent: "#d9764a", accentDark: "#a8502a",
  accentInk: "#241f19", accentStamp: "#e08a5f", moss: "#7fa392", mossInk: "#8fb3a1",
};
const W = ["#d6c9a8", "#c2ab7d", "#9d8358", "#6b563a", "#3d3226"];
const STONE_INK = "#241f19";       // weights 1-3
const STONE_INK_DEEP = "#f2ece0";  // weights 4-5 (the ink flips)

/* The empty mark is a 55%-alpha ink glyph, so what the eye actually sees is
   the composite over the cell behind it. Flatten it before measuring rather
   than measuring the token and pretending. */
function over(fg, bg, alpha) {
  const px = (h, i) => parseInt(h.substr(i, 2), 16);
  const mix = (i) => Math.round(alpha * px(fg, i) + (1 - alpha) * px(bg, i));
  return "#" + [1, 3, 5].map((i) => mix(i).toString(16).padStart(2, "0")).join("");
}

let fails = 0;
function row(label, fg, bg, floor) {
  const r = ratio(fg, bg);
  const pass = r >= floor;
  if (!pass) fails++;
  console.log(
    (pass ? "  PASS  " : "  FAIL  ") + label.padEnd(38) +
    fg + " on " + bg + "  " + r.toFixed(2) + ":1  (floor " + floor + ")"
  );
}

console.log("\nNUMERAL ON STONE — the hard floor, identical in both themes");
W.forEach((bg, i) => {
  const fg = i < 3 ? STONE_INK : STONE_INK_DEEP;
  row("weight " + (i + 1) + " numeral", fg, bg, 4.5);
});

[["LIGHT", LIGHT], ["DARK", DARK]].forEach(([name, P]) => {
  console.log("\n" + name + " THEME — chrome text");
  row("body ink on paper", P.ink, P.paper, 4.5);
  row("ink on panel", P.ink, P.panel, 4.5);
  row("secondary text on paper", P.dim, P.paper, 4.5);
  row("secondary text on panel", P.dim, P.panel, 4.5);
  row("secondary text on empty cell", P.dim, P.panel2, 4.5);
  row("clue numeral on paper", P.dim, P.paper, 4.5);
  row("satisfied clue (moss ink) on paper", P.mossInk, P.paper, 4.5);
  row("primary button label on accent", P.accentInk, P.accent, 4.5);
  row("stamp text on paper", P.accentStamp, P.paper, 4.5);
  // the hint bar and the toast are the same inverted pair; the hint bar sets
  // 107 characters of reasoning in it, so it is audited rather than assumed
  row("hint text on ink", P.paper, P.ink, 4.5);
  row("lesson nudge on paper", P.dim, P.paper, 4.5);
  // the field lesson's new surfaces: the ladder step's tier rows, the measured
  // footnote under them, the returning-player line and the Leave control
  row("lesson ladder tier name on panel", P.ink, P.panel, 4.5);
  row("lesson ladder technique on panel", P.dim, P.panel, 4.5);
  row("lesson ladder footnote on paper", P.dim, P.paper, 4.5);
  row("lesson replay hint on paper", P.mossInk, P.paper, 4.5);
  row("lesson leave control on paper", P.accentStamp, P.paper, 4.5);

  /* The empty mark and the pencil-note cluster.
     The × is a non-text graphical indicator of state, deliberately held under
     the stones so 20 of them on a board do not out-shout the content, so it
     is held to WCAG 1.4.11's 3:1 for non-text contrast — not to 4.5:1, which
     it would only reach by becoming as loud as a numeral. The note cluster is
     read as text (digits you must tell apart), so it takes the full 4.5:1.
     Both floors are stated here so a future nudge to either colour fails
     loudly against the right bar. */
  const markInk = name === "LIGHT" ? "#241f19" : "#ece5d7";
  row("empty mark (x, 55%) on empty cell", over(markInk, P.panel2, 0.55), P.panel2, 3.0);
  row("empty mark (x, 55%) on keypad panel", over(markInk, P.panel, 0.55), P.panel, 3.0);
  row("pencil note cluster on empty cell", P.dim, P.panel2, 4.5);
  row("NOTES key label while lit", P.accentInk, P.accent, 4.5);
});

console.log("\n" + (fails
  ? fails + " PAIR(S) BELOW THEIR FLOOR"
  : "every pair clears its floor — text at AA 4.5:1, the empty mark at 1.4.11's 3:1"));
process.exit(fails ? 1 : 0);
