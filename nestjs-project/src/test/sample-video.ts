import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Generates a short H.264/AAC MP4 (test pattern + tone) with FFmpeg. */
export async function generateSampleVideo(
  options: {
    seconds?: number;
    width?: number;
    height?: number;
    /**
     * Target video bitrate (e.g. '8M') to produce larger files; adds temporal
     * noise, since the plain test pattern compresses far below any target.
     */
    videoBitrate?: string;
  } = {},
): Promise<string> {
  const { seconds = 3, width = 320, height = 240, videoBitrate } = options;
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-sample-'));
  const output = join(dir, 'sample.mp4');

  const pattern = `testsrc=duration=${seconds}:size=${width}x${height}:rate=25`;
  const videoInput = videoBitrate ? `${pattern},noise=alls=60:allf=t` : pattern;
  const bitrateArgs = videoBitrate
    ? ['-b:v', videoBitrate, '-maxrate', videoBitrate, '-bufsize', videoBitrate]
    : [];

  await execFileAsync('ffmpeg', [
    ...['-v', 'error'],
    ...['-f', 'lavfi', '-i', videoInput],
    ...['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...bitrateArgs],
    ...['-c:a', 'aac', '-shortest', '-movflags', '+faststart'],
    ...['-y', output],
  ]);
  return output;
}
