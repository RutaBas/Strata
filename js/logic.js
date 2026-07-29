"use strict";

/* STRATA — logic loader.

   model.js, rng.js, solver.js and generator.js are CommonJS modules for node,
   and every one of them declares top-level `const N`, `const M`, `const API`…
   In a browser all classic <script> tags share ONE global lexical scope, so
   loading them plainly would kill the second with "Identifier 'N' has already
   been declared".

   The fix lives in those files: each wraps its body in a single IIFE and
   publishes a namespaced global (StrataModel, StrataRng, StrataSolver,
   StrataGenerator) alongside its module.exports. Node is unaffected — the
   verification harness still requires them exactly as before. Load order is
   declared in index.html and matters: model, rng, solver, generator, then this.

   load() stays a promise so the UI's call site does not care whether the core
   ever needs asynchronous setup. Nothing here touches the DOM and nothing here
   contains game logic; it only hands over the four modules. */

var StrataLogic = (function (root) {
  var MODULES = [
    ["model", "StrataModel"],
    ["rng", "StrataRng"],
    ["solver", "StrataSolver"],
    ["generator", "StrataGenerator"],
  ];

  function collect() {
    var api = {};
    var missing = [];
    MODULES.forEach(function (pair) {
      var mod = root[pair[1]];
      if (!mod) missing.push(pair[1]);
      api[pair[0]] = mod;
    });
    if (missing.length) {
      throw new Error(
        "logic core did not load: missing " + missing.join(", ") +
        " — check the <script> order in index.html"
      );
    }
    if (!api.model.N || !api.generator.generate || !api.solver.solve) {
      throw new Error("logic core loaded but did not export its API");
    }
    return api;
  }

  var loaded = null;

  /* -> Promise<{model, rng, solver, generator}> */
  function load() {
    if (!loaded) {
      loaded = new Promise(function (resolve) { resolve(collect()); });
    }
    return loaded;
  }

  return { load: load };
})(typeof globalThis !== "undefined" ? globalThis : this);
