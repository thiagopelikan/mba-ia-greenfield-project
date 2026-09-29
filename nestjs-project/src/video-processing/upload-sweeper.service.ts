import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import videoConfig from '../config/video.config';
import { StorageMultipartException } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { Video } from '../videos/entities/video.entity';
import { VIDEO_JOBS, VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Expires drafts whose upload was abandoned: aborts the multipart upload (so
 * orphaned parts stop consuming storage) and marks them failed/UPLOAD_EXPIRED.
 */
@Injectable()
export class UploadSweeperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UploadSweeperService.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storage: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
  ) {}

  /** Registers (idempotently) the hourly sweep when the worker starts. */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      VIDEO_JOBS.SWEEP,
      { every: SWEEP_INTERVAL_MS },
      { name: VIDEO_JOBS.SWEEP, data: {} },
    );
  }

  /**
   * Abort first, then expire only if still a draft: a completion racing the
   * sweep either fails with NoSuchUpload (the draft is expired) or wins and
   * keeps its `processing` status. One broken draft never blocks the others;
   * failures make the job fail so BullMQ retries the sweep.
   */
  async sweep(now = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.uploadWindowHours * 60 * 60 * 1000,
    );
    const drafts = await this.videosService.findExpiredDrafts(cutoff);

    let expired = 0;
    let failures = 0;
    for (const draft of drafts) {
      try {
        if (await this.expire(draft)) expired++;
      } catch (err) {
        failures++;
        this.logger.error(`Could not expire draft ${draft.id}`, err);
      }
    }
    if (expired > 0) {
      this.logger.log(`Expired ${expired} abandoned upload(s)`);
    }
    if (failures > 0) {
      throw new Error(`${failures} draft(s) could not be expired`);
    }
    return expired;
  }

  private async expire(draft: Video): Promise<boolean> {
    if (draft.upload_id) {
      await this.abortIgnoringMissing(draft.storage_key, draft.upload_id);
      return this.videosService.expireDraft(draft.id);
    }
    // upload_id null: the object was assembled but enqueueing failed and the
    // owner never retried — reclaim the full-size original too.
    const expired = await this.videosService.expireDraft(draft.id);
    if (expired) {
      await this.storage.deleteObject(draft.storage_key);
    }
    return expired;
  }

  private async abortIgnoringMissing(
    key: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(key, uploadId);
    } catch (err) {
      // Already gone (e.g. MinIO's own stale-upload cleanup): nothing to reclaim.
      if (
        !(
          err instanceof StorageMultipartException &&
          err.code === 'NoSuchUpload'
        )
      ) {
        throw err;
      }
    }
  }
}
