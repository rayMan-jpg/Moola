import fs from 'node:fs';
import path from 'node:path';

// Generates a short two-note chime as a 16-bit mono WAV so casting can be
// tested end-to-end before the user has uploaded any adhaan audio.
function generateSampleChime(filePath) {
  const sampleRate = 22050;
  const seconds = 2.6;
  const total = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(total * 2);
  const notes = [
    { freq: 523.25, start: 0.0, dur: 1.2 }, // C5
    { freq: 783.99, start: 0.55, dur: 1.9 }, // G5
  ];

  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (const n of notes) {
      const local = t - n.start;
      if (local < 0 || local > n.dur) continue;
      const env = Math.exp(-3.2 * local) * Math.min(1, local / 0.02);
      v += Math.sin(2 * Math.PI * n.freq * local) * env * 0.4;
      v += Math.sin(2 * Math.PI * n.freq * 2 * local) * env * 0.08;
    }
    const s = Math.max(-1, Math.min(1, v));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

export { generateSampleChime };
