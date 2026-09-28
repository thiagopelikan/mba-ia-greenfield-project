import { QueryFailedError } from 'typeorm';
import {
  InvalidUploadPartsException,
  VideoFileTooLargeException,
  VideoNotFoundException,
  VideoNotUploadableException,
  VideoProcessingUnavailableException,
} from '../common/exceptions/domain.exception';
import { StorageMultipartException } from '../storage/storage.errors';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const MIB = 1024 * 1024;
const config = {
  maxUploadBytes: 10737418240,
  uploadPartSizeBytes: 64 * MIB,
  uploadUrlTtlSeconds: 3600,
  playbackUrlTtlSeconds: 3600,
  uploadWindowHours: 24,
};

function slugViolation(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = 'Key (slug)=(abc) already exists.';
  return err;
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let queue: { add: jest.Mock };
  let channelsService: { findByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    abortMultipartUpload: jest.Mock;
    listParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
  };

  beforeEach(() => {
    videoRepository = {
      create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
      save: jest.fn((video: Video) =>
        Promise.resolve({
          ...video,
          status: VideoStatus.DRAFT,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      ),
      findOne: jest.fn(),
    };
    queue = { add: jest.fn().mockResolvedValue({ id: 'job' }) };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadPart: jest.fn(
        (_key: string, _upload: string, part: number) =>
          Promise.resolve(`https://storage/part-${part}`),
      ),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      listParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    service = new VideosService(
      videoRepository as any,
      channelsService as any,
      storage as any,
      config,
      queue as any,
    );
  });

  describe('initiateUpload', () => {
    const input = {
      fileName: 'My Trip.mp4',
      fileSize: 150 * MIB,
      mimeType: 'video/mp4',
    };

    it('should create a draft with one presigned URL per part', async () => {
      const result = await service.initiateUpload('user-1', input);

      expect(result.upload.part_count).toBe(3);
      expect(result.upload.part_size).toBe(64 * MIB);
      expect(result.upload.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
      expect(result.video.status).toBe(VideoStatus.DRAFT);
      const saved = videoRepository.save.mock.calls[0][0] as Video;
      expect(saved.channel_id).toBe('channel-1');
      expect(saved.upload_id).toBe('upload-1');
      expect(saved.storage_key).toBe(`videos/${saved.id}/original`);
    });

    it('should default the title to the file name without extension', async () => {
      const result = await service.initiateUpload('user-1', input);

      expect(result.video.title).toBe('My Trip');
    });

    it('should accept exactly 10 GiB with 160 parts', async () => {
      const result = await service.initiateUpload('user-1', {
        ...input,
        fileSize: 10737418240,
      });

      expect(result.upload.part_count).toBe(160);
    });

    it('should reject files above the maximum size without touching storage', async () => {
      await expect(
        service.initiateUpload('user-1', { ...input, fileSize: 10737418241 }),
      ).rejects.toBeInstanceOf(VideoFileTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('should retry with a new slug on a slug collision', async () => {
      videoRepository.save.mockRejectedValueOnce(slugViolation());

      await service.initiateUpload('user-1', input);

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
    });

    it('should abort the multipart upload when the draft cannot be saved', async () => {
      videoRepository.save.mockRejectedValue(new Error('db down'));

      await expect(service.initiateUpload('user-1', input)).rejects.toThrow(
        'db down',
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original$/),
        'upload-1',
      );
    });
  });

  function ownedVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      slug: 'abcdefghijk',
      status: VideoStatus.DRAFT,
      size_bytes: 150 * MIB,
      storage_key: 'videos/video-1/original',
      upload_id: 'upload-1',
      channel: { user_id: 'owner' },
      ...overrides,
    } as Video;
  }

  describe('getUploadSession', () => {
    it('should list stored parts and re-sign only the missing ones', async () => {
      videoRepository.findOne.mockResolvedValue(ownedVideo());
      storage.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"e1"', size: 64 * MIB },
      ]);

      const session = await service.getUploadSession('owner', 'abcdefghijk');

      expect(session.uploaded_parts).toEqual([
        { part_number: 1, etag: '"e1"', size: 64 * MIB },
      ]);
      expect(session.parts.map((p) => p.part_number)).toEqual([2, 3]);
      expect(session.part_count).toBe(3);
    });

    it('should hide videos of other channels as not found', async () => {
      videoRepository.findOne.mockResolvedValue(ownedVideo());

      await expect(
        service.getUploadSession('intruder', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should reject videos that are no longer drafts', async () => {
      videoRepository.findOne.mockResolvedValue(
        ownedVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.getUploadSession('owner', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
    });
  });

  describe('completeUpload', () => {
    const parts = [{ partNumber: 1, etag: '"e1"' }];

    it('should assemble the object, mark processing and enqueue with jobId = videoId', async () => {
      videoRepository.findOne.mockResolvedValue(ownedVideo());

      const view = await service.completeUpload('owner', 'abcdefghijk', parts);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        parts,
      );
      expect(view.status).toBe(VideoStatus.PROCESSING);
      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-1' },
        { jobId: 'video-1' },
      );
      const saved = videoRepository.save.mock.calls[0][0] as Video;
      expect(saved.upload_id).toBeNull();
    });

    it('should map storage part errors to INVALID_UPLOAD_PARTS and keep the draft', async () => {
      videoRepository.findOne.mockResolvedValue(ownedVideo());
      storage.completeMultipartUpload.mockRejectedValue(
        new StorageMultipartException('InvalidPart', 'bad etag'),
      );

      await expect(
        service.completeUpload('owner', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(videoRepository.save).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should revert to draft and raise VIDEO_PROCESSING_UNAVAILABLE when enqueue fails', async () => {
      videoRepository.findOne.mockResolvedValue(ownedVideo());
      queue.add.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload('owner', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(VideoProcessingUnavailableException);
      const lastSaved = videoRepository.save.mock.calls.at(-1)[0] as Video;
      expect(lastSaved.status).toBe(VideoStatus.DRAFT);
      expect(lastSaved.upload_id).toBeNull();
    });

    it('should only re-enqueue when the object was already assembled', async () => {
      videoRepository.findOne.mockResolvedValue(
        ownedVideo({ upload_id: null }),
      );

      await service.completeUpload('owner', 'abcdefghijk', parts);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
    });

    it('should reject completion of non-draft videos', async () => {
      videoRepository.findOne.mockResolvedValue(
        ownedVideo({ status: VideoStatus.READY }),
      );

      await expect(
        service.completeUpload('owner', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
    });
  });
});
