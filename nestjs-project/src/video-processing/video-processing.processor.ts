import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { VideoFailureReason } from '../videos/entities/video.entity';
import {
  VIDEO_JOBS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';
import { UploadSweeperService } from './upload-sweeper.service';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 2 })
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly processing: VideoProcessingService,
    private readonly videosService: VideosService,
    private readonly sweeper: UploadSweeperService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case VIDEO_JOBS.PROCESS:
        return this.processing.process(
          (job.data as ProcessVideoJobData).videoId,
        );
      case VIDEO_JOBS.SWEEP:
        return this.sweeper.sweep();
      default:
        throw new Error(`Unknown job name: ${job.name}`);
    }
  }

  /**
   * Marks the video failed once no retry is left: immediately for
   * UnrecoverableError (invalid media), otherwise after the last attempt.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job || job.name !== VIDEO_JOBS.PROCESS) return;

    const unrecoverable = error.name === 'UnrecoverableError';
    const lastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!unrecoverable && !lastAttempt) {
      this.logger.warn(
        `Video job ${job.id} attempt ${job.attemptsMade} failed: ${error.message}`,
      );
      return;
    }

    const reason = unrecoverable
      ? VideoFailureReason.INVALID_MEDIA
      : VideoFailureReason.PROCESSING_ERROR;
    const { videoId } = job.data as ProcessVideoJobData;
    try {
      await this.videosService.markFailed(videoId, reason);
      this.logger.error(
        `Video ${videoId} failed (${reason}): ${error.message}`,
      );
    } catch (err) {
      // Background event handler: log instead of crashing the worker.
      this.logger.error(`Could not mark video ${videoId} as failed`, err);
    }
  }
}
