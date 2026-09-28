import type { Video } from './entities/video.entity';
import type { VideoView } from './videos.types';

export function toVideoView(
  video: Video,
  thumbnailUrl: string | null,
): VideoView {
  return {
    id: video.id,
    slug: video.slug,
    title: video.title,
    status: video.status,
    original_file_name: video.original_file_name,
    mime_type: video.mime_type,
    size_bytes: video.size_bytes,
    duration_seconds: video.duration_seconds,
    metadata: video.metadata,
    thumbnail_url: thumbnailUrl,
    failure_reason: video.failure_reason,
    created_at: video.created_at,
    updated_at: video.updated_at,
  };
}
