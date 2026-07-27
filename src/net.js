import os from 'node:os';

// The cast device fetches the audio over HTTP, so we must hand it a URL with an
// address that is reachable from the device — never localhost.
function detectLanAddress() {
  const candidates = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) candidates.push(iface.address);
    }
  }
  return (
    candidates.find((a) => a.startsWith('192.168.')) ||
    candidates.find((a) => a.startsWith('10.')) ||
    candidates.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ||
    candidates[0] ||
    '127.0.0.1'
  );
}

export { detectLanAddress };
