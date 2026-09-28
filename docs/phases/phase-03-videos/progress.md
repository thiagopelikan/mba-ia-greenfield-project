# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/13 completed

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
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.5 — Fila de processamento, retomada e conclusão do upload
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.6 — Acesso de reprodução: consulta por slug, stream, download e auth opcional
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.7 — Endpoints de vídeos (VideosController, DTOs e OpenAPI)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.8 — Ferramentas de mídia: ffprobe e ffmpeg
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.9 — Processamento automático do vídeo (job process-video)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.10 — Worker de vídeo: entrypoint, WorkerModule e serviço video-worker
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.11 — Limpeza de uploads abandonados (job sweep-expired-uploads)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.12 — Fluxo completo upload → processamento → streaming (infra real)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.13 — Documentação de IA e de testes atualizada
- **Status:** pending
- **Tests:** pending
- **Observations:** none
