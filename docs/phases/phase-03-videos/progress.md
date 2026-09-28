# phase-03-videos — Progress

**Status:** completed
**SIs:** 16/16 completed

### SI-03.1 — Infra: dependências, FFmpeg, MinIO/Redis no Compose e configuração
- **Status:** completed
- **Tests:** 10/10 passing (env.validation.integration-spec.ts — 4 existing + 3 new)
- **Observations:**
  - ioredis pinned to ^5.11.1 instead of the ^6.0.0 fetched in library-refs: typeorm@0.3.28 has an optional peer ioredis@^5, so npm refused v6; library-refs.md updated.
  - Upstream minio/minio images are no longer published on Docker Hub; Compose uses cgr.dev/chainguard/minio (MinIO RELEASE.2026-09-22) and cgr.dev/chainguard/minio-client. The images have no shell, so minio-init relies on MC_HOST_local + restart: on-failure.
  - Host port 3000 is busy on this machine; a git-excluded compose.override.yaml maps nestjs-api to 3010 locally (not part of the delivery).

### SI-03.2 — Storage: StorageModule e StorageService sobre S3/MinIO
- **Status:** completed
- **Tests:** 7/7 passing (storage.service.integration-spec.ts: 6, storage.module.spec.ts: 1)
- **Observations:**
  - Test helper src/test/storage-http.ts connects to S3_ENDPOINT while sending the signed public Host header, reproducing what a browser sends to S3_PUBLIC_ENDPOINT.
  - Download disposition uses RFC 6266 (ASCII filename fallback + filename*=UTF-8).

### SI-03.3 — Entidade Video, relação com Channel e migration
- **Status:** completed
- **Tests:** 8/8 passing (video.entity.integration-spec.ts: 6, migrations.integration-spec.ts: 2); 119/119 across auth/users/channels/videos/database suites
- **Observations:**
  - Adding Channel.videos (both relation sides, per entity rules) requires Video in every test DataSource entity array that loads Channel; 10 existing specs updated to include it.
  - Migration generated via CLI: 1790627695274-CreateVideos.ts.

### SI-03.4 — Pré-cadastro do vídeo e início do upload direto
- **Status:** completed
- **Tests:** 11/11 passing (video-slug.util.spec.ts: 2, videos.service.spec.ts: 6, videos.service.integration-spec.ts: 3)
- **Observations:**
  - Slug retry does not need a transaction/savepoint: the draft insert is a single statement outside a transaction, so a unique violation on slug is retried with a new slug (shared helper src/common/database/pg-errors.ts).
  - The multipart upload is created before the draft insert (the id is generated in-app); if the insert fails the multipart is aborted (compensation).
  - Added ChannelsService.findByUserId so VideosService resolves the owner channel through the channels module (SRP).
  - Test helper src/test/video-test-helpers.ts: explicit entity array + retryAttempts: 0 for Nest test modules (autoLoadEntities alone misses User via Channel relation and TypeORM retries silently until timeout).

### SI-03.5 — Fila de processamento, retomada e conclusão do upload
- **Status:** completed
- **Tests:** 19/19 passing in this SI (videos.service.spec.ts: +8 → 14, videos.service.integration-spec.ts: +4 → 7, queue.module.spec.ts: 1); src/videos + src/queue 30/30
- **Observations:**
  - @nestjs/bullmq pinned to ^11.0.5 instead of ^12.0.0: 12.x is ESM-only and the CommonJS Jest runtime cannot parse it; 11.0.5 supports bullmq ^6 and NestJS 11 with the same API (library-refs.md updated).
  - Integration tests register BullMQ with prefix 'bull-test' so the Compose video-worker (SI-03.10) never consumes their jobs.
  - Enqueue failure after the multipart is assembled reverts to draft with upload_id = null; a retried complete skips storage and only re-enqueues (TD-11 retry path). getUploadSession on such a draft returns VIDEO_NOT_UPLOADABLE (nothing left to upload).

### SI-03.6 — Acesso de reprodução: consulta por slug, stream, download e auth opcional
- **Status:** completed
- **Tests:** 20 new passing (videos.service.spec.ts: +15 → 29, jwt-auth.guard.spec.ts: +2 → 7); src/videos + guard 50/50
- **Observations:**
  - JwtAuthGuard now verifies an optional Bearer token on @Public() routes (attaches request.user when valid, ignores invalid tokens); protected routes are unchanged.

### SI-03.7 — Endpoints de vídeos (VideosController, DTOs e OpenAPI)
- **Status:** completed
- **Tests:** 11 new passing (test/videos.e2e-spec.ts: 10 scenarios from nestjs-project/specs/videos.plan.md, openapi-export.integration-spec.ts: +1 → 10); full E2E 62/62
- **Observations:**
  - @SkipThrottle() on VideosController: the ThrottlerGuard registered via APP_GUARD in AuthModule is global (10 req/min), but phase-02-auth/TD-08 scopes rate limiting to auth endpoints; uploads/playback/polling must not hit it.
  - test:e2e now passes --runInBand as nestjs-project/CLAUDE.md already documented; with two DB-cleaning E2E suites the parallel run caused cross-suite contamination.
  - openapi.json regenerated with the 6 video endpoints. Syncing next-frontend/openapi.json (scripts/sync-openapi.sh) is a frontend concern, out of scope for this backend phase.
  - Shared test/e2e-helpers.ts (createE2eApp mirroring main.ts + registerConfirmAndLogin).

### SI-03.8 — Ferramentas de mídia: ffprobe e ffmpeg
- **Status:** completed
- **Tests:** 6/6 passing (media-tools.service.spec.ts: 3, media-tools.service.integration-spec.ts: 3)
- **Observations:**
  - probe() throws InvalidMediaError only when ffprobe/ffmpeg stderr says the content itself is invalid (e.g. 'Invalid data found when processing input'); other failures (network, timeout) propagate as retryable errors.

### SI-03.9 — Processamento automático do vídeo (job process-video)
- **Status:** completed
- **Tests:** 14/14 passing (video-processing.service.spec.ts: 5, video-processing.service.integration-spec.ts: 3, video-processing.processor.spec.ts: 6)
- **Observations:**
  - markReady/markFailed use conditional UPDATE (status guard) so concurrent/duplicate deliveries cannot move a video backwards; markFailed also clears upload_id.
  - Processor concurrency: 2 jobs per worker process.

### SI-03.10 — Worker de vídeo: entrypoint, WorkerModule e serviço video-worker
- **Status:** completed
- **Tests:** 2/2 passing (worker.module.integration-spec.ts); E2E regression 62/62
- **Observations:**
  - Test named worker.module.integration-spec.ts (not .spec.ts as planned): compiling WorkerModule opens real DB/Redis connections, which the project's test-type rules classify as integration.
  - Extracted RootConfigModule (ConfigModule.forRoot + Joi) and DatabaseModule (TypeOrmModule.forRootAsync) so AppModule and WorkerModule share one configuration instead of duplicating it.
  - WorkerModule imports UsersModule so the User entity (Channel ↔ User relation) is registered under autoLoadEntities.
  - start:worker:dev uses node --watch + ts-node/register/transpile-only (nest start --watch would share and delete dist/ with the API's start:dev). Verified: docker compose stop video-worker completes in ~1s.

### SI-03.11 — Limpeza de uploads abandonados (job sweep-expired-uploads)
- **Status:** completed
- **Tests:** 7 new passing (upload-sweeper.service.integration-spec.ts: 4, video-processing.processor.spec.ts: +3 → 9); src/video-processing 28/28
- **Observations:**
  - UploadSweeperService registers the scheduler in onApplicationBootstrap (only the worker imports it); verified in Redis: bull:video-processing:repeat:sweep-expired-uploads every=3600000.
  - NoSuchUpload on abort is tolerated (MinIO may have already reclaimed stale parts); any other storage error propagates so the job retries.

### SI-03.12 — Fluxo completo upload → processamento → streaming (infra real)
- **Status:** completed
- **Tests:** 5/5 passing (test/video-pipeline.e2e-spec.ts against the Compose video-worker); full suites: unit+integration 229/229 (37 suites), E2E 67/67 (5 suites)
- **Observations:**
  - The pipeline spec lowers VIDEO_UPLOAD_PART_SIZE_BYTES to the 5 MiB S3 minimum through a side-effect module imported before AppModule (test/small-upload-parts.env.ts), so a ~10 MB sample is uploaded as a real multi-part upload.
  - Sample generator adds temporal noise when a bitrate is requested: x264 compresses the plain lavfi test pattern to ~0.6 MB regardless of -b:v.

### SI-03.13 — Documentação de IA e de testes atualizada
- **Status:** completed
- **Tests:** no tests (documentation) — every path cited in both CLAUDE.md files verified to exist
- **Observations:**
  - Testing guide: Object Storage → Real (Docker MinIO) and Message Queue → Real (Docker Redis + BullMQ), plus the two table rows that still mentioned a local storage adapter (validation.md IC-1).
  - Root CLAUDE.md: Message Queue = BullMQ on Redis, worker/storage roles; also corrected the stale 'next-frontend not yet initialized' line. software-arch.mermaid: queue no longer TBD; storage relations reflect presigned direct upload.
  - nestjs-controllers rule documents optional auth on @Public() routes introduced in SI-03.6.

### SI-03.14 (amendment of SI-03.2, SI-03.4, SI-03.5) — Integridade do upload: tamanho assinado por parte, lista completa e transições condicionais
- **Status:** completed
- **Tests:** storage.service.integration-spec.ts +1 (403 on oversized part), videos.service.spec.ts +7 (part sizes, incomplete/duplicate/out-of-plan lists, NoSuchUpload, conditional transition race), videos.e2e-spec.ts +2 (scenarios 2.4/2.5)
- **Observations:**
  - Appended by /plan-build append-mode on 2026-09-28; tracks Revisions of phase-03-videos/TD-02 and TD-11 (2026-09-28) from the post-implementation reanalysis.
  - Bypass verified empirically before the fix: an unbound part URL accepted 3000 bytes; with ContentLength signed, MinIO returns 403 for any other size.
  - Code was fixed during the reanalysis and then recorded here (the amendment documents already-shipped changes, per append-mode rules for completed SIs).

### SI-03.15 (amendment of SI-03.8, SI-03.9, SI-03.11) — Robustez do processamento e do sweeper
- **Status:** completed
- **Tests:** media-tools.service.integration-spec.ts +1 (cover art), video-processing.service.spec.ts +1 (decode failure), upload-sweeper.service.spec.ts 4 (new), upload-sweeper.service.integration-spec.ts +1 (assembled original deleted)
- **Observations:**
  - Appended by /plan-build append-mode on 2026-09-28; tracks Revisions of phase-03-videos/TD-06 and TD-12 (2026-09-28).
  - Verified against real BullMQ that the `failed` event reports attemptsMade 1..attempts and UnrecoverableError fails at attempt 1 — the processor's final-failure rule needed no change.

### SI-03.16 (amendment of SI-03.1) — Subida a frio do Compose e `.env.example` válido
- **Status:** completed
- **Tests:** no tests — verified by `docker compose down` + empty MinIO volume + `docker compose up -d` (minio-init waited, created the bucket, exited 0 before nestjs-api/video-worker started) and `docker compose config` with `.env.example`
- **Observations:**
  - Appended by /plan-build append-mode on 2026-09-28; tracks the Revision of phase-03-videos/TD-04.
  - The `db` service has no volume: recreating the stack empties PostgreSQL (pre-existing); run `npm run migration:run` after `docker compose down`.

## Final verification — 2026-09-28

- Stack: `docker compose up -d` → `db`, `mailpit`, `minio`, `redis`, `video-worker`, `nestjs-api` running; `minio-init` exited 0.
- `npm test -- --runInBand`: 37 suites, 229/229 passing.
- `npm run test:e2e`: 5 suites, 67/67 passing (includes the full pipeline against the `video-worker` container).
- `npx tsc --noEmit`: exit 0. `npm run lint`: exit 0. `npm run build`: emits `dist/main.js` and `dist/worker.js`; `node dist/worker` starts consuming `video-processing`.

## Final verification (after amendments SI-03.14..16) — 2026-09-28

- Cold start from an empty MinIO volume: `minio-init` waited, created the bucket, exited 0; all services up.
- `npm test -- --runInBand`: 38 suites, 243/243 passing. `npm run test:e2e`: 5 suites, 69/69 passing.
- `npx tsc --noEmit`: exit 0. `npm run lint`: exit 0. `openapi.json` regenerated (`UploadPartUrlDto.size`).

