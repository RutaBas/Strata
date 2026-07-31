"use strict";

/* STRATA — service worker. Cache-first app shell.

   Every shipped file is listed explicitly below. STRATA generates its boards
   on the device and stores its state in localStorage, so once the shell is
   cached the game is fully playable with no network at all — including cutting
   a brand new board.

   Bump CACHE_VERSION whenever any listed file changes; the activate handler
   deletes every cache that is not the current one. */

/* v5 — the empty mark became a × and pencil notes arrived, which changed
   index.html, css/style.css, js/ui.js, js/game.js and js/tutorial.js. Without
   this bump an already-installed player would keep the v4 shell and never see
   either change. */
var CACHE_VERSION = "strata-v8";

var PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  // the verified logic core, in load order
  "./js/model.js",
  "./js/rng.js",
  "./js/solver.js",
  "./js/generator.js",
  "./js/logic.js",
  // the shared meta-layer, vendored by games/_shared/sync.js. A service worker
  // cannot serve ../_shared/, so these MUST be listed here or the meta-layer
  // 404s the moment the network goes away.
  "./js/meta/store.js",
  "./js/meta/rng.js",
  "./js/meta/progress.js",
  "./js/meta/daily.js",
  "./js/meta/records.js",
  "./js/meta/rank.js",
  "./js/meta/index.js",
  // the app layer
  "./js/par.js",
  "./js/meta-config.js",
  "./js/meta-ui.js",
  "./js/storage.js",
  "./js/sound.js",
  "./js/game.js",
  "./js/lineage.js",
  "./js/tutorial.js",
  "./js/ui.js",
  // icons
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE_VERSION ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  // Google Fonts is a progressive enhancement; never let it block a load.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req)
        .then(function (res) {
          if (res && res.ok && res.type === "basic") {
            var copy = res.clone();
            caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
          }
          return res;
        })
        .catch(function () {
          // an offline navigation still gets the shell
          if (req.mode === "navigate") return caches.match("./index.html");
          return new Response("", { status: 504, statusText: "offline" });
        });
    })
  );
});
