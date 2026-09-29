import { randomBytes } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { cleanAllTables } from '../test/create-test-data-source';
import { requestPresigned } from '../test/storage-http';
import {
  createUserWithChannel,
  testTypeOrmOptions,
} from '../test/video-test-helpers';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosService (integration — DB + MinIO)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let videoRepository: Repository<Video>;
  let queue: Queue;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(testTypeOrmOptions()),
        // Isolated prefix: the running video-worker must not consume test jobs.
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
          prefix: 'bull-test',
        }),
        VideosModule,
      ],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideosService);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    moduleRefClose = () => moduleRef.close();
  });

  let moduleRefClose: () => Promise<void>;

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRefClose();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  async function startUploadWithOnePart(userId: string, size = 2048) {
    const initiated = await service.initiateUpload(userId, {
      fileName: 'clip.mp4',
      fileSize: size,
      mimeType: 'video/mp4',
    });
    const res = await requestPresigned(initiated.upload.parts[0].url, {
      method: 'PUT',
      body: randomBytes(size),
    });
    return { initiated, etag: String(res.headers.etag) };
  }

  describe('initiateUpload', () => {
    it('should persist a draft for the user channel with an open multipart upload', async () => {
      const { user, channel } = await createUserWithChannel(dataSource);

      const result = await service.initiateUpload(user.id, {
        fileName: 'clip.mp4',
        fileSize: 2048,
        mimeType: 'video/mp4',
      });

      const row = await videoRepository.findOneByOrFail({
        id: result.video.id,
      });
      expect(row.channel_id).toBe(channel.id);
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(row.upload_id).toEqual(expect.any(String));
      expect(row.storage_key).toBe(`videos/${row.id}/original`);
      expect(result.upload.part_count).toBe(1);
    });

    it('should return part URLs that accept the file bytes', async () => {
      const { user } = await createUserWithChannel(dataSource);
      const result = await service.initiateUpload(user.id, {
        fileName: 'clip.mp4',
        fileSize: 2048,
        mimeType: 'video/mp4',
      });

      const res = await requestPresigned(result.upload.parts[0].url, {
        method: 'PUT',
        body: randomBytes(2048),
      });

      expect(res.status).toBe(200);
      expect(res.headers.etag).toEqual(expect.any(String));
    });

    it('should give distinct slugs to consecutive videos', async () => {
      const { user } = await createUserWithChannel(dataSource);
      const input = { fileName: 'a.mp4', fileSize: 10, mimeType: 'video/mp4' };

      const first = await service.initiateUpload(user.id, input);
      const second = await service.initiateUpload(user.id, input);

      expect(first.video.slug).not.toBe(second.video.slug);
    });
  });

  describe('getUploadSession', () => {
    it('should report the uploaded part and no pending URLs', async () => {
      const { user } = await createUserWithChannel(dataSource);
      const { initiated, etag } = await startUploadWithOnePart(user.id);

      const session = await service.getUploadSession(
        user.id,
        initiated.video.slug,
      );

      expect(session.uploaded_parts).toEqual([
        { part_number: 1, etag, size: 2048 },
      ]);
      expect(session.parts).toEqual([]);
    });
  });

  describe('completeUpload', () => {
    it('should assemble the object, mark processing and enqueue process-video', async () => {
      const { user } = await createUserWithChannel(dataSource);
      const { initiated, etag } = await startUploadWithOnePart(user.id);

      const view = await service.completeUpload(user.id, initiated.video.slug, [
        { partNumber: 1, etag },
      ]);

      expect(view.status).toBe(VideoStatus.PROCESSING);
      const row = await videoRepository.findOneByOrFail({ id: view.id });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.upload_id).toBeNull();
      const job = await queue.getJob(view.id);
      expect(job?.name).toBe('process-video');
      expect(job?.data).toEqual({ videoId: view.id });
    });

    it('should reject an invalid ETag and keep the video as draft', async () => {
      const { user } = await createUserWithChannel(dataSource);
      const { initiated } = await startUploadWithOnePart(user.id);

      await expect(
        service.completeUpload(user.id, initiated.video.slug, [
          { partNumber: 1, etag: '"0123456789abcdef0123456789abcdef"' },
        ]),
      ).rejects.toMatchObject({ errorCode: 'INVALID_UPLOAD_PARTS' });
      const row = await videoRepository.findOneByOrFail({
        id: initiated.video.id,
      });
      expect(row.status).toBe(VideoStatus.DRAFT);
    });

    it('should not let another user complete the upload', async () => {
      const { user } = await createUserWithChannel(dataSource);
      const { user: intruder } = await createUserWithChannel(dataSource);
      const { initiated, etag } = await startUploadWithOnePart(user.id);

      await expect(
        service.completeUpload(intruder.id, initiated.video.slug, [
          { partNumber: 1, etag },
        ]),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_FOUND' });
    });
  });
});
