"use strict";

/* STRATA — sound. Set 2 "Stoneware" from design-sound.html, with the one swap
   Ruta made: the crumble comes from set 1 "Graphite" (the dry noise cascade),
   because a stone crumbling should sound like material failing, not like a note
   being played.

   Synthesis helpers are lifted verbatim from the picker, so what shipped is
   what was auditioned. Nothing here loads an asset file.

   The AudioContext is built lazily on the first gesture — iOS refuses to start
   one before a user interaction. */

var Sound = (function () {

  var ctx = null;
  var enabled = true;
  var hapticsOn = true;

  function ac() {
    if (!enabled) return null;
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    } catch (e) { return null; }
  }

  /* --- helpers, verbatim from design-sound.html ------------------------- */
  function tone(opts) {
    var o_ = opts || {};
    var freq = o_.freq === undefined ? 440 : o_.freq;
    var dur = o_.dur === undefined ? 0.12 : o_.dur;
    var type = o_.type || "sine";
    var gain = o_.gain === undefined ? 0.18 : o_.gain;
    var at = o_.at || 0;
    var slideTo = o_.slideTo || null;
    var detune = o_.detune || 0;
    var c = ac(); if (!c) return;
    var t0 = c.currentTime + at;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0); o.detune.value = detune;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  function noise(opts) {
    var o_ = opts || {};
    var dur = o_.dur === undefined ? 0.12 : o_.dur;
    var gain = o_.gain === undefined ? 0.18 : o_.gain;
    var at = o_.at || 0;
    var type = o_.type || "bandpass";
    var freq = o_.freq === undefined ? 1400 : o_.freq;
    var q = o_.q === undefined ? 1.2 : o_.q;
    var sweepTo = o_.sweepTo || null;
    var c = ac(); if (!c) return;
    var t0 = c.currentTime + at, n = Math.floor(c.sampleRate * dur);
    var buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var s = c.createBufferSource(); s.buffer = buf;
    var f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    var g = c.createGain();
    g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(c.destination);
    s.start(t0); s.stop(t0 + dur);
  }

  /* --- the moments ------------------------------------------------------ */
  var S = {
    // Stoneware · every move, the tick you stop noticing
    place: function () {
      tone({ freq: 294, dur: 0.13, type: "sine", gain: 0.20, slideTo: 262 });
      noise({ dur: 0.03, gain: 0.09, freq: 3000 });
    },
    // Stoneware · count + load both satisfied
    line: function () {
      tone({ freq: 392, dur: 0.16, type: "sine", gain: 0.16 });
      tone({ freq: 587, dur: 0.20, type: "sine", gain: 0.10, at: 0.07 });
    },
    // Stoneware · gentle refusal, never punishing
    invalid: function () {
      tone({ freq: 196, dur: 0.18, type: "square", gain: 0.09, slideTo: 139 });
    },
    // GRAPHITE · the swap — dry noise cascade, material failing
    crumble: function () {
      for (var i = 0; i < 7; i++) {
        noise({ dur: 0.13, gain: 0.09, freq: 1500 - i * 130, q: 0.9, at: i * 0.045 });
      }
    },
    // Stoneware · the payoff, held back so it still means something
    win: function () {
      [262, 311, 392, 466, 523].forEach(function (f, i) {
        tone({ freq: f, dur: 0.55, type: "sine", gain: 0.15, at: i * 0.085 });
      });
      tone({ freq: 131, dur: 1.2, type: "sine", gain: 0.13, at: 0.36 });
      noise({ dur: 0.5, gain: 0.06, freq: 2600, q: 0.6, sweepTo: 600, at: 0.42 });
    },
    // a quiet marker for the survival reveal (one stone mineralising)
    mineral: function () {
      tone({ freq: 349, dur: 0.22, type: "sine", gain: 0.10, slideTo: 262 });
    }
  };

  var HAPTIC = {
    place: 8, line: [0, 12, 40, 12], invalid: 24, crumble: [0, 6, 30, 6, 30, 6],
    win: [0, 18, 60, 18, 60, 42], mineral: 6
  };

  function play(name) {
    var fn = S[name];
    if (fn && enabled) { try { fn(); } catch (e) {} }
    buzz(name);
  }

  function buzz(name) {
    if (!hapticsOn) return;
    var p = HAPTIC[name];
    if (p && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} }
  }

  function setEnabled(v) { enabled = !!v; }
  function setHaptics(v) { hapticsOn = !!v; }
  /* Called from the first touch so iOS unlocks the context in-gesture. */
  function unlock() { ac(); }

  return {
    play: play, unlock: unlock,
    setEnabled: setEnabled, setHaptics: setHaptics,
    tone: tone, noise: noise
  };
})();
