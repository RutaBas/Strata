"use strict";
/* One IIFE per logic file — see the note in model.js. */
(function (root) {

/* Seeded PRNG (mulberry32). Every random choice in STRATA's generator flows
   through one of these streams, so a (tier, seed, bedrock) triple fully
   reproduces a board — that is what lets the daily be regenerated from
   localStorage without storing the whole grid. */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/* Deterministic 32-bit hash of a string. Used to turn a date key like
   "2026-07-27" plus a tier into the daily board's seed. */
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* Fisher-Yates using a supplied rng(). Mutates and returns the array. */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

const API = { mulberry32, randomSeed, hashString, shuffle };

root.StrataRng = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
