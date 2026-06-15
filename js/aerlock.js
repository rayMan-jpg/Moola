/* ============================================================================
   AERLOCK — front-end aesthetic + telemetry behaviours
   Additive enhancement layer. No design content is altered.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------------------------- Boot seq */
  function runBoot() {
    var boot = document.getElementById("aerlock-boot");
    var log = document.getElementById("aerlock-boot-log");
    var bar = document.getElementById("aerlock-boot-bar");
    if (!boot) return;

    if (reduceMotion) { boot.classList.add("done"); return; }

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
      if (frame > total) { clearInterval(timer); el.textContent = target; }
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
  function startClock() {
    var el = document.getElementById("aerlock-clock");
    if (!el) return;
    function tick() {
      var d = new Date();
      var hh = String(d.getUTCHours()).padStart(2, "0");
      var mm = String(d.getUTCMinutes()).padStart(2, "0");
      var ss = String(d.getUTCSeconds()).padStart(2, "0");
      el.textContent = hh + ":" + mm + ":" + ss + " UTC";
    }
    tick();
    setInterval(tick, 1000);
  }

  /* ---------------------------------------------------- Drifting HUD coords */
  function driftHud() {
    if (reduceMotion) return;
    var x = document.getElementById("hud-x");
    var y = document.getElementById("hud-y");
    if (!x || !y) return;
    setInterval(function () {
      x.textContent = (45 + Math.random()).toFixed(2);
      y.textContent = (12 + Math.random()).toFixed(2);
    }, 1800);
  }

  /* ----------------------------------------------------- Dial reticle ticks */
  function buildTicks() {
    var dial = document.getElementById("aerlock-dial");
    if (!dial) return;
    for (var a = 0; a < 360; a += 30) {
      var t = document.createElement("span");
      t.className = "aerlock-tick";
      t.style.transform = "rotate(" + a + "deg)";
      dial.appendChild(t);
    }
  }

  /* ------------------------------------------------------------------- Init */
  document.addEventListener("DOMContentLoaded", function () {
    runBoot();
    setupObservers();
    startClock();
    driftHud();
    buildTicks();
    document.querySelectorAll("[data-decrypt]").forEach(function (el, idx) {
      setTimeout(function () { decrypt(el); }, 600 + idx * 250);
    });
  });
})();
