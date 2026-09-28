export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const VIDEO_JOBS = {
  PROCESS: 'process-video',
  SWEEP: 'sweep-expired-uploads',
} as const;

export interface ProcessVideoJobData {
  videoId: string;
}
