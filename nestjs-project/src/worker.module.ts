import { Module } from '@nestjs/common';
import { RootConfigModule } from './config/root-config.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { UsersModule } from './users/users.module';
import { VideoProcessingModule } from './video-processing/video-processing.module';

/**
 * Root module of the video worker process (no HTTP server). It consumes the
 * `video-processing` queue; the API never imports VideoProcessingModule.
 */
@Module({
  imports: [
    RootConfigModule,
    DatabaseModule,
    QueueModule,
    // Registers the User entity required by the Channel ↔ User relation.
    UsersModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
