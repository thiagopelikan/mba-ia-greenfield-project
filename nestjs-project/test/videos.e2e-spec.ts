import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../src/channels/entities/channel.entity';
import { StorageService } from '../src/storage/storage.service';
import { buildSwaggerDocument } from '../src/swagger/swagger-document';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { requestPresigned } from '../src/test/storage-http';
import { insertVideo } from '../src/test/video-test-helpers';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import { createE2eApp, registerConfirmAndLogin } from './e2e-helpers';

const MIB = 1024 * 1024;
const publicHost = new URL(
  process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
).host;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;
  let userCounter = 0;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const n = ++userCounter;
    ownerToken = await registerConfirmAndLogin(app, `owner${n}@example.com`);
    otherToken = await registerConfirmAndLogin(app, `other${n}@example.com`);
  });

  async function ownerChannelId(): Promise<string> {
    const [channel] = await dataSource
      .getRepository(Channel)
      .find({ relations: { user: true }, order: { created_at: 'ASC' } });
    return channel.id;
  }

  function initiate(body: Record<string, unknown>, token = ownerToken) {
    return http().post('/videos').set(auth(token)).send(body);
  }

  async function initiateAndUploadOnePart() {
    const res = await initiate({
      file_name: 'clip.mp4',
      file_size: 2048,
      mime_type: 'video/mp4',
    }).expect(201);
    const put = await requestPresigned(res.body.upload.parts[0].url, {
      method: 'PUT',
      body: randomBytes(2048),
    });
    expect(put.status).toBe(200);
    return {
      slug: res.body.video.slug as string,
      id: res.body.video.id as string,
      etag: String(put.headers.etag),
    };
  }

  describe('POST /videos', () => {
    it('rejects-anonymous-initiation: returns 401 without a token', async () => {
      await http()
        .post('/videos')
        .send({ file_name: 'clip.mp4', file_size: MIB, mime_type: 'video/mp4' })
        .expect(401);
    });

    it('creates-draft-with-part-urls: returns 201 with a draft and one URL per part', async () => {
      const res = await initiate({
        file_name: 'clip.mp4',
        file_size: 150 * MIB,
        mime_type: 'video/mp4',
      }).expect(201);

      expect(res.body.video.status).toBe('draft');
      expect(res.body.video.title).toBe('clip');
      expect(res.body.video.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      const { part_size, part_count, parts } = res.body.upload;
      expect(part_count).toBe(Math.ceil((150 * MIB) / part_size));
      expect(parts).toHaveLength(part_count);
      expect(new URL(parts[0].url).host).toBe(publicHost);
      const row = await videoRepository.findOneByOrFail({
        id: res.body.video.id,
      });
      expect(row.upload_id).toEqual(expect.any(String));
    });

    it('rejects-non-video-mime-type: returns 400 for image/png', async () => {
      await initiate({
        file_name: 'pic.png',
        file_size: 10,
        mime_type: 'image/png',
      }).expect(400);
    });

    it('rejects-files-over-10gib: returns VIDEO_FILE_TOO_LARGE and accepts exactly 10 GiB', async () => {
      const tooBig = await initiate({
        file_name: 'huge.mp4',
        file_size: 10737418241,
        mime_type: 'video/mp4',
      }).expect(400);
      expect(tooBig.body.error).toBe('VIDEO_FILE_TOO_LARGE');
      expect(await videoRepository.count()).toBe(0);

      const limit = await initiate({
        file_name: 'huge.mp4',
        file_size: 10737418240,
        mime_type: 'video/mp4',
      }).expect(201);
      expect(limit.body.upload.part_count).toBe(160);
    });
  });

  describe('upload resume and completion', () => {
    it('resume-lists-uploaded-parts: owner sees stored parts; others get 404', async () => {
      const { slug, etag } = await initiateAndUploadOnePart();

      const res = await http()
        .get(`/videos/${slug}/upload`)
        .set(auth(ownerToken))
        .expect(200);
      expect(res.body.uploaded_parts).toEqual([
        { part_number: 1, etag, size: 2048 },
      ]);
      expect(res.body.parts).toEqual([]);

      const other = await http()
        .get(`/videos/${slug}/upload`)
        .set(auth(otherToken))
        .expect(404);
      expect(other.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('completes-upload-and-enqueues-processing: 404 for others, 202 for owner, then 409', async () => {
      const { slug, id, etag } = await initiateAndUploadOnePart();
      const body = { parts: [{ part_number: 1, etag }] };

      const other = await http()
        .post(`/videos/${slug}/upload/complete`)
        .set(auth(otherToken))
        .send(body)
        .expect(404);
      expect(other.body.error).toBe('VIDEO_NOT_FOUND');

      const res = await http()
        .post(`/videos/${slug}/upload/complete`)
        .set(auth(ownerToken))
        .send(body)
        .expect(202);
      expect(res.body.status).toBe('processing');
      const job = await queue.getJob(id);
      expect(job?.name).toBe('process-video');

      const again = await http()
        .post(`/videos/${slug}/upload/complete`)
        .set(auth(ownerToken))
        .send(body)
        .expect(409);
      expect(again.body.error).toBe('VIDEO_NOT_UPLOADABLE');
    });

    it('rejects-invalid-parts: returns INVALID_UPLOAD_PARTS and keeps the draft', async () => {
      const { slug, id } = await initiateAndUploadOnePart();

      const res = await http()
        .post(`/videos/${slug}/upload/complete`)
        .set(auth(ownerToken))
        .send({ parts: [{ part_number: 1, etag: '"bogus"' }] })
        .expect(400);

      expect(res.body.error).toBe('INVALID_UPLOAD_PARTS');
      const row = await videoRepository.findOneByOrFail({ id });
      expect(row.status).toBe(VideoStatus.DRAFT);
    });
  });

  describe('upload size enforcement', () => {
    it('binds-part-urls-to-exact-sizes: oversized parts are rejected by the storage', async () => {
      const res = await initiate({
        file_name: 'clip.mp4',
        file_size: 2048,
        mime_type: 'video/mp4',
      }).expect(201);
      const [part] = res.body.upload.parts;
      expect(part.size).toBe(2048);

      const oversized = await requestPresigned(part.url, {
        method: 'PUT',
        body: randomBytes(4096),
      });

      expect(oversized.status).toBe(403);
    });

    it('rejects-incomplete-part-lists: completing without every planned part returns 400', async () => {
      const res = await initiate({
        file_name: 'clip.mp4',
        file_size: 150 * MIB,
        mime_type: 'video/mp4',
      }).expect(201);
      expect(res.body.upload.part_count).toBeGreaterThan(1);

      const incomplete = await http()
        .post(`/videos/${res.body.video.slug}/upload/complete`)
        .set(auth(ownerToken))
        .send({ parts: [{ part_number: 1, etag: '"any"' }] })
        .expect(400);

      expect(incomplete.body.error).toBe('INVALID_UPLOAD_PARTS');
    });
  });

  describe('playback access by slug', () => {
    it('hides-unfinished-videos-from-non-owners', async () => {
      const channelId = await ownerChannelId();
      const processing = await insertVideo(dataSource, channelId, {
        status: VideoStatus.PROCESSING,
      });
      const ready = await insertVideo(dataSource, channelId, {
        status: VideoStatus.READY,
      });

      const anon = await http().get(`/videos/${processing.slug}`).expect(404);
      expect(anon.body.error).toBe('VIDEO_NOT_FOUND');
      const owner = await http()
        .get(`/videos/${processing.slug}`)
        .set(auth(ownerToken))
        .expect(200);
      expect(owner.body.status).toBe('processing');
      const pub = await http().get(`/videos/${ready.slug}`).expect(200);
      expect(pub.body.status).toBe('ready');
    });

    it('redirects-stream-and-download', async () => {
      const channelId = await ownerChannelId();
      const ready = await insertVideo(dataSource, channelId, {
        status: VideoStatus.READY,
        original_file_name: 'trip.mp4',
      });
      await app
        .get(StorageService)
        .putObject(ready.storage_key, randomBytes(64), 'video/mp4');
      const draft = await insertVideo(dataSource, channelId);

      const stream = await http()
        .get(`/videos/${ready.slug}/stream`)
        .expect(302);
      expect(new URL(stream.headers.location).host).toBe(publicHost);

      const download = await http()
        .get(`/videos/${ready.slug}/download`)
        .expect(302);
      expect(download.headers.location).toContain(
        'response-content-disposition=attachment',
      );

      const notReady = await http()
        .get(`/videos/${draft.slug}/stream`)
        .set(auth(ownerToken))
        .expect(409);
      expect(notReady.body.error).toBe('VIDEO_NOT_READY');
    });
  });

  describe('OpenAPI documentation', () => {
    it('documents-video-endpoints', () => {
      const document = buildSwaggerDocument(app);

      for (const path of [
        '/videos',
        '/videos/{slug}',
        '/videos/{slug}/upload',
        '/videos/{slug}/upload/complete',
        '/videos/{slug}/stream',
        '/videos/{slug}/download',
      ]) {
        const operations = Object.values(document.paths[path] ?? {}) as {
          tags?: string[];
        }[];
        expect(operations.length).toBeGreaterThan(0);
        expect(operations.every((op) => op.tags?.includes('videos'))).toBe(
          true,
        );
      }
    });
  });
});
