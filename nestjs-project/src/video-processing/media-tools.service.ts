import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import type { VideoMetadata } from '../videos/entities/video.entity';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 60_000;
const FRAME_TIMEOUT_MS = 120_000;
const THUMBNAIL_WIDTH = 1280;

/** ffprobe/ffmpeg rejected the content itself — retrying cannot help. */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

export interface ProbeResult {
  durationSeconds: number | null;
  hasVideoStream: boolean;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  disposition?: { attached_pic?: number };
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
  streams?: FfprobeStream[];
}

const INVALID_MEDIA_PATTERNS = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
  /could not find codec parameters/i,
  /Output file does not contain any stream/i,
];

/**
 * Thin wrapper around the FFmpeg binaries. Inputs are HTTP URLs (presigned
 * GETs): FFmpeg issues range requests, so large files are never downloaded
 * in full just to read headers or a single frame.
 */
@Injectable()
export class MediaToolsService {
  async probe(url: string): Promise<ProbeResult> {
    const stdout = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ],
      PROBE_TIMEOUT_MS,
    );
    return toProbeResult(JSON.parse(stdout) as FfprobeOutput);
  }

  async extractFrame(
    url: string,
    atSeconds: number,
    outputPath: string,
  ): Promise<void> {
    await this.run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        url,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMBNAIL_WIDTH}:-2`,
        '-q:v',
        '3',
        '-y',
        outputPath,
      ],
      FRAME_TIMEOUT_MS,
    );
  }

  private async run(
    binary: string,
    args: string[],
    timeout: number,
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync(binary, args, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const { stderr } = err as { stderr?: string | Buffer };
      const output = stderr ? stderr.toString() : '';
      if (INVALID_MEDIA_PATTERNS.some((pattern) => pattern.test(output))) {
        throw new InvalidMediaError(`${binary}: ${output.trim()}`);
      }
      throw err;
    }
  }
}

/** Frame for the thumbnail: 10% into the video, kept inside its bounds. */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return Math.min(durationSeconds * 0.1, Math.max(0, durationSeconds - 0.1));
}

function toProbeResult(output: FfprobeOutput): ProbeResult {
  const streams = output.streams ?? [];
  // Cover art (e.g. in .m4a/.mp3) is reported as a "video" stream flagged as
  // an attached picture — it is not a video track.
  const video = streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
  );
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = output.format ?? {};
  return {
    durationSeconds: toNumber(format.duration),
    hasVideoStream: !!video,
    metadata: {
      format_name: format.format_name ?? 'unknown',
      size_bytes: toNumber(format.size),
      bit_rate: toNumber(format.bit_rate),
      width: video?.width ?? null,
      height: video?.height ?? null,
      frame_rate: parseFrameRate(video?.avg_frame_rate),
      video_codec: video?.codec_name ?? null,
      audio_codec: audio?.codec_name ?? null,
    },
  };
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split('/').map(Number);
  if (!den || !Number.isFinite(num)) return null;
  return Math.round((num / den) * 1000) / 1000;
}
