/* ============================================================================
   AERLOCK — front-end aesthetic + telemetry behaviours
   Additive enhancement layer. No design content is altered.
   ========================================================================== */
(function () {
  "use strict";

  // Signal that JS is running so CSS can arm effects that would otherwise hide
  // content (reveal-on-scroll). If this script never loads, sections stay
  // visible instead of being stuck at opacity:0.
  document.documentElement.classList.add("aerlock-anim");

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var BOOT_SEEN_KEY = "aerlock.boot.seen";

  function seenBoot() {
    try { return sessionStorage.getItem(BOOT_SEEN_KEY) === "1"; } catch (e) { return false; }
  }
  function markBootSeen() {
    try { sessionStorage.setItem(BOOT_SEEN_KEY, "1"); } catch (e) {}
  }

  /* ---------------------------------------------------------------- Boot seq */
  function runBoot() {
    var boot = document.getElementById("aerlock-boot");
    var log = document.getElementById("aerlock-boot-log");
    var bar = document.getElementById("aerlock-boot-bar");
    if (!boot) return;

    // Skip the sequence on reduced-motion or on repeat visits within the session.
    if (reduceMotion || seenBoot()) { boot.classList.add("done"); markBootSeen(); return; }
    markBootSeen();

    var lines = [
      "> MOUNTING SECURE PARTITION ........ OK",
      "> NEGOTIATING ZK HANDSHAKE ......... OK",
      "> VERIFYING NULLIFIER SET .......... OK",
      "> PRESSURIZING VAULT ENVELOPE ...... OK",
      "> LINK ENCRYPTED. WELCOME OPERATOR."
    ];
    var i = 0;
    function step() {
      if (i < lines.length) {
        log.innerHTML += (i ? "<br/>" : "") + lines[i];
        bar.style.width = Math.round(((i + 1) / lines.length) * 100) + "%";
        i++;
        setTimeout(step, 240);
      } else {
        setTimeout(function () { boot.classList.add("done"); }, 350);
      }
    }
    step();
  }

  /* ------------------------------------------------------- Decrypt headline */
  function decrypt(el) {
    if (reduceMotion) return;
    var target = el.getAttribute("data-decrypt");
    var glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&@/\\";
    var frame = 0;
    var total = target.length * 3;
    // Hide the scrambling text from assistive tech while it animates; the true
    // heading text is exposed via aria-label on the <h1> (see init).
    el.setAttribute("aria-hidden", "true");
    var timer = setInterval(function () {
      var out = "";
      for (var c = 0; c < target.length; c++) {
        if (target[c] === " ") { out += " "; continue; }
        if (c < frame / 3) {
          out += target[c];
        } else {
          out += glyphs[Math.floor(Math.random() * glyphs.length)];
        }
      }
      el.textContent = out;
      frame++;
      if (frame > total) {
        clearInterval(timer);
        el.textContent = target;
        el.removeAttribute("aria-hidden");
      }
    }, 30);
  }

  /* --------------------------------------------------- Animated counters up */
  function animateCount(el) {
    var to = parseFloat(el.getAttribute("data-count"));
    var decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
    var dur = reduceMotion ? 0 : 1400;
    var start = null;
    function fmt(n) {
      return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }
    function frame(ts) {
      if (start === null) start = ts;
      var p = dur ? Math.min((ts - start) / dur, 1) : 1;
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(to * eased);
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = fmt(to);
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------ Reveal-on-scroll + once */
  function setupObservers() {
    var revealEls = document.querySelectorAll(".aerlock-reveal");
    var counted = {};
    if (!("IntersectionObserver" in window)) {
      // No IO support: just reveal everything and run counters.
      revealEls.forEach(function (el) {
        el.classList.add("is-visible");
        el.querySelectorAll("[data-count]").forEach(function (c) {
          if (!counted[c]) { counted[c] = true; animateCount(c); }
        });
      });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("is-visible");
        e.target.querySelectorAll("[data-count]").forEach(function (c) {
          if (!counted[c]) { counted[c] = true; animateCount(c); }
        });
        io.unobserve(e.target);
      });
    }, { threshold: 0.18 });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ----------------------------------------------------------- Live clock */
  var clockEls, hudX, hudY;
  function tickClock() {
    if (!clockEls || !clockEls.length || document.hidden) return;
    var d = new Date();
    var hh = String(d.getUTCHours()).padStart(2, "0");
    var mm = String(d.getUTCMinutes()).padStart(2, "0");
    var ss = String(d.getUTCSeconds()).padStart(2, "0");
    var txt = hh + ":" + mm + ":" + ss + " UTC";
    for (var i = 0; i < clockEls.length; i++) clockEls[i].textContent = txt;
  }
  function tickHud() {
    if (!hudX || !hudY || document.hidden || reduceMotion) return;
    hudX.textContent = (45 + Math.random()).toFixed(2);
    hudY.textContent = (12 + Math.random()).toFixed(2);
  }

  /* ----------------------------------------------------- Dial reticle ticks */
  function buildTicks() {
    var dial = document.getElementById("aerlock-dial");
    if (!dial) return;
    for (var a = 0; a < 360; a += 30) {
      var t = document.createElement("span");
      t.className = "aerlock-tick";
      t.style.transform = "rotate(" + a + "deg)";
      t.setAttribute("aria-hidden", "true");
      dial.appendChild(t);
    }
  }

  /* ------------------------------------------- Pause animations when hidden */
  function setupVisibilityPause() {
    function apply() {
      if (document.hidden) {
        document.documentElement.setAttribute("data-anim-paused", "");
      } else {
        document.documentElement.removeAttribute("data-anim-paused");
        tickClock(); // refresh immediately on return
      }
    }
    document.addEventListener("visibilitychange", apply);
    apply();
  }

  /* ------------------------------------------------- Mobile navigation menu */
  function setupMobileNav() {
    var btn = document.getElementById("aerlock-menu-btn");
    var panel = document.getElementById("aerlock-mobile-nav");
    if (!btn || !panel) return;
    function setOpen(open) {
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      panel.classList.toggle("hidden", !open);
      panel.classList.toggle("flex", open);
    }
    btn.addEventListener("click", function () {
      setOpen(btn.getAttribute("aria-expanded") !== "true");
    });
    // Close on link tap, Escape, or outside click.
    panel.addEventListener("click", function (e) { if (e.target.closest("a")) setOpen(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });
    document.addEventListener("click", function (e) {
      if (!panel.contains(e.target) && !btn.contains(e.target)) setOpen(false);
    });
  }

  /* ---------------------------------------------------- ENTER VAULT wiring */
  function setupVaultCta() {
    var btn = document.getElementById("aerlock-enter-vault");
    if (!btn) return;
    var label = btn.querySelector("[data-vault-label]") || btn;
    var original = label.textContent;
    var resetTimer = null;
    btn.addEventListener("click", function () {
      // Wire the real app by setting window.AERLOCK_APP_URL (see HANDOFF.md).
      if (window.AERLOCK_APP_URL) { window.location.href = window.AERLOCK_APP_URL; return; }
      label.textContent = "VAULT ACCESS PENDING";
      btn.setAttribute("aria-live", "polite");
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(function () { label.textContent = original; }, 2500);
    });
  }

  /* ------------------------------------------------------------------- Init */
  document.addEventListener("DOMContentLoaded", function () {
    clockEls = document.querySelectorAll("[data-clock]");
    hudX = document.getElementById("hud-x");
    hudY = document.getElementById("hud-y");

    runBoot();
    setupMobileNav();
    setupVaultCta();
    setupObservers();
    buildTicks();
    setupVisibilityPause();

    tickClock();
    setInterval(tickClock, 1000);
    if (!reduceMotion) setInterval(tickHud, 1800);

    // Expose the true heading text to assistive tech before scrambling begins.
    document.querySelectorAll("h1").forEach(function (h) {
      var spans = h.querySelectorAll("[data-decrypt]");
      if (spans.length) {
        var real = [];
        spans.forEach(function (s) { real.push(s.getAttribute("data-decrypt")); });
        h.setAttribute("aria-label", real.join(" "));
      }
    });

    document.querySelectorAll("[data-decrypt]").forEach(function (el, idx) {
      setTimeout(function () { decrypt(el); }, 600 + idx * 250);
    });
  });
})();
