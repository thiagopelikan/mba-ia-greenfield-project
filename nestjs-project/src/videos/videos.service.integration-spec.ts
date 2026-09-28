import { randomBytes } from 'node:crypto';
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
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosService (integration — DB + MinIO)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(testTypeOrmOptions()),
        VideosModule,
      ],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideosService);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

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
});
