import { ApiProperty } from '@nestjs/swagger';
import { VideoResponseDto } from './video-response.dto';

export class UploadPartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    example: 67108864,
    description: 'Exact byte count this URL accepts (Content-Length is signed)',
  })
  size: number;

  @ApiProperty({ description: 'Presigned PUT URL for this part' })
  url: string;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  size: number;
}

export class UploadPlanDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;

  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  expires_at: Date;
}

export class VideoUploadResponseDto {
  @ApiProperty({ type: VideoResponseDto })
  video: VideoResponseDto;

  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;
}

export class VideoUploadSessionDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;

  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];

  @ApiProperty({
    type: [UploadPartUrlDto],
    description: 'Presigned URLs for the parts not uploaded yet',
  })
  parts: UploadPartUrlDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  expires_at: Date;
}
