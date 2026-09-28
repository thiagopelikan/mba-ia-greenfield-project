import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { generateSampleVideo } from '../test/sample-video';
import { InvalidMediaError, MediaToolsService } from './media-tools.service';

const execFileAsync = promisify(execFile);

describe('MediaToolsService (integration — FFmpeg + MinIO)', () => {
  let media: MediaToolsService;
  let storage: StorageService;
  let samplePath: string;
  let sampleUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaToolsService],
    }).compile();
    media = moduleRef.get(MediaToolsService);
    storage = moduleRef.get(StorageService);

    samplePath = await generateSampleVideo({
      seconds: 3,
      width: 320,
      height: 240,
    });
    const key = `test/${randomUUID()}/original`;
    await storage.putObject(key, await readFile(samplePath), 'video/mp4');
    sampleUrl = await storage.presignGetObject(key, {
      ttlSeconds: 300,
      audience: 'internal',
    });
  }, 60_000);

  afterAll(async () => {
    await rm(dirname(samplePath), { recursive: true, force: true });
  });

  it('should probe duration and metadata through a presigned URL', async () => {
    const result = await media.probe(sampleUrl);

    expect(result.hasVideoStream).toBe(true);
    expect(result.durationSeconds).toBeCloseTo(3, 0);
    expect(result.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      frame_rate: 25,
    });
    expect(result.metadata.format_name).toContain('mp4');
  });

  it('should extract a 1280px-wide JPEG frame', async () => {
    const output = join(dirname(samplePath), 'thumb.jpg');

    await media.extractFrame(sampleUrl, 0.3, output);

    const jpeg = await readFile(output);
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const probe = await media.probe(output);
    expect(probe.metadata.width).toBe(1280);
  });

  it('should not count embedded cover art as a video stream', async () => {
    const dir = dirname(samplePath);
    const cover = join(dir, 'cover.jpg');
    const audio = join(dir, 'song.m4a');
    await media.extractFrame(sampleUrl, 0.5, cover);
    await execFileAsync('ffmpeg', [
      ...['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'],
      ...['-i', cover, '-map', '0', '-map', '1'],
      ...['-c:a', 'aac', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'],
      ...['-y', audio],
    ]);

    const result = await media.probe(audio);

    expect(result.hasVideoStream).toBe(false);
    expect(result.metadata.audio_codec).toBe('aac');
  });

  it('should reject content that is not a media file as InvalidMediaError', async () => {
    const key = `test/${randomUUID()}/original`;
    await storage.putObject(
      key,
      Buffer.from('definitely not a video\n'.repeat(50)),
      'video/mp4',
    );
    const url = await storage.presignGetObject(key, {
      ttlSeconds: 300,
      audience: 'internal',
    });

    await expect(media.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
  });
});
