import { writeFile } from 'node:fs/promises';
import { UnrecoverableError } from 'bullmq';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { InvalidMediaError } from './media-tools.service';
import { VideoProcessingService } from './video-processing.service';

const metadata = {
  format_name: 'mp4',
  size_bytes: 10,
  bit_rate: 1,
  width: 320,
  height: 240,
  frame_rate: 25,
  video_codec: 'h264',
  audio_codec: 'aac',
};

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let videosService: { findById: jest.Mock; markReady: jest.Mock };
  let storage: { presignGetObject: jest.Mock; putObject: jest.Mock };
  let media: { probe: jest.Mock; extractFrame: jest.Mock };

  const processingVideo = {
    id: 'video-1',
    status: VideoStatus.PROCESSING,
    storage_key: 'videos/video-1/original',
  } as Video;

  beforeEach(() => {
    videosService = {
      findById: jest.fn().mockResolvedValue(processingVideo),
      markReady: jest.fn().mockResolvedValue(true),
    };
    storage = {
      presignGetObject: jest.fn().mockResolvedValue('http://minio/signed'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    media = {
      probe: jest.fn().mockResolvedValue({
        durationSeconds: 10,
        hasVideoStream: true,
        metadata,
      }),
      extractFrame: jest.fn((_url: string, _t: number, out: string) =>
        writeFile(out, Buffer.from([0xff, 0xd8])),
      ),
    };
    service = new VideoProcessingService(
      videosService as any,
      storage as any,
      media as any,
    );
  });

  it('should skip videos that are not in processing', async () => {
    videosService.findById.mockResolvedValue({
      ...processingVideo,
      status: VideoStatus.READY,
    });

    await service.process('video-1');

    expect(media.probe).not.toHaveBeenCalled();
    expect(videosService.markReady).not.toHaveBeenCalled();
  });

  it('should store the thumbnail and mark the video ready', async () => {
    await service.process('video-1');

    expect(media.extractFrame).toHaveBeenCalledWith(
      'http://minio/signed',
      1,
      expect.stringMatching(/thumbnail\.jpg$/),
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(videosService.markReady).toHaveBeenCalledWith('video-1', {
      durationSeconds: 10,
      metadata,
      thumbnailKey: 'videos/video-1/thumbnail.jpg',
    });
  });

  it('should raise UnrecoverableError when the file has no video stream', async () => {
    media.probe.mockResolvedValue({
      durationSeconds: 3,
      hasVideoStream: false,
      metadata,
    });

    await expect(service.process('video-1')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(videosService.markReady).not.toHaveBeenCalled();
  });

  it('should raise UnrecoverableError when FFmpeg rejects the content', async () => {
    media.probe.mockRejectedValue(new InvalidMediaError('Invalid data'));

    await expect(service.process('video-1')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('should let transient errors propagate for retry', async () => {
    media.extractFrame.mockRejectedValue(new Error('connection reset'));

    await expect(service.process('video-1')).rejects.toThrow(
      'connection reset',
    );
    expect(videosService.markReady).not.toHaveBeenCalled();
  });
});
