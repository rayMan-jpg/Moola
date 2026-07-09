import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffprobePath } from './ffbin.ts';

const execFileP = promisify(execFile);

export interface VideoInfo {
  width: number;
  height: number;
  durationSec: number;
}

export async function probe(videoPath: string): Promise<VideoInfo> {
  const { stdout } = await execFileP(ffprobePath(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    videoPath,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number; duration?: string }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error(`No video stream found in ${videoPath}`);
  }
  const durationSec = Number(stream.duration) || Number(parsed.format?.duration) || 0;
  return { width: stream.width, height: stream.height, durationSec };
}
