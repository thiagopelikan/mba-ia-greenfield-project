import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOn } from '../common/database/pg-errors';
import { VideoFileTooLargeException } from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './video-slug.util';
import { toVideoView } from './videos.mapper';
import type {
  InitiateUploadInput,
  InitiatedUploadView,
  UploadPartUrlView,
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
      video: this.toView(video),
      upload: {
        part_size: this.config.uploadPartSizeBytes,
        part_count: partCount,
        parts: await this.presignParts(video, partNumbers),
        expires_at: this.urlExpiry(),
      },
    };
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

  private toView(video: Video): VideoView {
    return toVideoView(video, null);
  }
}
