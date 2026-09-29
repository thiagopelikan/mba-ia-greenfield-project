import { Job, UnrecoverableError } from 'bullmq';
import { VideoFailureReason } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'video-1',
    name: 'process-video',
    data: { videoId: 'video-1' },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  } as Job;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let processing: { process: jest.Mock };
  let videosService: { markFailed: jest.Mock };
  let sweeper: { sweep: jest.Mock };

  beforeEach(() => {
    processing = { process: jest.fn().mockResolvedValue(undefined) };
    videosService = { markFailed: jest.fn().mockResolvedValue(true) };
    sweeper = { sweep: jest.fn().mockResolvedValue(2) };
    processor = new VideoProcessingProcessor(
      processing as any,
      videosService as any,
      sweeper as any,
    );
  });

  describe('process', () => {
    it('should dispatch process-video jobs to the processing service', async () => {
      await processor.process(job());

      expect(processing.process).toHaveBeenCalledWith('video-1');
    });

    it('should dispatch sweep-expired-uploads jobs to the sweeper', async () => {
      await expect(
        processor.process(job({ name: 'sweep-expired-uploads', data: {} })),
      ).resolves.toBe(2);
      expect(sweeper.sweep).toHaveBeenCalled();
    });

    it('should reject unknown job names', async () => {
      await expect(processor.process(job({ name: 'other' }))).rejects.toThrow(
        'Unknown job name: other',
      );
    });
  });

  describe('onFailed', () => {
    it('should ignore failures of sweep jobs', async () => {
      await processor.onFailed(
        job({ name: 'sweep-expired-uploads', attemptsMade: 3 }),
        new Error('boom'),
      );

      expect(videosService.markFailed).not.toHaveBeenCalled();
    });

    it('should not mark the video failed while retries remain', async () => {
      await processor.onFailed(job({ attemptsMade: 1 }), new Error('boom'));

      expect(videosService.markFailed).not.toHaveBeenCalled();
    });

    it('should mark PROCESSING_ERROR after the last attempt', async () => {
      await processor.onFailed(job({ attemptsMade: 3 }), new Error('boom'));

      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-1',
        VideoFailureReason.PROCESSING_ERROR,
      );
    });

    it('should mark INVALID_MEDIA immediately for unrecoverable errors', async () => {
      await processor.onFailed(
        job({ attemptsMade: 1 }),
        new UnrecoverableError('INVALID_MEDIA'),
      );

      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-1',
        VideoFailureReason.INVALID_MEDIA,
      );
    });

    it('should not throw when marking the video fails', async () => {
      videosService.markFailed.mockRejectedValue(new Error('db down'));

      await expect(
        processor.onFailed(job({ attemptsMade: 3 }), new Error('boom')),
      ).resolves.toBeUndefined();
    });
  });
});
