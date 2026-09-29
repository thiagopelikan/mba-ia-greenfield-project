import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { generateSampleVideo } from '../test/sample-video';
import { requestPresigned } from '../test/storage-http';
import {
  createUserWithChannel,
  insertVideo,
  testTypeOrmOptions,
} from '../test/video-test-helpers';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideosModule } from '../videos/videos.module';
import { MediaToolsService } from './media-tools.service';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (integration — DB + MinIO + FFmpeg)', () => {
  let dataSource: DataSource;
  let service: VideoProcessingService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let sample: Buffer;
  let samplePath: string;
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
      // The processor is left out on purpose: the service is exercised directly.
      providers: [MediaToolsService, VideoProcessingService],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideoProcessingService);
    storage = moduleRef.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
    close = () => moduleRef.close();

    samplePath = await generateSampleVideo({
      seconds: 3,
      width: 640,
      height: 360,
    });
    sample = await readFile(samplePath);
  }, 60_000);

  afterAll(async () => {
    await rm(dirname(samplePath), { recursive: true, force: true });
    await close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function processingVideoWith(content: Buffer): Promise<Video> {
    const { channel } = await createUserWithChannel(dataSource);
    const video = await insertVideo(dataSource, channel.id, {
      status: VideoStatus.PROCESSING,
      size_bytes: content.length,
    });
    await storage.putObject(video.storage_key, content, 'video/mp4');
    return video;
  }

  it('should mark a real MP4 ready with duration, metadata and a stored thumbnail', async () => {
    const video = await processingVideoWith(sample);

    await service.process(video.id);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration_seconds).toBeCloseTo(3, 0);
    expect(row.metadata).toMatchObject({
      width: 640,
      height: 360,
      video_codec: 'h264',
    });
    expect(row.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    const thumbUrl = await storage.presignGetObject(row.thumbnail_key!, {
      ttlSeconds: 60,
      audience: 'internal',
    });
    const thumb = await requestPresigned(thumbUrl);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
  }, 60_000);

  it('should raise UnrecoverableError for content that is not a video', async () => {
    const video = await processingVideoWith(
      Buffer.from('not a video\n'.repeat(100)),
    );

    await expect(service.process(video.id)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
  }, 60_000);

  it('should leave an already ready video untouched', async () => {
    const { channel } = await createUserWithChannel(dataSource);
    const video = await insertVideo(dataSource, channel.id, {
      status: VideoStatus.READY,
      duration_seconds: 42,
    });

    await service.process(video.id);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.duration_seconds).toBe(42);
  });
});
