import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import {
  VideoUploadResponseDto,
  VideoUploadSessionDto,
} from './dto/video-upload.dto';
import { VideosService } from './videos.service';
import type {
  InitiatedUploadView,
  UploadSessionView,
  VideoView,
} from './videos.types';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };
const redirectHeaders = {
  Location: {
    description: 'Short-lived presigned URL of the original file',
    schema: { type: 'string' },
  },
};

// Rate limiting targets auth endpoints (phase-02-auth/TD-08); uploads and
// playback (players, polling) must not be throttled.
@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel and opens a multipart upload directly on the object storage. The client PUTs each part to its presigned URL and then completes the upload.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created with one presigned URL per part',
    type: VideoUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or VIDEO_FILE_TOO_LARGE',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid token',
    schema: errorSchema,
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoUploadDto,
  ): Promise<InitiatedUploadView> {
    return this.videosService.initiateUpload(user.sub, {
      fileName: dto.file_name,
      fileSize: dto.file_size,
      mimeType: dto.mime_type,
      title: dto.title,
    });
  }

  @Get(':slug/upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Resume a video upload',
    description:
      'Lists the parts already stored and returns fresh presigned URLs for the missing parts (owner only).',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload session',
    type: VideoUploadSessionDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_UPLOADABLE',
    schema: errorSchema,
  })
  async getUploadSession(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<UploadSessionView> {
    return this.videosService.getUploadSession(user.sub, slug);
  }

  @Post(':slug/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Assembles the uploaded parts, moves the video to processing and enqueues the background processing job (owner only).',
  })
  @ApiResponse({
    status: 202,
    description: 'Processing started',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or INVALID_UPLOAD_PARTS',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_UPLOADABLE',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 503,
    description: 'VIDEO_PROCESSING_UNAVAILABLE',
    schema: errorSchema,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: CompleteVideoUploadDto,
  ): Promise<VideoView> {
    return this.videosService.completeUpload(
      user.sub,
      slug,
      dto.parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
    );
  }

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Public for ready videos; drafts, processing and failed videos are visible only to their owner (optional Bearer token).',
  })
  @ApiResponse({ status: 200, description: 'Video', type: VideoResponseDto })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorSchema,
  })
  async findOne(
    @Param('slug') slug: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<VideoView> {
    return this.videosService.findForViewer(slug, user?.sub);
  }

  @Public()
  @Get(':slug/stream')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived presigned URL of the original file; the storage answers Range requests with 206 Partial Content.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the video',
    headers: redirectHeaders,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: errorSchema,
  })
  async stream(
    @Param('slug') slug: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<{ url: string }> {
    return {
      url: await this.videosService.getPlaybackUrl(slug, user?.sub, 'stream'),
    };
  }

  @Public()
  @Get(':slug/download')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a short-lived presigned URL that downloads the original file with its original file name.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the file',
    headers: redirectHeaders,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: errorSchema,
  })
  async download(
    @Param('slug') slug: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<{ url: string }> {
    return {
      url: await this.videosService.getPlaybackUrl(slug, user?.sub, 'download'),
    };
  }
}
