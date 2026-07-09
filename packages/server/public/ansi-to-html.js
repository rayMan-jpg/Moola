/**
 * Converts Moola's ANSI dialect to HTML. The transcoder emits only three
 * sequences — truecolor foreground (38;2;r;g;b), truecolor background
 * (48;2;r;g;b) and reset (0m) — plus ▀ characters and newlines, so this
 * parser can stay tiny.
 */
const SGR = /^\x1b\[(?:38;2;(\d+);(\d+);(\d+)|48;2;(\d+);(\d+);(\d+)|0)m/;

export function ansiFrameToHtml(frame) {
  let html = '';
  let fg = null;
  let bg = null;
  let run = '';

  const flush = () => {
    if (!run) return;
    const style =
      (fg ? `color:${fg};` : '') + (bg ? `background:${bg}` : '');
    html += style ? `<span style="${style}">${run}</span>` : run;
    run = '';
  };

  let i = 0;
  while (i < frame.length) {
    const ch = frame[i];
    if (ch === '\x1b') {
      const m = SGR.exec(frame.slice(i, i + 24));
      if (m) {
        flush();
        if (m[1] !== undefined) fg = `rgb(${m[1]},${m[2]},${m[3]})`;
        else if (m[4] !== undefined) bg = `rgb(${m[4]},${m[5]},${m[6]})`;
        else { fg = null; bg = null; }
        i += m[0].length;
        continue;
      }
      i += 1; // unknown escape byte — drop it
      continue;
    }
    if (ch === '\n') {
      flush();
      html += '\n';
      i += 1;
      continue;
    }
    run += ch;
    i += 1;
  }
  flush();
  return html;
}

/**
 * Plays a FrameAsset inside a <pre>. Frame HTML is converted lazily and
 * cached. Returns a stop() function.
 */
export function playInPre(asset, pre) {
  const cache = new Array(asset.frames.length);
  let idx = 0;
  const draw = () => {
    cache[idx] ??= ansiFrameToHtml(asset.frames[idx]);
    pre.innerHTML = cache[idx];
    idx = (idx + 1) % asset.frames.length;
  };
  draw();
  const timer = setInterval(draw, 1000 / asset.fps);
  return () => clearInterval(timer);
}
