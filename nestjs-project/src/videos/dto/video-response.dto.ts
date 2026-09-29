import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoMetadataDto {
  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  format_name: string;

  @ApiProperty({ type: Number, nullable: true, example: 1048576 })
  size_bytes: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 2500000 })
  bit_rate: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 29.97 })
  frame_rate: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;
}

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', description: 'Unique 11-char URL id' })
  slug: string;

  @ApiProperty({ example: 'My trip' })
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ example: 'my-trip.mp4' })
  original_file_name: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ example: 157286400 })
  size_bytes: number;

  @ApiProperty({ type: Number, nullable: true, example: 12.5 })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Short-lived presigned URL of the generated thumbnail',
  })
  thumbnail_url: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'INVALID_MEDIA | PROCESSING_ERROR | UPLOAD_EXPIRED',
  })
  failure_reason: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updated_at: Date;
}
