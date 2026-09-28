import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createUserWithChannel,
  insertVideo,
  testTypeOrmOptions,
} from '../test/video-test-helpers';
import {
  Video,
  VideoFailureReason,
  VideoStatus,
} from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideosModule } from '../videos/videos.module';
import {
  SWEEP_INTERVAL_MS,
  UploadSweeperService,
} from './upload-sweeper.service';

describe('UploadSweeperService (integration — DB + MinIO + Redis)', () => {
  let dataSource: DataSource;
  let sweeper: UploadSweeperService;
  let storage: StorageService;
  let queue: Queue;
  let videoRepository: Repository<Video>;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(testTypeOrmOptions()),
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
          prefix: 'bull-test',
        }),
        VideosModule,
        StorageModule,
      ],
      providers: [UploadSweeperService],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    sweeper = moduleRef.get(UploadSweeperService);
    storage = moduleRef.get(StorageService);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    videoRepository = dataSource.getRepository(Video);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function draftCreatedHoursAgo(hours: number): Promise<Video> {
    const { channel } = await createUserWithChannel(dataSource);
    const video = await insertVideo(dataSource, channel.id);
    const uploadId = await storage.createMultipartUpload(
      video.storage_key,
      'video/mp4',
    );
    await dataSource.query(
      `UPDATE "videos" SET "upload_id" = $1,
         "created_at" = now() - make_interval(hours => $2)
       WHERE "id" = $3`,
      [uploadId, hours, video.id],
    );
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  it('should expire a stale draft and abort its multipart upload', async () => {
    const stale = await draftCreatedHoursAgo(25);

    const expired = await sweeper.sweep();

    expect(expired).toBe(1);
    const row = await videoRepository.findOneByOrFail({ id: stale.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.failure_reason).toBe(VideoFailureReason.UPLOAD_EXPIRED);
    expect(row.upload_id).toBeNull();
    await expect(
      storage.listParts(stale.storage_key, stale.upload_id!),
    ).rejects.toMatchObject({ code: 'NoSuchUpload' });
  });

  it('should keep recent drafts and videos that are not drafts', async () => {
    const recent = await draftCreatedHoursAgo(1);
    const { channel } = await createUserWithChannel(dataSource);
    const oldReady = await insertVideo(dataSource, channel.id, {
      status: VideoStatus.READY,
    });
    await dataSource.query(
      `UPDATE "videos" SET "created_at" = now() - interval '48 hours' WHERE "id" = $1`,
      [oldReady.id],
    );

    const expired = await sweeper.sweep();

    expect(expired).toBe(0);
    expect(
      (await videoRepository.findOneByOrFail({ id: recent.id })).status,
    ).toBe(VideoStatus.DRAFT);
    expect(
      (await videoRepository.findOneByOrFail({ id: oldReady.id })).status,
    ).toBe(VideoStatus.READY);
    await storage.abortMultipartUpload(recent.storage_key, recent.upload_id!);
  });

  it('should tolerate uploads that no longer exist in storage', async () => {
    const stale = await draftCreatedHoursAgo(30);
    await storage.abortMultipartUpload(stale.storage_key, stale.upload_id!);

    await expect(sweeper.sweep()).resolves.toBe(1);
  });

  it('should register the hourly sweep job scheduler on bootstrap', async () => {
    await sweeper.onApplicationBootstrap();

    const scheduler = await queue.getJobScheduler('sweep-expired-uploads');
    expect(scheduler?.every).toBe(SWEEP_INTERVAL_MS);
  });
});
