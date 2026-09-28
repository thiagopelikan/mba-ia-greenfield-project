import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { In, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOn } from '../common/database/pg-errors';
import {
  InvalidUploadPartsException,
  VideoFileTooLargeException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoNotUploadableException,
  VideoProcessingUnavailableException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageMultipartException } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { CompletedPart } from '../storage/storage.types';
import {
  Video,
  VideoFailureReason,
  type VideoMetadata,
  VideoStatus,
} from './entities/video.entity';
import { generateVideoSlug } from './video-slug.util';
import {
  VIDEO_JOBS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './videos.constants';
import { toVideoView } from './videos.mapper';
import type {
  InitiateUploadInput,
  InitiatedUploadView,
  UploadPartUrlView,
  UploadSessionView,
  VideoView,
} from './videos.types';

const MAX_SLUG_ATTEMPTS = 5;
const TITLE_MAX_LENGTH = 100;

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Pre-registers the video as a draft and opens a multipart upload directly
   * on the object storage; the client uploads each part to its presigned URL.
   */
  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<InitiatedUploadView> {
    if (input.fileSize > this.config.maxUploadBytes) {
      throw new VideoFileTooLargeException(this.config.maxUploadBytes);
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const storageKey = `videos/${id}/original`;
    const uploadId = await this.storage.createMultipartUpload(
      storageKey,
      input.mimeType,
    );

    let video: Video;
    try {
      video = await this.insertDraftWithUniqueSlug(
        this.videoRepository.create({
          id,
          channel_id: channel.id,
          title: this.resolveTitle(input),
          original_file_name: input.fileName,
          mime_type: input.mimeType,
          size_bytes: input.fileSize,
          storage_key: storageKey,
          upload_id: uploadId,
        }),
      );
    } catch (err) {
      // Compensation: do not leave an orphan multipart upload behind.
      await this.storage.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }

    const partCount = this.partCountFor(video.size_bytes);
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    return {
      video: await this.toView(video),
      upload: {
        part_size: this.config.uploadPartSizeBytes,
        part_count: partCount,
        parts: await this.presignParts(video, partNumbers),
        expires_at: this.urlExpiry(),
      },
    };
  }

  /**
   * Visibility rule for phase 03: `ready` videos are public by link; any other
   * status is visible only to the owner (everyone else gets 404).
   */
  async findForViewer(
    slug: string,
    viewerUserId: string | undefined,
  ): Promise<VideoView> {
    return this.toView(await this.findVisible(slug, viewerUserId));
  }

  /** Short-lived presigned URL for the original file (storage serves ranges). */
  async getPlaybackUrl(
    slug: string,
    viewerUserId: string | undefined,
    mode: 'stream' | 'download',
  ): Promise<string> {
    const video = await this.findVisible(slug, viewerUserId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return this.storage.presignGetObject(video.storage_key, {
      ttlSeconds: this.config.playbackUrlTtlSeconds,
      audience: 'public',
      downloadFileName:
        mode === 'download' ? video.original_file_name : undefined,
    });
  }

  /**
   * Resume support: reports the parts already stored and re-signs URLs only
   * for the missing ones.
   */
  async getUploadSession(
    userId: string,
    slug: string,
  ): Promise<UploadSessionView> {
    const video = await this.findOwnedBySlug(userId, slug);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotUploadableException();
    }

    const uploaded = await this.storage.listParts(
      video.storage_key,
      video.upload_id,
    );
    const uploadedNumbers = new Set(uploaded.map((p) => p.partNumber));
    const partCount = this.partCountFor(video.size_bytes);
    const missing = Array.from({ length: partCount }, (_, i) => i + 1).filter(
      (n) => !uploadedNumbers.has(n),
    );

    return {
      part_size: this.config.uploadPartSizeBytes,
      part_count: partCount,
      uploaded_parts: uploaded.map((p) => ({
        part_number: p.partNumber,
        etag: p.etag,
        size: p.size,
      })),
      parts: await this.presignParts(video, missing),
      expires_at: this.urlExpiry(),
    };
  }

  /**
   * Assembles the multipart object, moves the video to `processing` and
   * publishes the processing job (jobId = videoId keeps it idempotent).
   */
  async completeUpload(
    userId: string,
    slug: string,
    parts: CompletedPart[],
  ): Promise<VideoView> {
    const video = await this.findOwnedBySlug(userId, slug);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotUploadableException();
    }

    // upload_id is null when a previous completion assembled the object but
    // failed to enqueue — only the enqueue is retried in that case.
    if (video.upload_id) {
      try {
        await this.storage.completeMultipartUpload(
          video.storage_key,
          video.upload_id,
          parts,
        );
      } catch (err) {
        if (err instanceof StorageMultipartException) {
          throw new InvalidUploadPartsException();
        }
        throw err;
      }
    }

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videoRepository.save(video);

    try {
      await this.processingQueue.add(
        VIDEO_JOBS.PROCESS,
        { videoId: video.id },
        { jobId: video.id },
      );
    } catch {
      video.status = VideoStatus.DRAFT;
      await this.videoRepository.save(video);
      throw new VideoProcessingUnavailableException();
    }

    return this.toView(video);
  }

  async findById(id: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id });
  }

  /** processing → ready; a no-op for videos no longer in processing. */
  async markReady(
    id: string,
    result: {
      durationSeconds: number | null;
      metadata: VideoMetadata;
      thumbnailKey: string;
    },
  ): Promise<boolean> {
    const update = await this.videoRepository.update(
      { id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: result.durationSeconds,
        metadata: result.metadata,
        thumbnail_key: result.thumbnailKey,
        failure_reason: null,
      },
    );
    return (update.affected ?? 0) > 0;
  }

  /** draft|processing → failed with the given reason (terminal state). */
  async markFailed(id: string, reason: VideoFailureReason): Promise<boolean> {
    const update = await this.videoRepository.update(
      { id, status: In([VideoStatus.DRAFT, VideoStatus.PROCESSING]) },
      { status: VideoStatus.FAILED, failure_reason: reason, upload_id: null },
    );
    return (update.affected ?? 0) > 0;
  }

  private async findVisible(
    slug: string,
    viewerUserId: string | undefined,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: { channel: true },
    });
    const isOwner = !!video && video.channel.user_id === viewerUserId;
    if (!video || (video.status !== VideoStatus.READY && !isOwner)) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async findOwnedBySlug(userId: string, slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: { channel: true },
    });
    if (!video || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async insertDraftWithUniqueSlug(draft: Video): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      draft.slug = generateVideoSlug();
      try {
        return await this.videoRepository.save(draft);
      } catch (err) {
        if (!isUniqueViolationOn(err, 'slug') || attempt >= MAX_SLUG_ATTEMPTS) {
          throw err;
        }
      }
    }
  }

  private async presignParts(
    video: Video,
    partNumbers: number[],
  ): Promise<UploadPartUrlView[]> {
    const uploadId = video.upload_id as string;
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          video.storage_key,
          uploadId,
          partNumber,
          this.config.uploadUrlTtlSeconds,
        ),
      })),
    );
  }

  private partCountFor(sizeBytes: number): number {
    return Math.max(1, Math.ceil(sizeBytes / this.config.uploadPartSizeBytes));
  }

  private urlExpiry(): Date {
    return new Date(Date.now() + this.config.uploadUrlTtlSeconds * 1000);
  }

  private resolveTitle(input: InitiateUploadInput): string {
    const raw = input.title?.trim() || parse(input.fileName).name.trim();
    return (raw || input.fileName).slice(0, TITLE_MAX_LENGTH);
  }

  private async toView(video: Video): Promise<VideoView> {
    const thumbnailUrl = video.thumbnail_key
      ? await this.storage.presignGetObject(video.thumbnail_key, {
          ttlSeconds: this.config.playbackUrlTtlSeconds,
          audience: 'public',
        })
      : null;
    return toVideoView(video, thumbnailUrl);
  }
}
