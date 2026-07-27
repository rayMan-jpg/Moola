# Adhaan Cast · بث الأذان

Self-hosted adhaan for **Google Home / Nest Hub** (and any Google Cast speaker).
It computes daily prayer times from *your* settings — location, calculation
method, madhab, per-prayer tweaks — and automatically casts your chosen adhaan
recording to the devices you pick, at the right moment, every day.

## Why this exists (and why it works this way)

There is no "adhaan app" you can install *on* a Nest Hub, and there can't be:
Google shut down third-party Assistant apps (Conversational Actions) in
June 2023, and its built-in routines/scripted automations only support **fixed**
start times and streaming services — useless for prayer times, which shift
daily, and for playing your own adhaan audio.

What Google devices *do* still support, fully, is **Google Cast**: any machine
on the same network can tell a Nest Hub to play an audio URL. So the working
design is a small always-on service **inside your home network** that:

```
┌─────────────────────────── your home Wi-Fi / LAN ───────────────────────────┐
│                                                                             │
│  Adhaan Cast (this app, on a Pi / NAS / spare machine)                      │
│  ├─ computes today's prayer times from your settings (offline, adhan lib)  │
│  ├─ schedules each enabled prayer                                           │
│  ├─ discovers cast devices via mDNS                                         │
│  └─ at prayer time: sets volume → casts your adhaan MP3 → restores volume  │
│                       │                                                     │
│                       ▼ Google Cast protocol                                │
│  Nest Hub · Nest Mini · Chromecast · speaker groups                         │
│  (the device fetches the audio back from this app over HTTP)                │
└─────────────────────────────────────────────────────────────────────────────┘
```

Everything is computed locally — no accounts, no cloud APIs, no tracking.

## Quick start

Requires Node.js 18+ on a machine that's on the **same network** as your
Google Home devices.

```bash
npm install
npm start
# → Adhaan Cast dashboard: http://<your-lan-ip>:8090
```

Open the dashboard from any browser on your network, then:

1. **Location & calculation** — set your coordinates ("Use my current location"
   works if the browser allows it), timezone, calculation method and madhab.
2. **Cast devices** — tick the Hub/speakers that should play the adhaan.
   Use **Test** to hear it immediately (a generated chime until you upload
   real audio).
3. **Adhaan sound** — upload your adhaan MP3(s), optionally a separate one for
   Fajr, and set the playback volume.
4. **Save & reschedule** — done. The service re-computes times every midnight
   and keeps itself scheduled.

### Docker (recommended for a Pi / home server / NAS)

```bash
docker compose up -d --build
```

`network_mode: host` in the compose file is **required** — mDNS discovery and
the cast-back of audio don't work behind Docker's default NAT network. Host
networking works on Linux (Raspberry Pi OS, Debian, Synology/QNAP with
container support). On Docker Desktop for Mac/Windows, run the app natively
with `npm start` instead.

## "I don't know how to host it"

The one hard rule: **the app must run on your home network**, because the Cast
protocol is LAN-only. A cloud server (Vercel, AWS, etc.) cannot reach your
Nest Hub. That's actually good news — hosting is cheap and private:

| Option | Notes |
|---|---|
| **Raspberry Pi** (Zero 2 W and up) | The classic choice: ~$15–35, silent, a few pence of power per week. Install Raspberry Pi OS Lite, install Docker, `docker compose up -d`. |
| **A NAS** (Synology, QNAP, Unraid) | If you already have one, it's ideal — use its container manager with host networking. |
| **Any always-on PC / old laptop** | `npm start` in a terminal is enough to try it; keep it running with `pm2 start src/index.js --name adhaan-cast` (then `pm2 save && pm2 startup`), or a systemd unit on Linux. |
| **Home Assistant box** | If you run HA OS on a Pi/NUC you already have a Linux host — run this alongside it in Docker. |

Advanced note: a VPS *can* work only if you bridge it into your LAN with
something like Tailscale subnet routing — more moving parts than a Pi and no
real benefit; not recommended.

## Settings reference

- **Calculation method** — Moonsighting Committee (default), Muslim World
  League, ISNA, Egyptian, Karachi, Umm al-Qura, Dubai, Kuwait, Qatar,
  Singapore, Tehran, Turkey (Diyanet). Pick whichever your community follows.
- **Asr (madhab)** — Standard (Shafiʿi/Maliki/Hanbali) or Hanafi (later Asr).
- **High-latitude rule** — for UK/Northern Europe summers when true twilight
  never ends. *Automatic* picks a sensible rule for your latitude.
- **Fine-tune minutes** — per-prayer offsets so the adhaan matches your local
  masjid's timetable exactly.
- **Per-prayer toggles** — e.g. keep Fajr silent on the bedroom Hub. Sunrise is
  shown for reference and never plays an adhaan.
- **Volume + restore** — the adhaan plays at a volume you choose, then the
  device returns to its previous volume.
- **Safety cut-off** — playback is force-stopped after N seconds no matter what.

Settings persist in `data/config.json`; audio lives in `media/`.

## Adhaan audio

Recordings aren't bundled, since most online adhaan recordings have unclear
licensing. Upload any MP3/WAV you have the right to use — many masjids and
muezzins publish recordings for free personal use, or record your own. A
generated chime (`sample-chime.wav`) is included so you can test casting
before that.

## Troubleshooting

- **No devices found** — the app must be on the same subnet/VLAN as the
  devices; mesh systems with "guest" or "IoT" isolation will hide them. In
  Docker, host networking is mandatory. Some firewalls block mDNS (UDP 5353).
- **Devices found, but no sound** — the *device* fetches the audio from the
  app on port 8090, so your machine's firewall must allow inbound LAN traffic
  on that port. If the auto-detected IP is wrong (multiple NICs/VPN), set
  `server.host` in `data/config.json` to the machine's LAN IP.
- **Times look off** — check timezone, coordinates and method first; then the
  high-latitude rule if you're far from the equator.
- **Port already in use** — change `server.port` in `data/config.json` (or set
  `PORT=`), then restart.

## Development

```bash
npm test        # prayer-time and settings validation tests (no network needed)
npm run dev     # auto-restarting dev server
```

Roadmap ideas: import a masjid's monthly CSV timetable as an override, duas
after the adhaan, per-device volumes, Hijri date on the dashboard, a Home
Assistant add-on package.

## License

MIT
