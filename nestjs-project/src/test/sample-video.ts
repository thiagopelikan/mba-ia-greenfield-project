import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Generates a short H.264/AAC MP4 (test pattern + tone) with FFmpeg. */
export async function generateSampleVideo(
  options: { seconds?: number; width?: number; height?: number } = {},
): Promise<string> {
  const { seconds = 3, width = 320, height = 240 } = options;
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-sample-'));
  const output = join(dir, 'sample.mp4');
  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${seconds}:size=${width}x${height}:rate=25`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-movflags',
    '+faststart',
    '-y',
    output,
  ]);
  return output;
}
