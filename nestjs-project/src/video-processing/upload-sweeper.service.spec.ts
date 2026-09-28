import { StorageMultipartException } from '../storage/storage.errors';
import { Video } from '../videos/entities/video.entity';
import { UploadSweeperService } from './upload-sweeper.service';

describe('UploadSweeperService', () => {
  let sweeper: UploadSweeperService;
  let videosService: { findExpiredDrafts: jest.Mock; expireDraft: jest.Mock };
  let storage: { abortMultipartUpload: jest.Mock; deleteObject: jest.Mock };

  const draft = (id: string, uploadId: string | null) =>
    ({
      id,
      upload_id: uploadId,
      storage_key: `videos/${id}/original`,
    }) as Video;

  beforeEach(() => {
    videosService = {
      findExpiredDrafts: jest.fn(),
      expireDraft: jest.fn().mockResolvedValue(true),
    };
    storage = {
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    sweeper = new UploadSweeperService(
      videosService as any,
      storage as any,
      { uploadWindowHours: 24 } as any,
      {} as any,
    );
  });

  it('should abort before expiring, so a completion that won the race is not expired', async () => {
    videosService.findExpiredDrafts.mockResolvedValue([draft('a', 'up-a')]);
    videosService.expireDraft.mockResolvedValue(false);

    await expect(sweeper.sweep()).resolves.toBe(0);
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/a/original',
      'up-a',
    );
  });

  it('should tolerate uploads already gone from storage', async () => {
    videosService.findExpiredDrafts.mockResolvedValue([draft('a', 'up-a')]);
    storage.abortMultipartUpload.mockRejectedValue(
      new StorageMultipartException('NoSuchUpload', 'gone'),
    );

    await expect(sweeper.sweep()).resolves.toBe(1);
  });

  it('should delete the assembled original of a draft that never got enqueued', async () => {
    videosService.findExpiredDrafts.mockResolvedValue([draft('b', null)]);

    await expect(sweeper.sweep()).resolves.toBe(1);
    expect(storage.deleteObject).toHaveBeenCalledWith('videos/b/original');
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('should keep sweeping after one draft fails and then fail the job for a retry', async () => {
    videosService.findExpiredDrafts.mockResolvedValue([
      draft('a', 'up-a'),
      draft('b', 'up-b'),
    ]);
    storage.abortMultipartUpload
      .mockRejectedValueOnce(new Error('storage timeout'))
      .mockResolvedValueOnce(undefined);

    await expect(sweeper.sweep()).rejects.toThrow(
      '1 draft(s) could not be expired',
    );
    expect(videosService.expireDraft).toHaveBeenCalledTimes(1);
    expect(videosService.expireDraft).toHaveBeenCalledWith('b');
  });
});
