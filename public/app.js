'use strict';

const $ = (sel, el = document) => el.querySelector(sel);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const METHOD_NAMES = {
  MoonsightingCommittee: 'Moonsighting Committee (worldwide)',
  MuslimWorldLeague: 'Muslim World League',
  NorthAmerica: 'ISNA (North America)',
  Egyptian: 'Egyptian General Authority',
  Karachi: 'Univ. of Islamic Sciences, Karachi',
  UmmAlQura: 'Umm al-Qura (Makkah)',
  Dubai: 'Dubai',
  Kuwait: 'Kuwait',
  Qatar: 'Qatar',
  Singapore: 'Singapore (MUIS)',
  Tehran: 'Tehran',
  Turkey: 'Turkey (Diyanet)',
};

let server = null; // last /api/state payload
let form = null; // editable copy of settings
let dirty = false;
let optionsBuilt = false;

/* ---------- helpers ---------- */

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-region').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function setDirty() {
  dirty = JSON.stringify(form) !== JSON.stringify(server.settings);
  $('#save-bar').classList.toggle('show', dirty);
}

function countdown(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m >= 15) return `${m}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

/* ---------- state ---------- */

async function fetchState() {
  try {
    server = await api('/api/state');
    if (!dirty) form = structuredClone(server.settings);
    render();
  } catch (err) {
    toast(`Cannot reach the server: ${err.message}`, 'error');
  }
}

function render() {
  renderHeader();
  renderToday();
  renderDevices();
  renderMedia();
  renderLog();
  if (!dirty) renderForm();
}

/* ---------- rendering ---------- */

function renderHeader() {
  const pill = $('#next-pill');
  if (server.next) {
    pill.hidden = false;
    pill.dataset.epoch = server.next.epochMs;
    pill.dataset.name = server.next.name;
    tick();
  } else {
    pill.hidden = true;
  }
}

function renderToday() {
  $('#today-date').textContent = `${server.date} · ${server.zone}`;
  const list = $('#today-list');
  list.innerHTML = server.today
    .map((p) => {
      const cls = ['prayer', p.key, p.past ? 'past' : '', p.next ? 'next' : ''].filter(Boolean).join(' ');
      const enabled = form ? !!form.adhaan.prayers[p.key] : p.enabled;
      const control = p.isPrayer
        ? `<label class="switch" title="Play adhaan for ${esc(p.name)}">
             <input type="checkbox" class="prayer-toggle" data-key="${p.key}" ${enabled ? 'checked' : ''}
               aria-label="Play adhaan for ${esc(p.name)}">
             <span class="track"></span>
           </label>`
        : '<span class="switch-spacer" aria-hidden="true"></span>';
      const sub = p.next
        ? `<span class="p-sub" data-countdown data-epoch="${p.epochMs}"></span>`
        : p.isPrayer && !enabled
          ? '<span class="p-sub">adhaan off</span>'
          : '';
      return `<li class="${cls}">
        <span class="p-name">${esc(p.name)}${sub}</span>
        <span class="p-arabic" lang="ar" dir="rtl">${esc(p.arabic)}</span>
        <span class="p-time">${esc(p.display)}</span>
        ${control}
      </li>`;
    })
    .join('');
  tick();
}

function renderDevices() {
  const list = $('#device-list');
  const online = server.devices.filter((d) => d.online).length;
  $('#device-count').textContent = server.devices.length
    ? `${online} device${online === 1 ? '' : 's'} online on your network`
    : '';
  if (!server.devices.length) {
    list.innerHTML =
      '<li class="empty">No cast devices found yet. This machine must be on the same Wi-Fi/LAN as your Google Home devices — see the README if you are running in Docker.</li>';
    return;
  }
  const selectedIds = new Set((form ? form.devices.selected : server.settings.devices.selected).map((s) => s.id));
  list.innerHTML = server.devices
    .map((d) => {
      const sel = selectedIds.has(d.id);
      return `<li class="device ${sel ? 'selected' : ''} ${d.online ? '' : 'offline'}">
        <svg class="icon d-icon" aria-hidden="true"><use href="#i-cast"/></svg>
        <span class="d-name">${esc(d.name)}<span class="d-sub">${esc(d.model)}${d.host ? ` · ${esc(d.host)}` : ''}</span></span>
        <button type="button" class="btn btn-ghost btn-small btn-test" data-id="${esc(d.id)}" ${d.online ? '' : 'disabled'}>
          <svg class="icon icon-sm" aria-hidden="true"><use href="#i-play"/></svg> Test
        </button>
        <input type="checkbox" class="device-check" data-id="${esc(d.id)}" data-name="${esc(d.name)}"
          ${sel ? 'checked' : ''} aria-label="Play adhaan on ${esc(d.name)}">
      </li>`;
    })
    .join('');
}

function renderMedia() {
  const list = $('#media-list');
  const current = form ? form.adhaan.audioFile : server.settings.adhaan.audioFile;
  if (!server.media.length) {
    list.innerHTML = '<li class="empty">No audio yet — upload an adhaan recording below.</li>';
  } else {
    list.innerHTML = server.media
      .map(
        (f) => `<li class="media-item">
          <label><input type="radio" name="default-audio" value="${esc(f)}" ${f === current ? 'checked' : ''}>
            <span class="m-name">${esc(f)}</span></label>
          <button type="button" class="btn-danger-ghost btn-del" data-file="${esc(f)}" aria-label="Delete ${esc(f)}">
            <svg class="icon icon-sm" aria-hidden="true"><use href="#i-trash"/></svg>
          </button>
        </li>`
      )
      .join('');
  }

  const fajrSel = $('#fajr-audio-select');
  const fajrVal = form ? form.adhaan.fajrAudioFile : server.settings.adhaan.fajrAudioFile;
  fajrSel.innerHTML =
    '<option value="">Same as default</option>' +
    server.media.map((f) => `<option value="${esc(f)}" ${f === fajrVal ? 'selected' : ''}>${esc(f)}</option>`).join('');
}

function renderLog() {
  $('#log-list').innerHTML = server.log
    .map((e) => {
      const t = new Date(e.ts).toLocaleTimeString([], { hour12: false });
      return `<li><span class="lvl ${esc(e.level)}"></span><time>${esc(t)}</time><span>${esc(e.msg)}</span></li>`;
    })
    .join('') || '<li class="empty">Nothing yet.</li>';
}

function renderForm() {
  if (!form) return;
  if (!optionsBuilt) {
    $('#tz-select').innerHTML = server.timezones.map((z) => `<option value="${esc(z)}">${esc(z)}</option>`).join('');
    $('#method-select').innerHTML = server.methods
      .map((m) => `<option value="${esc(m)}">${esc(METHOD_NAMES[m] || m)}</option>`)
      .join('');
    optionsBuilt = true;
  }
  $('#loc-label').value = form.location.label;
  $('#lat').value = form.location.latitude;
  $('#lon').value = form.location.longitude;
  $('#tz-select').value = form.location.timezone;
  $('#method-select').value = form.calculation.method;
  $('#hlr-select').value = form.calculation.highLatitudeRule;
  for (const r of document.querySelectorAll('input[name="madhab"]')) {
    r.checked = r.value === form.calculation.madhab;
  }
  for (const inp of document.querySelectorAll('.adj')) {
    inp.value = form.calculation.adjustments[inp.dataset.p];
  }
  $('#vol-slider').value = Math.round(form.adhaan.volume * 100);
  $('#vol-out').textContent = `${Math.round(form.adhaan.volume * 100)}%`;
  $('#restore-vol').checked = form.adhaan.restoreVolume;
  $('#max-dur').value = form.adhaan.maxDurationSec;
}

/* ---------- countdown ticks ---------- */

function tick() {
  const now = Date.now();
  const pill = $('#next-pill');
  if (!pill.hidden && pill.dataset.epoch) {
    const ms = Number(pill.dataset.epoch) - now;
    $('#next-pill-text').textContent =
      ms <= 0 ? `${pill.dataset.name} — now` : `${pill.dataset.name} in ${countdown(ms)}`;
    if (ms < -5000) fetchState(); // roll over to the next prayer
  }
  for (const el of document.querySelectorAll('[data-countdown]')) {
    const ms = Number(el.dataset.epoch) - now;
    el.textContent = ms <= 0 ? 'now' : `adhaan in ${countdown(ms)}`;
  }
}

/* ---------- events ---------- */

function wire() {
  $('#today-list').addEventListener('change', (e) => {
    const t = e.target.closest('.prayer-toggle');
    if (!t) return;
    form.adhaan.prayers[t.dataset.key] = t.checked;
    setDirty();
    renderToday();
  });

  $('#device-list').addEventListener('change', (e) => {
    const c = e.target.closest('.device-check');
    if (!c) return;
    form.devices.selected = form.devices.selected.filter((s) => s.id !== c.dataset.id);
    if (c.checked) form.devices.selected.push({ id: c.dataset.id, name: c.dataset.name });
    setDirty();
    renderDevices();
  });

  $('#device-list').addEventListener('click', async (e) => {
    const b = e.target.closest('.btn-test');
    if (!b) return;
    b.disabled = true;
    try {
      const { results } = await api('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [b.dataset.id] }),
      });
      if (!results.length) toast('Nothing played — is the device still online?', 'warn');
      else if (results.every((r) => r.ok)) toast('Test sound sent — it stops by itself.');
      else toast(`Playback problem: ${results.find((r) => !r.ok).error}`, 'error');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      b.disabled = false;
    }
  });

  $('#btn-rescan').addEventListener('click', async () => {
    await api('/api/devices/rescan', { method: 'POST' }).catch(() => {});
    toast('Rescanning the network…');
    setTimeout(fetchState, 2000);
  });

  $('#media-list').addEventListener('change', (e) => {
    const r = e.target.closest('input[name="default-audio"]');
    if (!r) return;
    form.adhaan.audioFile = r.value;
    setDirty();
  });

  $('#media-list').addEventListener('click', async (e) => {
    const b = e.target.closest('.btn-del');
    if (!b) return;
    if (!window.confirm(`Delete "${b.dataset.file}"?`)) return;
    try {
      await api(`/api/media/${encodeURIComponent(b.dataset.file)}`, { method: 'DELETE' });
      await fetchState();
      toast('File deleted.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#fajr-audio-select').addEventListener('change', (e) => {
    form.adhaan.fajrAudioFile = e.target.value || null;
    setDirty();
  });

  const uploadInput = $('#file-input');
  const drop = $('#upload-drop');
  uploadInput.addEventListener('change', () => uploadInput.files[0] && uploadFile(uploadInput.files[0]));
  for (const ev of ['dragover', 'dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.toggle('drag', ev === 'dragover');
      if (ev === 'drop' && e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
    });
  }

  $('#vol-slider').addEventListener('input', (e) => {
    form.adhaan.volume = Number(e.target.value) / 100;
    $('#vol-out').textContent = `${e.target.value}%`;
    setDirty();
  });
  $('#restore-vol').addEventListener('change', (e) => { form.adhaan.restoreVolume = e.target.checked; setDirty(); });
  $('#max-dur').addEventListener('change', (e) => { form.adhaan.maxDurationSec = Number(e.target.value); setDirty(); });

  $('#loc-label').addEventListener('input', (e) => { form.location.label = e.target.value; setDirty(); });
  $('#lat').addEventListener('change', (e) => { form.location.latitude = Number(e.target.value); setDirty(); });
  $('#lon').addEventListener('change', (e) => { form.location.longitude = Number(e.target.value); setDirty(); });
  $('#tz-select').addEventListener('change', (e) => { form.location.timezone = e.target.value; setDirty(); });
  $('#method-select').addEventListener('change', (e) => { form.calculation.method = e.target.value; setDirty(); });
  $('#hlr-select').addEventListener('change', (e) => { form.calculation.highLatitudeRule = e.target.value; setDirty(); });
  for (const r of document.querySelectorAll('input[name="madhab"]')) {
    r.addEventListener('change', () => { if (r.checked) { form.calculation.madhab = r.value; setDirty(); } });
  }
  for (const inp of document.querySelectorAll('.adj')) {
    inp.addEventListener('change', () => {
      form.calculation.adjustments[inp.dataset.p] = Number(inp.value) || 0;
      setDirty();
    });
  }

  $('#btn-geo').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Geolocation is not available in this browser.', 'warn');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        form.location.latitude = Number(pos.coords.latitude.toFixed(4));
        form.location.longitude = Number(pos.coords.longitude.toFixed(4));
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz && server.timezones.includes(tz)) form.location.timezone = tz;
        setDirty();
        renderForm();
        toast('Location filled in — remember to save.');
      },
      () => toast('Could not read your location (permission denied?).', 'warn')
    );
  });

  $('#btn-save').addEventListener('click', async () => {
    const btn = $('#btn-save');
    btn.disabled = true;
    try {
      server = await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      form = structuredClone(server.settings);
      dirty = false;
      $('#save-bar').classList.remove('show');
      render();
      toast('Saved — the adhaan schedule has been updated.');
    } catch (err) {
      toast(`Save failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('#btn-discard').addEventListener('click', () => {
    form = structuredClone(server.settings);
    dirty = false;
    $('#save-bar').classList.remove('show');
    render();
  });
}

async function uploadFile(file) {
  const text = $('#upload-text');
  const original = text.innerHTML;
  text.textContent = `Uploading ${file.name}…`;
  try {
    const fd = new FormData();
    fd.append('file', file);
    await api('/api/media/upload', { method: 'POST', body: fd });
    await fetchState();
    toast(`Uploaded ${file.name}.`);
  } catch (err) {
    toast(`Upload failed: ${err.message}`, 'error');
  } finally {
    text.innerHTML = original;
    $('#file-input').value = '';
  }
}

/* ---------- boot ---------- */

wire();
fetchState();
setInterval(fetchState, 15000);
setInterval(tick, 1000);
