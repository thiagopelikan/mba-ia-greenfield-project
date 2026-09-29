import { randomUUID } from 'node:crypto';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { createTestDataSource } from './create-test-data-source';

export const ALL_TEST_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];

/** TypeORM options for Nest test modules against the migrated test DB. */
export function testTypeOrmOptions(): TypeOrmModuleOptions {
  return {
    ...createTestDataSource(ALL_TEST_ENTITIES, { synchronize: false }).options,
    retryAttempts: 0,
  } as TypeOrmModuleOptions;
}

let sequence = 0;

/** Creates a user with its channel (the 1:1 pair every video belongs to). */
export async function createUserWithChannel(
  dataSource: DataSource,
): Promise<{ user: User; channel: Channel }> {
  const n = `${Date.now()}_${++sequence}`;
  const user = await dataSource.getRepository(User).save({
    email: `owner_${n}@example.com`,
    password: 'hashed',
    is_confirmed: true,
  });
  const channel = await dataSource.getRepository(Channel).save({
    name: `owner_${n}`.slice(0, 50),
    nickname: `owner_${n}`.slice(0, 50),
    user_id: user.id,
  });
  return { user, channel };
}

/** Inserts a video row directly (bypassing upload) for state-based tests. */
export async function insertVideo(
  dataSource: DataSource,
  channelId: string,
  overrides: Partial<Video> = {},
): Promise<Video> {
  const id = overrides.id ?? randomUUID();
  return dataSource.getRepository(Video).save({
    id,
    channel_id: channelId,
    slug: randomUUID().replace(/-/g, '').slice(0, 11),
    title: 'Test video',
    status: VideoStatus.DRAFT,
    original_file_name: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: 1024,
    storage_key: `videos/${id}/original`,
    ...overrides,
  });
}
