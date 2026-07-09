import { spawn } from 'node:child_process';
import { ffmpegPath } from './ffbin.ts';

/**
 * Decode a video into raw RGB frames in one ffmpeg pass, streamed over
 * stdout — no temp image files. Returns one Buffer per frame
 * (pxW * pxH * 3 bytes each).
 */
export function extractFrames(
  videoPath: string,
  pxW: number,
  pxH: number,
  fps: number,
  maxSeconds: number
): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-i', videoPath,
      '-t', String(maxSeconds),
      '-vf', `fps=${fps},scale=${pxW}:${pxH}:flags=lanczos`,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      'pipe:1',
    ];
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').pop()}`));
        return;
      }
      const all = Buffer.concat(chunks);
      const frameBytes = pxW * pxH * 3;
      const frameCount = Math.floor(all.length / frameBytes);
      if (frameCount === 0) {
        reject(new Error(`ffmpeg produced no frames (got ${all.length} bytes): ${stderr.trim()}`));
        return;
      }
      const frames: Buffer[] = [];
      for (let i = 0; i < frameCount; i++) {
        frames.push(all.subarray(i * frameBytes, (i + 1) * frameBytes));
      }
      resolve(frames);
    });
  });
}
