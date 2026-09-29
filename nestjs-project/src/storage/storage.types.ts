export type PresignAudience = 'public' | 'internal';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface PresignGetOptions {
  ttlSeconds: number;
  /** `public` signs for S3_PUBLIC_ENDPOINT (clients); `internal` for S3_ENDPOINT (worker). */
  audience: PresignAudience;
  /** When set, the URL forces a download with this file name. */
  downloadFileName?: string;
}
