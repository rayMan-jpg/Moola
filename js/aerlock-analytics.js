/* ============================================================================
   AERLOCK ANALYTICS — self-contained, privacy-respecting journey tracker
   ----------------------------------------------------------------------------
   - No third-party scripts, no cookies, no cross-site tracking.
   - Events are buffered in localStorage so the bundled Telemetry Console
     (analytics.html) can read and visualise them with zero backend.
   - Optionally mirrors events to a collection endpoint via navigator.sendBeacon
     when AERLOCK_ANALYTICS.endpoint is configured (see window config below).

   Tracked signals:
     * pageview        — path, referrer, viewport, UTM params
     * click           — elements with [data-track], plus buttons & links
     * section_view    — sections entering the viewport (funnel ordering)
     * scroll_depth    — 25 / 50 / 75 / 100 % milestones
     * page_exit       — total active time on page (journey duration)
   ========================================================================== */
(function () {
  "use strict";

  var CONFIG = window.AERLOCK_ANALYTICS || {};
  var STORE_KEY = "aerlock.analytics.events.v1";
  var SESSION_KEY = "aerlock.analytics.session.v1";
  var MAX_EVENTS = 5000;          // ring-buffer cap to keep localStorage small
  var ENDPOINT = CONFIG.endpoint || null;
  var DNT = navigator.doNotTrack === "1" || window.doNotTrack === "1";
  if (CONFIG.disabled || DNT) return;

  /* -------------------------------------------------------------- helpers */
  function uid() {
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();
  }

  function getSession() {
    var raw, s;
    try { raw = sessionStorage.getItem(SESSION_KEY); } catch (e) { raw = null; }
    if (raw) {
      try { s = JSON.parse(raw); } catch (e) { s = null; }
    }
    if (!s) {
      s = { id: uid(), started: Date.now(), entry: location.pathname };
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
    }
    return s;
  }

  function readEvents() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
    catch (e) { return []; }
  }

  // Persist a list, capping by count AND recovering from QuotaExceededError by
  // evicting the oldest ~20% and retrying — so a full store never wedges into
  // permanent silent write failure.
  function persist(list) {
    if (list.length > MAX_EVENTS) list = list.slice(list.length - MAX_EVENTS);
    for (var attempt = 0; attempt < 12 && list.length; attempt++) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return; }
      catch (e) {
        var drop = Math.max(1, Math.floor(list.length * 0.2));
        list = list.slice(drop);
        if (typeof console !== "undefined") console.warn("[aerlock] telemetry store full; evicted", drop, "oldest events");
      }
    }
  }

  var SESSION = getSession();

  // In-memory buffer of not-yet-flushed events. Flushing re-reads the current
  // store and merges (dedupe by id) so concurrent tabs don't clobber each other,
  // and the whole buffer is serialized once per flush instead of per event.
  var pending = [];
  var flushTimer = null;

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pending.length) return;
    var stored = readEvents();
    var seen = {};
    for (var i = 0; i < stored.length; i++) seen[stored[i].id] = true;
    for (var j = 0; j < pending.length; j++) {
      if (!seen[pending[j].id]) { stored.push(pending[j]); seen[pending[j].id] = true; }
    }
    pending = [];
    persist(stored);
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 800);
  }

  function track(type, props) {
    var ev = {
      id: uid(),
      type: type,
      ts: Date.now(),
      session: SESSION.id,
      path: location.pathname,
      props: props || {}
    };
    pending.push(ev);
    scheduleFlush();

    if (ENDPOINT && navigator.sendBeacon) {
      try {
        // text/plain keeps the beacon a CORS-simple request (no preflight).
        navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(ev)], { type: "text/plain" }));
      } catch (e) {}
    }
    // Expose a hook so other scripts can react to events if desired.
    window.dispatchEvent(new CustomEvent("aerlock:track", { detail: ev }));
    return ev;
  }

  // Public API
  window.aerlockTrack = track;
  window.aerlockFlush = flush;
  // Flush buffered events when the tab is backgrounded (most reliable moment).
  document.addEventListener("visibilitychange", function () { if (document.hidden) flush(); });

  /* ------------------------------------------------------------- pageview */
  function utmParams() {
    var p = new URLSearchParams(location.search);
    var out = {};
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach(function (k) {
      if (p.get(k)) out[k] = p.get(k);
    });
    return out;
  }

  track("pageview", {
    title: document.title,
    referrer: document.referrer || "(direct)",
    viewport: window.innerWidth + "x" + window.innerHeight,
    lang: navigator.language,
    utm: utmParams(),
    isEntry: SESSION.entry === location.pathname
  });

  /* ---------------------------------------------------------------- clicks */
  function labelFor(el) {
    if (el.getAttribute("data-track")) return el.getAttribute("data-track");
    var txt = (el.textContent || "").trim().replace(/\s+/g, " ");
    return txt.slice(0, 48) || el.tagName.toLowerCase();
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-track], button, a");
    if (!el) return;
    track("click", {
      label: labelFor(el),
      tag: el.tagName.toLowerCase(),
      href: el.getAttribute("href") || null,
      tracked: !!el.getAttribute("data-track")
    });
  }, true);

  /* --------------------------------------------------------- section_view */
  function sectionName(sec, idx) {
    if (sec.getAttribute("data-section")) return sec.getAttribute("data-section");
    var h = sec.querySelector("h1, h2, h3");
    var t = h ? h.textContent.trim().replace(/\s+/g, " ") : "Section " + (idx + 1);
    return t.slice(0, 60);
  }

  function observeSections() {
    var sections = Array.prototype.slice.call(document.querySelectorAll("main section"));
    if (!sections.length || !("IntersectionObserver" in window)) return;
    var seen = {};
    var order = 0;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var idx = sections.indexOf(en.target);
        var name = sectionName(en.target, idx);
        if (seen[name]) return;
        seen[name] = true;
        track("section_view", { name: name, order: order++ });
        io.unobserve(en.target);
      });
    }, { threshold: 0.4 });
    sections.forEach(function (s) { io.observe(s); });
  }

  /* ---------------------------------------------------------- scroll_depth */
  function observeScroll() {
    var marks = [25, 50, 75, 100];
    var hit = {};
    function check() {
      var doc = document.documentElement;
      var scrollable = doc.scrollHeight - window.innerHeight;
      // Don't emit for pages that don't scroll — otherwise a short page would
      // instantly report 100% and corrupt the "reached depth" metric.
      if (scrollable <= 0) return;
      var pct = Math.round((window.scrollY / scrollable) * 100);
      marks.forEach(function (m) {
        if (pct >= m && !hit[m]) { hit[m] = true; track("scroll_depth", { percent: m }); }
      });
    }
    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { check(); ticking = false; });
    }, { passive: true });
    // Defer the first measurement until layout has settled.
    window.addEventListener("load", check);
  }

  /* ------------------------------------------------------------ page_exit */
  function trackExit() {
    var active = 0, last = Date.now(), hidden = document.hidden;
    var exited = false;
    function accrue() { if (!hidden) active += Date.now() - last; last = Date.now(); }
    document.addEventListener("visibilitychange", function () {
      accrue(); hidden = document.hidden; last = Date.now();
    });
    // Shared guard so the exit is recorded at most once even though both
    // pagehide and beforeunload fire on a typical desktop close/navigate.
    function onExit() {
      if (exited) return;
      exited = true;
      accrue();
      track("page_exit", { activeMs: active, totalMs: Date.now() - SESSION.started });
      flush();
    }
    window.addEventListener("pagehide", onExit);
    window.addEventListener("beforeunload", onExit);
  }

  /* ------------------------------------------------------------------ init */
  document.addEventListener("DOMContentLoaded", function () {
    observeSections();
    observeScroll();
    trackExit();
  });
})();
