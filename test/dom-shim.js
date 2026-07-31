"use strict";

/* STRATA — the headless DOM shim and app boot used by the node tests.
   Lifted verbatim out of chain.test.js when a second test file (strike.test.js)
   needed the same seam. It renders nothing and asserts nothing about pixels:
   it exists so the REAL ui.js can be driven under node against the REAL logic
   core. The browser walkthrough covers everything this cannot. */

const path = require("path");
const fs = require("fs");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

// ------------------------------------------------------------- the DOM shim
/* Just enough DOM for ui.js to run: ids resolve to nodes on demand, classes
   and text are recorded, listeners are dispatchable. It renders nothing and
   asserts nothing about pixels — the browser walkthrough covers that. */
function makeDom() {
  class ClassList {
    constructor(node) { this.node = node; this.set = new Set(); }
    add(...c) { c.forEach((x) => x && this.set.add(x)); }
    remove(...c) { c.forEach((x) => this.set.delete(x)); }
    contains(c) { return this.set.has(c); }
    toggle(c, on) { if (on === undefined) on = !this.set.has(c); on ? this.add(c) : this.remove(c); return on; }
  }

  class Node {
    constructor(tag) {
      this.tagName = String(tag || "div").toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.classList = new ClassList(this);
      this.dataset = {};
      this.style = {};
      this.attrs = {};
      this._text = "";
      this._html = "";
      this.hidden = false;
      this.disabled = false;
      this.listeners = {};
      this.offsetWidth = 1;
      this.scrollTop = 0;
    }
    get className() { return Array.from(this.classList.set).join(" "); }
    set className(v) {
      this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this._html = String(v); this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this._text = String(v).replace(/<[^>]*>/g, ""); this.children = []; }
    appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
    insertBefore(n, ref) {
      const i = this.children.indexOf(ref);
      n.parentNode = this;
      this.children.splice(i < 0 ? this.children.length : i, 0, n);
      return n;
    }
    removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); return n; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) {
      const a = this.listeners[t] || [];
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    }
    dispatch(t, ev) { (this.listeners[t] || []).slice().forEach((fn) => fn.call(this, ev || { target: this })); }
    click() { if (this.onclick) this.onclick({ target: this }); this.dispatch("click"); }
    animate() { return { cancel() {}, finished: Promise.resolve() }; }
    focus() {}
    closest() { return null; }
    matches(sel) {
      const m = /^\[data-([\w-]+)="(.*)"\]$/.exec(sel);
      if (m) return this.dataset[m[1]] === m[2];
      if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
      return false;
    }
    descendants(out) {
      out = out || [];
      this.children.forEach((c) => { out.push(c); c.descendants(out); });
      return out;
    }
    querySelector(sel) {
      const hit = this.descendants().find((n) => n.matches(sel));
      if (hit) return hit;
      /* Selectors the app queries for structural chrome (".plainsub" and
         friends) must resolve to SOMETHING or ui.js throws; a lazily created
         stub child keeps the shim honest without hand-building index.html. */
      if (sel.startsWith(".")) {
        const n = new Node("div");
        n.className = sel.slice(1);
        return this.appendChild(n);
      }
      return null;
    }
    querySelectorAll(sel) { return this.descendants().filter((n) => n.matches(sel)); }
  }

  const ids = new Map();
  const document = {
    hidden: false,
    listeners: {},
    body: new Node("body"),
    documentElement: new Node("html"),
    createElement: (t) => new Node(t),
    getElementById(id) {
      if (!ids.has(id)) { const n = new Node("div"); n.attrs.id = id; ids.set(id, n); }
      return ids.get(id);
    },
    querySelector: (s) => document.body.querySelector(s),
    querySelectorAll: () => [],
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const a = this.listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    dispatch(t, ev) { (this.listeners[t] || []).slice().forEach((fn) => fn(ev || {})); }
  };

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] || null,
    get length() { return store.size; }
  };

  const window = {
    listeners: {},
    innerWidth: 390, innerHeight: 844,
    scrollTo() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const a = this.listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    dispatch(t, ev) { (this.listeners[t] || []).slice().forEach((fn) => fn(ev || {})); }
  };

  return { document, window, localStorage, Node };
}

// ------------------------------------------------------------ the app under test
function bootApp(mutateUiSource) {
  const dom = makeDom();
  const sandbox = {
    document: dom.document,
    window: dom.window,
    localStorage: dom.localStorage,
    navigator: { vibrate() {}, share: undefined, clipboard: undefined, userAgent: "node" },
    location: { href: "http://localhost/", protocol: "http:" },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    console, Math, Date, JSON, Promise,
    performance: { now: () => Date.now() }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window.document = dom.document;
  vm.createContext(sandbox);

  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });

  // real logic core + real storage + real game + real meta library
  ["js/model.js", "js/rng.js", "js/solver.js", "js/generator.js", "js/logic.js",
   "js/storage.js", "js/game.js",
   "js/meta/store.js", "js/meta/rng.js", "js/meta/progress.js", "js/meta/daily.js",
   "js/meta/records.js", "js/meta/rank.js", "js/meta/index.js",
   "js/par.js", "js/meta-config.js"].forEach(load);

  /* Presentation-only collaborators are stubbed: they draw, they do not
     decide. The chain lives in model.js and the day boundary lives in ui.js,
     and both of those are the REAL files here. */
  vm.runInContext(`
    /* A no-op object for any method name: these collaborators DRAW, they do
       not decide, and stubbing them by name would rot the moment one gains a
       method. Anything that must return a value is named explicitly. */
    function nullDouble(named) {
      return new Proxy(named || {}, {
        get: function (t, k) {
          if (k in t) return t[k];
          return function () { return undefined; };
        }
      });
    }
    var Sound = nullDouble({});
    var Lineage = nullDouble({ UNLOCK_DAY: 7, summarise: function(){ return { boards: 0 }; },
                               shareText: function(){ return ""; } });
    var MetaUI = nullDouble({ renderCalendar: function(){ return {}; },
                              stoneReason: function(){ return ""; } });
    var StrataTutorial = nullDouble({});
  `, sandbox);

  let uiSrc = fs.readFileSync(path.join(ROOT, "js", "ui.js"), "utf8");
  if (mutateUiSource) {
    const before = uiSrc;
    uiSrc = mutateUiSource(uiSrc);
    if (uiSrc === before) throw new Error("the ui.js mutation did not apply — the test is lying");
  }
  vm.runInContext(uiSrc, sandbox, { filename: "js/ui.js" });

  // spy on the ONE meta hook, without changing what it does
  const winCalls = [];
  const realRecordWin = sandbox.Meta.recordWin;
  sandbox.Meta.recordWin = function (ctx) { winCalls.push(ctx); return realRecordWin.call(sandbox.Meta, ctx); };

  return { sandbox, dom, winCalls, UI: sandbox.UI, T: sandbox.UI._test };
}

module.exports = { makeDom, bootApp, ROOT };
