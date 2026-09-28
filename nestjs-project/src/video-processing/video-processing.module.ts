import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { MediaToolsService } from './media-tools.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

/** Queue consumer side — imported only by the video worker, never by the API. */
@Module({
  imports: [VideosModule, StorageModule],
  providers: [
    MediaToolsService,
    VideoProcessingService,
    VideoProcessingProcessor,
  ],
})
export class VideoProcessingModule {}
