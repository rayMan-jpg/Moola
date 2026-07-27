import { Bonjour } from 'bonjour-service';

// Watches the LAN for Google Cast devices (Nest Hub, Nest Mini, Chromecast,
// speaker groups) via mDNS. Cast devices announce _googlecast._tcp with their
// friendly name (fn), model (md) and a stable id in the TXT record.
class CastDiscovery {
  constructor(log) {
    this.log = log;
    this.devices = new Map();
    this.bonjour = null;
    this.browser = null;
    this.timer = null;
  }

  start() {
    this.bonjour = new Bonjour();
    this.browser = this.bonjour.find({ type: 'googlecast' });
    this.browser.on('up', (service) => this.add(service));
    this.browser.on('down', (service) => this.remove(service));
    this.timer = setInterval(() => this.rescan(), 60_000);
    if (this.timer.unref) this.timer.unref();
  }

  key(service) {
    return (service.txt && service.txt.id) || service.fqdn || service.name;
  }

  add(service) {
    const addr =
      (service.addresses || []).find((a) => a.includes('.')) ||
      (service.referer && service.referer.address);
    if (!addr) return;
    const device = {
      id: this.key(service),
      name: (service.txt && service.txt.fn) || service.name,
      model: (service.txt && service.txt.md) || 'Cast device',
      host: addr,
      port: service.port || 8009,
      lastSeen: Date.now(),
    };
    const isNew = !this.devices.has(device.id);
    this.devices.set(device.id, device);
    if (isNew) this.log('info', `Discovered "${device.name}" (${device.model}) at ${device.host}`);
  }

  remove(service) {
    const id = this.key(service);
    const known = this.devices.get(id);
    if (known && this.devices.delete(id)) {
      this.log('info', `Device left the network: "${known.name}"`);
    }
  }

  rescan() {
    try {
      if (this.browser) this.browser.update();
    } catch {
      // mDNS hiccups are routine; the periodic rescan will retry.
    }
  }

  list() {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    try {
      if (this.browser) this.browser.stop();
      if (this.bonjour) this.bonjour.destroy();
    } catch {
      // Shutting down anyway.
    }
  }
}

export { CastDiscovery };
