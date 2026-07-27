import path from 'node:path';
import castv2 from 'castv2-client';

const { Client, DefaultMediaReceiver } = castv2;

const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

function contentTypeFor(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return CONTENT_TYPES[ext] || 'audio/mpeg';
}

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    fn(...args);
  };
}

// Plays one media URL on one device: connect → remember current volume → set
// adhaan volume → launch the default receiver → load media → wait for it to
// finish → restore volume → stop the receiver so a Hub returns to its ambient
// screen. A safety timer tears everything down if the device never reports
// FINISHED (e.g. it dropped off the network mid-play).
function playOnDevice(device, mediaUrl, opts, log) {
  const {
    volume = 0.5,
    restoreVolume = true,
    maxDurationSec = 300,
    title = 'Adhaan',
    subtitle = '',
  } = opts || {};

  return new Promise((resolve, reject) => {
    const client = new Client();
    let prevLevel = null;
    let player = null;

    const finish = once((err) => {
      clearTimeout(safetyTimer);
      const close = once(() => {
        try {
          client.close();
        } catch {
          // Connection already gone.
        }
        if (err) reject(err);
        else resolve();
      });
      const stopReceiver = once(() => {
        try {
          if (player) client.stop(player, () => close());
          else close();
        } catch {
          close();
        }
        setTimeout(close, 2000);
      });
      if (restoreVolume && typeof prevLevel === 'number') {
        try {
          client.setVolume({ level: prevLevel }, () => stopReceiver());
        } catch {
          stopReceiver();
        }
        setTimeout(stopReceiver, 3000);
      } else {
        stopReceiver();
      }
    });

    client.on('error', (err) => finish(err));
    const safetyTimer = setTimeout(
      () => finish(),
      Math.max(10, maxDurationSec) * 1000 + 15_000
    );

    client.connect({ host: device.host, port: device.port || 8009 }, () => {
      client.getVolume((volErr, vol) => {
        if (!volErr && vol && typeof vol.level === 'number') prevLevel = vol.level;
        client.setVolume({ level: Math.max(0, Math.min(1, volume)) }, () => {
          client.launch(DefaultMediaReceiver, (launchErr, launchedPlayer) => {
            if (launchErr) return finish(launchErr);
            player = launchedPlayer;
            player.on('status', (status) => {
              if (!status || status.playerState !== 'IDLE') return;
              if (status.idleReason === 'FINISHED') finish();
              else if (status.idleReason === 'ERROR') {
                finish(new Error('device reported a playback error'));
              }
            });
            const media = {
              contentId: mediaUrl,
              contentType: contentTypeFor(mediaUrl),
              streamType: 'BUFFERED',
              metadata: { type: 0, metadataType: 0, title, subtitle },
            };
            player.load(media, { autoplay: true }, (loadErr) => {
              if (loadErr) finish(loadErr);
            });
          });
        });
      });
    });
  });
}

// Fans one play-out across several devices; a failure on one device never
// blocks the others. Returns a per-device summary.
async function playOnDevices(devices, mediaUrl, opts, log) {
  const results = await Promise.allSettled(
    devices.map((d) => playOnDevice(d, mediaUrl, opts, log))
  );
  return results.map((r, i) => {
    const device = devices[i];
    if (r.status === 'fulfilled') {
      return { device: device.name, ok: true };
    }
    const reason = r.reason && r.reason.message ? r.reason.message : String(r.reason);
    log('error', `Playback failed on "${device.name}": ${reason}`);
    return { device: device.name, ok: false, error: reason };
  });
}

export { playOnDevice, playOnDevices, contentTypeFor };
