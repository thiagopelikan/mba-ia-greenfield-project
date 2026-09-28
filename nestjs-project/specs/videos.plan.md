---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos.e2e-spec.ts
---

# Videos Endpoints Test Plan

## Application Overview

The videos controller exposes the Phase 03 HTTP contract: authenticated users pre-register a video (`POST /videos`) and receive presigned part URLs for a direct-to-storage multipart upload, can resume (`GET /videos/:slug/upload`) and complete it (`POST /videos/:slug/upload/complete`), which enqueues processing. Anyone can read metadata, stream and download `ready` videos by slug; unfinished videos are visible only to their owner. These scenarios exercise the full HTTP cycle (routing, global JWT guard with optional auth on public routes, ValidationPipe, domain exception filter) against the real `db`, `minio` and `redis` services.

## Test Scenarios

### 1. POST /videos — pre-registration and upload initiation

**Setup:** `beforeEach` cleans all tables (`cleanAllTables`) and throttler storage; `beforeAll` boots `AppModule` via `Test.createTestingModule` with the global `ValidationPipe` and exception filters from `main.ts`; a confirmed user is registered and logged in to obtain `access_token`.

#### 1.1. rejects-anonymous-initiation

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-28T21:30:00Z

**Steps:**
  1. POST /videos without Authorization header, body `{ file_name: "clip.mp4", file_size: 1048576, mime_type: "video/mp4" }`
    - expect: status 401

#### 1.2. creates-draft-with-part-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-28T21:30:00Z

**Steps:**
  1. POST /videos with Bearer token, body `{ file_name: "clip.mp4", file_size: 150 * 1024 * 1024, mime_type: "video/mp4" }`
    - expect: status 201
    - expect: `video.status` is `"draft"`, `video.title` is `"clip"`, `video.slug` has 11 characters
    - expect: `upload.part_count` equals `ceil(file_size / upload.part_size)` and `upload.parts` has that many items, each with a `url` pointing to the public storage endpoint
    - expect: a `videos` row exists for the user's channel with a non-null `upload_id`

#### 1.3. rejects-non-video-mime-type

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-28T21:30:00Z

**Steps:**
  1. POST /videos with Bearer token, body with `mime_type: "image/png"`
    - expect: status 400 (validation error envelope)

#### 1.4. rejects-files-over-10gib

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-28T21:30:00Z

**Steps:**
  1. POST /videos with Bearer token, body with `file_size: 10737418241`
    - expect: status 400 with `error: "VIDEO_FILE_TOO_LARGE"`
    - expect: no `videos` row was created
  2. POST /videos with Bearer token, body with `file_size: 10737418240`
    - expect: status 201 with `upload.part_count` = 160

### 2. Upload resume and completion

**Setup:** same as group 1; the owner initiates a small upload (one part) and uploads the part bytes to the presigned URL (request sent to the internal MinIO host with the signed public `Host` header).

#### 2.1. resume-lists-uploaded-parts

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T21:30:00Z

**Steps:**
  1. GET /videos/:slug/upload with the owner's token after uploading part 1
    - expect: status 200, `uploaded_parts` contains part 1 with its ETag, `parts` is empty
  2. GET /videos/:slug/upload with another user's token
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`

#### 2.2. completes-upload-and-enqueues-processing

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T21:30:00Z

**Steps:**
  1. POST /videos/:slug/upload/complete by another user with the uploaded parts
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
  2. POST /videos/:slug/upload/complete by the owner with `{ parts: [{ part_number: 1, etag }] }`
    - expect: status 202 with `status: "processing"`
    - expect: the `video-processing` queue holds a `process-video` job whose id is the video id
  3. POST /videos/:slug/upload/complete again by the owner
    - expect: status 409 with `error: "VIDEO_NOT_UPLOADABLE"`

#### 2.3. rejects-invalid-parts

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T21:30:00Z

**Steps:**
  1. POST /videos/:slug/upload/complete by the owner with `{ parts: [{ part_number: 1, etag: "\"bogus\"" }] }`
    - expect: status 400 with `error: "INVALID_UPLOAD_PARTS"`
    - expect: the video is still `draft`

#### 2.4. binds-part-urls-to-exact-sizes

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-28T22:30:00Z

**Steps:**
  1. POST /videos by the owner with `file_size: 2048`
    - expect: `upload.parts[0].size` is 2048
  2. PUT 4096 bytes to `upload.parts[0].url`
    - expect: the storage rejects it with 403 (Content-Length is signed)

#### 2.5. rejects-incomplete-part-lists

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T22:30:00Z

**Steps:**
  1. POST /videos by the owner with a size that needs more than one part (150 MiB)
  2. POST /videos/:slug/upload/complete listing only part 1
    - expect: status 400 with `error: "INVALID_UPLOAD_PARTS"`

### 3. Playback access by slug

**Setup:** same as group 1; videos are inserted directly through the repository in the needed status (a `ready` video has its original object uploaded to the bucket).

#### 3.1. hides-unfinished-videos-from-non-owners

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-28T21:30:00Z

**Steps:**
  1. GET /videos/:slug of a `processing` video without token
    - expect: status 404 with `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/:slug of the same video with the owner's token
    - expect: status 200 with `status: "processing"`
  3. GET /videos/:slug of a `ready` video without token
    - expect: status 200 with `status: "ready"`

#### 3.2. redirects-stream-and-download

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-28T21:30:00Z

**Steps:**
  1. GET /videos/:slug/stream of a `ready` video without token
    - expect: status 302 with a `Location` presigned URL on the public storage endpoint
  2. GET /videos/:slug/download of the same video
    - expect: status 302 with a `Location` containing `response-content-disposition=attachment`
  3. GET /videos/:slug/stream of the owner's `draft` video with the owner's token
    - expect: status 409 with `error: "VIDEO_NOT_READY"`

### 4. OpenAPI documentation

**Setup:** `beforeAll` builds the Swagger document from the app (`buildSwaggerDocument`).

#### 4.1. documents-video-endpoints

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-28T21:30:00Z

**Steps:**
  1. Build the OpenAPI document
    - expect: paths `/videos`, `/videos/{slug}`, `/videos/{slug}/upload`, `/videos/{slug}/upload/complete`, `/videos/{slug}/stream` and `/videos/{slug}/download` exist with tag `videos`
