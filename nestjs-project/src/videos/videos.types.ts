import type { VideoMetadata, VideoStatus } from './entities/video.entity';

export interface InitiateUploadInput {
  fileName: string;
  fileSize: number;
  mimeType: string;
  title?: string;
}

/** Wire shape of a video (snake_case, per the phase 03 API contracts). */
export interface VideoView {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
  original_file_name: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  metadata: VideoMetadata | null;
  thumbnail_url: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UploadPartUrlView {
  part_number: number;
  url: string;
}

export interface UploadPlanView {
  part_size: number;
  part_count: number;
  parts: UploadPartUrlView[];
  expires_at: Date;
}

export interface InitiatedUploadView {
  video: VideoView;
  upload: UploadPlanView;
}

export interface UploadedPartView {
  part_number: number;
  etag: string;
  size: number;
}

export interface UploadSessionView {
  part_size: number;
  part_count: number;
  uploaded_parts: UploadedPartView[];
  parts: UploadPartUrlView[];
  expires_at: Date;
}
