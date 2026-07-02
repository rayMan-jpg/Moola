/* Glyph ASCII ad player — dependency-free <canvas> renderer for frame packs.
 *
 * Usage:
 *   const player = new GlyphPlayer(canvasEl, pack, { loop: true });
 *   player.play();
 *
 * Emits watch-verification heartbeats via `onHeartbeat(secondsWatched)` —
 * the hook the earnings ledger consumes. Playback pauses automatically when
 * the tab loses focus, so hidden tabs never accrue watch time.
 */
class GlyphPlayer {
  constructor(canvas, pack, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.pack = pack;
    this.loop = opts.loop ?? true;
    this.fontFamily = opts.fontFamily ?? "'Courier New', monospace";
    this.background = opts.background ?? "#0a0a0a";
    this.monoColor = opts.monoColor ?? "#3ddc84";
    this.onHeartbeat = opts.onHeartbeat ?? null;
    this.onEnded = opts.onEnded ?? null;

    this.frame = 0;
    this.playing = false;
    this._raf = null;
    this._lastTick = 0;
    this._watched = 0; // whole seconds of verified watch time reported

    this._fitCanvas();
    window.addEventListener("resize", () => { this._fitCanvas(); this._draw(); });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause(); else if (this._wasPlaying) this.play();
    });
    this._draw();
  }

  _fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
    this.cellW = cssW / this.pack.cols;
    this.cellH = this.cellW * 2; // glyph cells are ~2x taller than wide
    const cssH = this.cellH * this.pack.rows;
    this.canvas.width = cssW * dpr;
    this.canvas.height = cssH * dpr;
    this.canvas.style.height = cssH + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.font = `${this.cellH * 0.95}px ${this.fontFamily}`;
    this.ctx.textBaseline = "top";
  }

  _draw() {
    const { pack, ctx } = this;
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const text = pack.frames[this.frame].split("\n");

    if (pack.mode === "color") {
      const colors = pack.colors[this.frame].split("\n");
      for (let r = 0; r < pack.rows; r++) {
        const line = text[r], cline = colors[r];
        // Draw runs of same-colored cells in one fillText call.
        let start = 0;
        for (let c = 1; c <= pack.cols; c++) {
          if (c === pack.cols || cline[c] !== cline[start]) {
            ctx.fillStyle = pack.palette[parseInt(cline[start], 16)];
            ctx.fillText(line.slice(start, c), start * this.cellW, r * this.cellH);
            start = c;
          }
        }
      }
    } else {
      ctx.fillStyle = this.monoColor;
      for (let r = 0; r < pack.rows; r++) {
        ctx.fillText(text[r], 0, r * this.cellH);
      }
    }
  }

  _tick(ts) {
    if (!this.playing) return;
    if (!this._lastTick) this._lastTick = ts;
    const frameMs = 1000 / this.pack.fps;
    if (ts - this._lastTick >= frameMs) {
      this._lastTick = ts;
      this.frame++;
      if (this.frame >= this.pack.frames.length) {
        if (this.loop) {
          this.frame = 0;
        } else {
          this.frame = this.pack.frames.length - 1;
          this.pause();
          this.onEnded && this.onEnded();
          return;
        }
      }
      this._draw();
      const secondsIn = Math.floor(this.frame / this.pack.fps);
      if (secondsIn > this._watched) {
        this._watched = secondsIn;
        this.onHeartbeat && this.onHeartbeat(this._watched);
      }
    }
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._wasPlaying = true;
    this._lastTick = 0;
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}

if (typeof module !== "undefined") module.exports = { GlyphPlayer };
