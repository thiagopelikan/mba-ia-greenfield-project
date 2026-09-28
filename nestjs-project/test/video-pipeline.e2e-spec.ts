import './small-upload-parts.env';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateSampleVideo } from '../src/test/sample-video';
import { requestPresigned } from '../src/test/storage-http';
import { createE2eApp, registerConfirmAndLogin } from './e2e-helpers';

/**
 * Full pipeline against the Compose stack: API (this process) → MinIO (direct
 * presigned uploads) → Redis/BullMQ → the `video-worker` container (FFmpeg).
 * Nothing is mocked; the worker must be running (`docker compose up -d`).
 */

const PROCESSING_TIMEOUT_MS = 90_000;
jest.setTimeout(180_000);

interface VideoBody {
  id: string;
  slug: string;
  status: string;
  duration_seconds: number | null;
  metadata: Record<string, unknown> | null;
  thumbnail_url: string | null;
  failure_reason: string | null;
}

describe('Video pipeline (e2e — real infrastructure)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let token: string;
  let sample: Buffer;
  let samplePath: string;

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
    await cleanAllTables(dataSource);
    app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
    token = await registerConfirmAndLogin(app, 'pipeline@example.com');
    samplePath = await generateSampleVideo({
      seconds: 10,
      width: 640,
      height: 360,
      videoBitrate: '8M',
    });
    sample = await readFile(samplePath);
  });

  afterAll(async () => {
    await rm(dirname(samplePath), { recursive: true, force: true });
    await app.close();
  });

  /** POST /videos → PUT every part to its presigned URL → complete. */
  async function uploadThroughApi(
    content: Buffer,
    fileName: string,
  ): Promise<{ slug: string; partCount: number }> {
    const init = await http()
      .post('/videos')
      .set(auth())
      .send({
        file_name: fileName,
        file_size: content.length,
        mime_type: 'video/mp4',
      })
      .expect(201);
    const { part_size, parts } = init.body.upload as {
      part_size: number;
      parts: { part_number: number; url: string }[];
    };

    const completed: { part_number: number; etag: string }[] = [];
    for (const part of parts) {
      const start = (part.part_number - 1) * part_size;
      const res = await requestPresigned(part.url, {
        method: 'PUT',
        body: content.subarray(start, start + part_size),
      });
      expect(res.status).toBe(200);
      completed.push({
        part_number: part.part_number,
        etag: String(res.headers.etag),
      });
    }

    await http()
      .post(`/videos/${init.body.video.slug}/upload/complete`)
      .set(auth())
      .send({ parts: completed })
      .expect(202);
    return { slug: init.body.video.slug as string, partCount: parts.length };
  }

  async function waitForTerminalStatus(slug: string): Promise<VideoBody> {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    for (;;) {
      const res = await http().get(`/videos/${slug}`).set(auth()).expect(200);
      const body = res.body as VideoBody;
      if (body.status === 'ready' || body.status === 'failed') return body;
      if (Date.now() > deadline) {
        throw new Error(`Video ${slug} still ${body.status} after timeout`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  let readySlug: string;

  it('processes an uploaded MP4 automatically into a ready video', async () => {
    const { slug, partCount } = await uploadThroughApi(sample, 'holiday.mp4');
    expect(partCount).toBeGreaterThan(1);

    const video = await waitForTerminalStatus(slug);

    expect(video.status).toBe('ready');
    expect(video.duration_seconds).toBeCloseTo(10, 0);
    expect(video.metadata).toMatchObject({
      width: 640,
      height: 360,
      video_codec: 'h264',
    });
    expect(video.thumbnail_url).toEqual(expect.any(String));
    const thumbnail = await requestPresigned(video.thumbnail_url!);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers['content-type']).toBe('image/jpeg');
    readySlug = slug;
  });

  it('gives each video a distinct 11-character URL id', async () => {
    const { body: a } = await http()
      .post('/videos')
      .set(auth())
      .send({ file_name: 'a.mp4', file_size: 10, mime_type: 'video/mp4' })
      .expect(201);
    const { body: b } = await http()
      .post('/videos')
      .set(auth())
      .send({ file_name: 'b.mp4', file_size: 10, mime_type: 'video/mp4' })
      .expect(201);

    expect(a.video.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(b.video.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(a.video.slug).not.toBe(b.video.slug);
  });

  it('streams with HTTP range requests (206 Partial Content) without auth', async () => {
    const redirect = await http()
      .get(`/videos/${readySlug}/stream`)
      .expect(302);

    const res = await requestPresigned(redirect.headers.location, {
      headers: { Range: 'bytes=0-99' },
    });

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-99/${sample.length}`);
    expect(res.body.equals(sample.subarray(0, 100))).toBe(true);
  });

  it('downloads the original file as an attachment', async () => {
    const redirect = await http()
      .get(`/videos/${readySlug}/download`)
      .expect(302);

    const res = await requestPresigned(redirect.headers.location);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(
      'attachment; filename="holiday.mp4"',
    );
    expect(res.body.equals(sample)).toBe(true);
  });

  it('marks a non-video upload as failed with INVALID_MEDIA', async () => {
    const { slug } = await uploadThroughApi(
      Buffer.from('this is not a video\n'.repeat(500)),
      'fake.mp4',
    );

    const video = await waitForTerminalStatus(slug);

    expect(video.status).toBe('failed');
    expect(video.failure_reason).toBe('INVALID_MEDIA');
  });
});
