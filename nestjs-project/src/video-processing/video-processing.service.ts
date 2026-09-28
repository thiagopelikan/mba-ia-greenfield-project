import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import {
  VideoFailureReason,
  VideoStatus,
} from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';
import {
  InvalidMediaError,
  MediaToolsService,
  thumbnailTimestamp,
} from './media-tools.service';

/** Validity of the internal URL FFmpeg reads the original from. */
const SOURCE_URL_TTL_SECONDS = 900;

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storage: StorageService,
    private readonly media: MediaToolsService,
  ) {}

  /**
   * Extracts duration/metadata and a thumbnail, then marks the video ready.
   * Idempotent: videos that are not in `processing` are skipped. Content that
   * is not a video raises UnrecoverableError (no retries → INVALID_MEDIA).
   */
  async process(videoId: string): Promise<void> {
    const video = await this.videosService.findById(videoId);
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.log(`Skipping video ${videoId}: not in processing`);
      return;
    }

    const sourceUrl = await this.storage.presignGetObject(video.storage_key, {
      ttlSeconds: SOURCE_URL_TTL_SECONDS,
      audience: 'internal',
    });

    const probe = await this.media.probe(sourceUrl).catch((err: unknown) => {
      if (err instanceof InvalidMediaError) {
        throw new UnrecoverableError(VideoFailureReason.INVALID_MEDIA);
      }
      throw err;
    });
    if (!probe.hasVideoStream) {
      throw new UnrecoverableError(VideoFailureReason.INVALID_MEDIA);
    }

    const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
    const workDir = await mkdtemp(join(tmpdir(), `video-${video.id}-`));
    try {
      const framePath = join(workDir, 'thumbnail.jpg');
      await this.media.extractFrame(
        sourceUrl,
        thumbnailTimestamp(probe.durationSeconds),
        framePath,
      );
      await this.storage.putObject(
        thumbnailKey,
        await readFile(framePath),
        'image/jpeg',
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }

    await this.videosService.markReady(video.id, {
      durationSeconds: probe.durationSeconds,
      metadata: probe.metadata,
      thumbnailKey,
    });
    this.logger.log(`Video ${video.id} is ready`);
  }
}
