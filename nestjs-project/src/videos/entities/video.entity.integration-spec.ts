import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoMetadata, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({ email: `video_${n}@example.com`, password: 'x' }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `chan${n}`,
        nickname: `video_chan_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Video {
    const id = randomUUID();
    return videoRepository.create({
      id,
      channel_id: channelId,
      slug: `slug${String(++counter).padStart(7, '0')}`,
      title: 'My clip',
      original_file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: `videos/${id}/original`,
      ...overrides,
    });
  }

  it('should default status to draft', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.upload_id).toBeNull();
    expect(found.failure_reason).toBeNull();
  });

  it('should enforce a unique slug', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, { slug: 'AAAAAAAAAAA' }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { slug: 'AAAAAAAAAAA' })),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('should reject a video for a non-existent channel', async () => {
    await expect(
      videoRepository.save(buildVideo(randomUUID())),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });

  it('should delete videos when their channel is deleted', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(buildVideo(channel.id));

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.findOneBy({ id: video.id })).toBeNull();
  });

  it('should read a 10 GiB size_bytes back as a number', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: 10737418240 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.size_bytes).toBe(10737418240);
  });

  it('should round-trip metadata as jsonb and duration as a float', async () => {
    const channel = await createChannel();
    const metadata: VideoMetadata = {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      size_bytes: 2048,
      bit_rate: 512000,
      width: 1920,
      height: 1080,
      frame_rate: 29.97,
      video_codec: 'h264',
      audio_codec: 'aac',
    };
    const video = await videoRepository.save(
      buildVideo(channel.id, {
        status: VideoStatus.READY,
        duration_seconds: 12.345,
        metadata,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.metadata).toEqual(metadata);
    expect(found.duration_seconds).toBeCloseTo(12.345);
  });
});
