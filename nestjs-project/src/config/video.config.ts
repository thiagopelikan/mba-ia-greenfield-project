import { registerAs } from '@nestjs/config';

export default registerAs('video', () => ({
  maxUploadBytes: Number(process.env.VIDEO_MAX_UPLOAD_BYTES || 10737418240),
  uploadPartSizeBytes: Number(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || 67108864,
  ),
  uploadUrlTtlSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS || '3600',
    10,
  ),
  uploadWindowHours: parseInt(
    process.env.VIDEO_UPLOAD_WINDOW_HOURS || '24',
    10,
  ),
}));
