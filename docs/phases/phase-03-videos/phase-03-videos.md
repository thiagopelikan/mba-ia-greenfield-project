---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-28T18:22:45-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-28T18:22:45-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T18:19:01-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-28T15:46:56-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-09-28T15:46:56-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-09-28T15:46:56-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-09-28T15:46:56-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB direto para o object storage (MinIO/S3) com pré-cadastro do vídeo como rascunho, processamento automático em segundo plano por um worker FFmpeg consumindo uma fila BullMQ/Redis (duração, metadados e thumbnail), URL única por vídeo, reprodução via streaming com range requests e download do arquivo original — com storage, fila e worker subindo no Docker Compose.

---

## Step Implementations

### SI-03.1 — Infra: dependências, FFmpeg, MinIO/Redis no Compose e configuração

**Description:** Prepara a infraestrutura da fase — libs novas, imagem com FFmpeg, serviços de object storage e fila no Compose e as chaves de configuração — antes de qualquer comportamento.

**Technical actions:**

1. Instalar `bullmq`, `@nestjs/bullmq`, `ioredis`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` nas versões de `library-refs.md` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`) e adicionar `ffmpeg` (pacote Debian) ao `Dockerfile.dev` (per `phase-03-videos/TD-06`).
2. Adicionar ao `compose.yaml` os serviços `minio` (`cgr.dev/chainguard/minio`, `server /data --console-address :9001`, portas 9000/9001, volume nomeado), `minio-init` (`cgr.dev/chainguard/minio-client`, `MC_HOST_local` + `mb --ignore-existing local/${S3_BUCKET}`, `restart: on-failure`) e `redis` (`redis:8-alpine`, `--appendonly yes --maxmemory-policy noeviction`, healthcheck `redis-cli ping`); `nestjs-api` passa a depender de `redis` (healthy) e `minio` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`).
3. Criar `src/config/storage.config.ts`, `src/config/queue.config.ts` e `src/config/video.config.ts` (`registerAs`) com as chaves de `### Configuration (env)`, registrá-los no `ConfigModule.forRoot` do `AppModule`, estender `src/config/env.validation.ts` (Joi, defaults da tabela; `VIDEO_UPLOAD_PART_SIZE_BYTES` mínimo 5242880) e atualizar `.env.example`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: defaults das novas chaves e rejeição de `VIDEO_UPLOAD_PART_SIZE_BYTES` < 5 MiB | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `minio`, `redis` e `minio-init`; `redis` fica `healthy` e o bucket `streamtube-videos` existe no MinIO.
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` executam com sucesso.
- O schema de env aceita um `.env` sem as chaves novas aplicando os defaults da tabela e rejeita `VIDEO_UPLOAD_PART_SIZE_BYTES=1024`.

---

### SI-03.2 — Storage: StorageModule e StorageService sobre S3/MinIO

**Description:** Encapsula todo acesso ao object storage num serviço de infraestrutura reutilizado pela API e pelo worker, incluindo URLs pré-assinadas para o host público.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` com dois `S3Client` (endpoint interno `S3_ENDPOINT` para operações e endpoint `S3_PUBLIC_ENDPOINT` para assinar URLs de clientes), `forcePathStyle: true`, `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-03`, `library-refs.md → @aws-sdk/client-s3`).
2. Implementar multipart: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber, ttl)` (cliente público), `listParts(key, uploadId)` (paginado), `completeMultipartUpload(key, uploadId, parts)` e `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-02`).
3. Implementar objetos: `putObject(key, body, contentType)`, `presignGetObject(key, { ttl, audience: 'public' | 'internal', downloadFileName? })` com `ResponseContentDisposition` para download (per `phase-03-videos/TD-04`, `phase-03-videos/TD-09`), traduzindo erros de multipart do S3 em `StorageMultipartException` com o código S3 original.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): multipart via URL pré-assinada (PUT de 2 partes ≥ 5 MiB com header `Host` público), `listParts`, complete, abort; GET pré-assinado com `Range` → 206; disposition de download | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo com config | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — libs, MinIO e `storage.config` precisam existir.

**Acceptance criteria:**

- Um arquivo enviado em 2 partes via URLs pré-assinadas e completado com os ETags retornados fica disponível no bucket com o tamanho exato do original.
- `listParts` após enviar só a parte 1 retorna exatamente a parte 1 com seu ETag.
- GET na URL pré-assinada do objeto com `Range: bytes=0-1023` retorna `206` com `Content-Range: bytes 0-1023/{size}`.
- A URL de download contém `response-content-disposition=attachment` e o GET responde com `Content-Disposition: attachment; filename="{nome}"`.
- Completar com um ETag inválido lança `StorageMultipartException` com código `InvalidPart`.

---

### SI-03.3 — Entidade Video, relação com Channel e migration

**Description:** Cria a tabela `videos` ligada ao canal com o ciclo de status, slug único e campos de storage/metadados definidos no Data Model.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` (`@Entity('videos')`) com os campos, enum `VideoStatus`, transformer `bigint → number` em `size_bytes`, `jsonb` `metadata` tipado como `VideoMetadata` e índices do `### Data Model → Video` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`).
2. Adicionar `@OneToMany(() => Video, (video) => video.channel) videos` em `Channel` (relação nos dois lados) e registrar `TypeOrmModule.forFeature([Video])` num `VideosModule` inicial importado pelo `AppModule`.
3. Gerar a migration `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` (tabela, enum `videos_status_enum`, FK `ON DELETE CASCADE`, índices) e rodá-la.
4. Atualizar `src/database/migrations.integration-spec.ts` e `cleanAllTables` (`src/test/create-test-data-source.ts`) para incluir `videos`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `draft`, unique `slug`, FK para `channels` com cascade, `size_bytes` > 2^31 retornado como number, `metadata` jsonb round-trip | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplica as 3 migrations e cria `videos`; revert remove `videos` | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 — migration roda no ambiente com a nova config carregada.

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com o enum `videos_status_enum` e FK para `channels`.
- Inserir um vídeo sem status persiste `status = 'draft'`.
- Inserir dois vídeos com o mesmo `slug` viola a constraint unique.
- Excluir o canal remove seus vídeos.
- Um vídeo com `size_bytes = 10737418240` é lido de volta como o número `10737418240`.

---

### SI-03.4 — Pré-cadastro do vídeo e início do upload direto

**Description:** Implementa a regra de negócio de `POST /videos`: pré-cadastro como `draft` com slug único e abertura do multipart com URLs pré-assinadas por parte.

**Technical actions:**

1. Criar `src/videos/video-slug.util.ts` — `generateVideoSlug()` = 8 bytes de `crypto.randomBytes` em base64url (11 chars) (per `phase-03-videos/TD-08`).
2. Adicionar a `src/common/exceptions/domain.exception.ts` as exceções `VideoFileTooLargeException`, `VideoNotFoundException`, `VideoNotUploadableException`, `InvalidUploadPartsException`, `VideoProcessingUnavailableException` e `VideoNotReadyException` com os códigos/HTTP do `### Error Catalog`.
3. Criar `src/videos/videos.service.ts` com `initiateUpload(userId, input)`: valida `file_size` ≤ `VIDEO_MAX_UPLOAD_BYTES`, resolve o canal do usuário, gera `id` + `storage_key`, insere o `draft` com retry de slug em violação unique `23505` (savepoint, per `typeorm-queries` rule), chama `createMultipartUpload`, grava `upload_id` e devolve `part_size`, `part_count`, URLs de todas as partes e `expires_at` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`).
4. Criar `src/videos/videos.mapper.ts` (`toVideoResponse(video, thumbnailUrl)`) com o shape `VideoResponse`, e registrar `VideosService` + `StorageModule` + `ChannelsModule` no `VideosModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoSlug` | Unit: 11 chars, alfabeto base64url, valores distintos | `src/videos/video-slug.util.spec.ts` |
| `VideosService.initiateUpload` | Unit: limite de tamanho, cálculo de `part_count`, título default, retry de slug (mocks) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (DB + MinIO reais): cria `draft` com `upload_id`, URLs utilizáveis para PUT | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — usa `StorageService`; SI-03.3 — persiste `Video`.

**Acceptance criteria:**

- Iniciar upload de 150 MiB com parte de 64 MiB cria um vídeo `draft` do canal do usuário e retorna `part_count = 3` com 3 URLs.
- Iniciar upload com `file_size = 10737418240` é aceito com `part_count = 160`; `10737418241` lança `VIDEO_FILE_TOO_LARGE` sem gravar vídeo.
- Sem `title`, o vídeo recebe o nome do arquivo sem extensão.
- Uma colisão de slug no insert é resolvida com novo slug sem falhar a requisição.
- O vídeo criado tem `storage_key = videos/{id}/original` e `upload_id` não nulo.

---

### SI-03.5 — Fila de processamento, retomada e conclusão do upload

**Description:** Conecta a API à fila BullMQ e implementa a retomada (partes já enviadas + novas URLs) e a conclusão do upload que dispara o processamento.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` lendo `queue.config` e `defaultJobOptions` do `### Events/Messages`; criar `src/videos/videos.constants.ts` (`VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_JOBS = { PROCESS: 'process-video', SWEEP: 'sweep-expired-uploads' }`) e registrar a fila no `VideosModule` exportando `BullModule` (per `phase-03-videos/TD-01`, `library-refs.md → @nestjs/bullmq`).
2. Implementar `VideosService.getUploadSession(userId, slug)`: exige dono e `draft`, usa `listParts` e re-assina só as partes faltantes (validation.md AMB-1).
3. Implementar `VideosService.completeUpload(userId, slug, parts)`: exige dono e `draft`; `completeMultipartUpload` (erros de storage → `INVALID_UPLOAD_PARTS`); grava `status = processing`, `upload_id = null`; publica `process-video` com `jobId = videoId`; se a publicação falhar, reverte para `draft` e lança `VIDEO_PROCESSING_UNAVAILABLE` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getUploadSession` / `completeUpload` | Unit: dono/não-dono, status inválido, falha do storage, falha da fila com revert (mocks) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (DB + MinIO + Redis reais): objeto completo no bucket, status `processing`, job `process-video` com id = videoId na fila | `src/videos/videos.service.integration-spec.ts` |
| `QueueModule` | Unit: compilação com `BullModule.forRootAsync` | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.4 — opera sobre vídeos pré-cadastrados.

**Acceptance criteria:**

- Após enviar só a parte 1 de 2, a sessão de upload lista a parte 1 em `uploaded_parts` e devolve URL apenas para a parte 2.
- Concluir com as partes corretas deixa o vídeo em `processing`, `upload_id` nulo, e existe um job `process-video` com id igual ao `id` do vídeo e payload `{ videoId }`.
- Concluir com ETag inválido lança `INVALID_UPLOAD_PARTS` e o vídeo permanece `draft`.
- Retomar ou concluir um vídeo que não está em `draft` lança `VIDEO_NOT_UPLOADABLE`; vídeo de outro canal lança `VIDEO_NOT_FOUND`.
- Se a publicação do job falhar, o vídeo volta a `draft` e é lançado `VIDEO_PROCESSING_UNAVAILABLE`.

---

### SI-03.6 — Acesso de reprodução: consulta por slug, stream, download e auth opcional

**Description:** Implementa a política de acesso da fase (público por link para `ready`, dono para os demais) e a geração das URLs de streaming/download/thumbnail.

**Technical actions:**

1. Implementar `VideosService.findForViewer(slug, viewerUserId?)`: retorna o vídeo se `ready` ou se o viewer é dono; senão `VIDEO_NOT_FOUND` (per `phase-03-videos/TD-10`); a resposta inclui `thumbnail_url` pré-assinada quando houver thumbnail (per `phase-03-videos/TD-04`).
2. Implementar `VideosService.getPlaybackUrl(slug, viewerUserId?, mode: 'stream' | 'download')`: aplica a mesma visibilidade, exige `ready` (dono de vídeo não-`ready` → `VIDEO_NOT_READY`) e devolve `presignGetObject` público com TTL `VIDEO_PLAYBACK_URL_TTL_SECONDS`, com disposition `attachment` e `original_file_name` no modo download (per `phase-03-videos/TD-09`, validation.md AMB-3).
3. Estender `src/auth/guards/jwt-auth.guard.ts`: em rota `@Public()`, se houver `Bearer` válido, anexar o payload em `request.user`; token inválido é ignorado (auth opcional, `### Authorization Matrix`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findForViewer` / `getPlaybackUrl` | Unit: matriz status × (anônimo, não dono, dono), modo download (mocks) | `src/videos/videos.service.spec.ts` |
| `JwtAuthGuard` | Unit: rota pública com token válido anexa `request.user`; com token inválido segue pública sem usuário | `src/auth/guards/jwt-auth.guard.spec.ts` |

**Dependencies:** SI-03.5 — reutiliza o `VideosService` e a resolução de dono.

**Acceptance criteria:**

- Vídeo `ready` é retornado para viewer anônimo; vídeo `processing` lança `VIDEO_NOT_FOUND` para anônimo e para outro usuário, e é retornado para o dono.
- A URL de stream de um vídeo `ready` aponta para `S3_PUBLIC_ENDPOINT` e expira em `VIDEO_PLAYBACK_URL_TTL_SECONDS`.
- A URL de download carrega `attachment; filename="{original_file_name}"`.
- Dono pedindo stream de vídeo `draft` recebe `VIDEO_NOT_READY`.
- Rotas protegidas continuam retornando 401 sem token (comportamento do guard inalterado fora de `@Public()`).

---

### SI-03.7 — Endpoints de vídeos (VideosController, DTOs e OpenAPI)

**Route:** POST /videos · GET /videos/:slug/upload · POST /videos/:slug/upload/complete · GET /videos/:slug · GET /videos/:slug/stream · GET /videos/:slug/download
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** per `### Authorization Matrix`

**Description:** Expõe os contratos HTTP da fase delegando ao `VideosService`, com validação de DTOs e documentação Swagger no padrão do projeto.

**Technical actions:**

1. Criar DTOs de request em `src/videos/dto/` (`create-video-upload.dto.ts`, `complete-video-upload.dto.ts` com `parts` aninhado via `@ValidateNested` + `@Type`) seguindo `#### Validation Rules — videos`, e DTOs de resposta com `@ApiProperty` (`video-response.dto.ts`, `video-upload-session.dto.ts`) (per `openapi-docs-nestjs/TD-01`).
2. Criar `src/videos/videos.controller.ts` (`@ApiTags('videos')`, `@Controller('videos')`) com os 6 endpoints do `### API Contracts`: `POST /videos` 201, `GET :slug/upload` 200, `POST :slug/upload/complete` 202, e `@Public()` `GET :slug`, `GET :slug/stream` e `GET :slug/download` respondendo `302` com `Location` (`res.redirect`); `@ApiBearerAuth('access-token')` só nas rotas protegidas e `@ApiResponse` por status com `ApiErrorEnvelope`.
3. Registrar o controller no `VideosModule` e regenerar `openapi.json` (`npm run openapi:export`) (per `openapi-docs-nestjs/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` export | Integration: paths `/videos*` presentes no documento exportado | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.6 — todas as operações do service existem.

**Acceptance criteria:**

- `POST /videos` sem token retorna `401`; com token e body válido retorna `201` com `video.status = "draft"` e `upload.parts` com `part_count` itens.
- `POST /videos` com `mime_type: "image/png"` retorna `400`; com `file_size` acima de 10 GiB retorna `400` com `error: "VIDEO_FILE_TOO_LARGE"`.
- `POST /videos/:slug/upload/complete` pelo dono retorna `202` com `status: "processing"`; por outro usuário retorna `404` `VIDEO_NOT_FOUND`.
- `GET /videos/:slug` de vídeo `processing` retorna `404` para anônimo e `200` para o dono.
- `GET /videos/:slug/stream` e `/download` de vídeo `ready` retornam `302` com `Location` pré-assinada; para o dono de vídeo `draft` retornam `409` `VIDEO_NOT_READY`.
- `GET /api/docs-json` / `openapi.json` documenta os 6 endpoints com a tag `videos`.

---

### SI-03.8 — Ferramentas de mídia: ffprobe e ffmpeg

**Description:** Isola a invocação dos binários FFmpeg num serviço testável que lê o vídeo por URL HTTP (range requests) sem baixar o arquivo inteiro.

**Technical actions:**

1. Criar `src/video-processing/media-tools.service.ts` com `probe(url)`: `execFile('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', url])` com timeout, parse tipado e mapeamento para `{ durationSeconds, metadata: VideoMetadata, hasVideoStream }` (per `phase-03-videos/TD-06`).
2. Implementar `extractFrame(url, atSeconds, outputPath)`: `execFile('ffmpeg', ['-ss', t, '-i', url, '-frames:v','1','-vf','scale=1280:-2','-q:v','3','-y', outputPath])` com timeout; e `thumbnailTimestamp(duration)` = 10% da duração limitado a `[0, duration - 0.1]` (per `phase-03-videos/TD-06`).
3. Criar `src/test/sample-video.ts` — helper de teste que gera um MP4 curto com `ffmpeg -f lavfi` (vídeo + áudio) em diretório temporário.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaToolsService` | Integration (FFmpeg + MinIO reais): probe de MP4 servido por URL pré-assinada interna, frame JPEG gerado, arquivo não-vídeo sem stream de vídeo | `src/video-processing/media-tools.service.integration-spec.ts` |
| `thumbnailTimestamp` | Unit: 10% da duração, limites para duração 0 e curta | `src/video-processing/media-tools.service.spec.ts` |

**Dependencies:** SI-03.2 — URLs pré-assinadas internas do `StorageService`.

**Acceptance criteria:**

- O probe de um MP4 de 3 s 320x240 com áudio retorna duração ≈ 3 s, `width = 320`, `height = 240`, `video_codec = "h264"` e `audio_codec` preenchido.
- O frame extraído é um JPEG válido com largura 1280.
- O probe de um arquivo de texto enviado ao bucket indica ausência de stream de vídeo (ou falha de parse) sem travar o processo.

---

### SI-03.9 — Processamento automático do vídeo (job process-video)

**Description:** Implementa o consumo do job `process-video`: extração de duração/metadados, geração e upload da thumbnail e transições `processing → ready | failed`.

**Technical actions:**

1. Adicionar ao `VideosService` as transições usadas pelo worker: `findById`, `markReady(id, { durationSeconds, metadata, thumbnailKey })` e `markFailed(id, reason)` (per `phase-03-videos/TD-07`).
2. Criar `src/video-processing/video-processing.service.ts` com `process(videoId)`: ignora vídeo que não está em `processing` (idempotência, per `phase-03-videos/TD-11`); gera URL interna pré-assinada; `probe` — sem stream de vídeo lança `UnrecoverableError('INVALID_MEDIA')`; extrai o frame em diretório temporário, faz `putObject` em `videos/{id}/thumbnail.jpg` (`image/jpeg`), chama `markReady` e remove o temporário (per `phase-03-videos/TD-06`).
3. Criar `src/video-processing/video-processing.processor.ts` (`@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`) que despacha por `job.name`; `@OnWorkerEvent('failed')` marca `failed` com `INVALID_MEDIA` para `UnrecoverableError` ou `PROCESSING_ERROR` quando `attemptsMade >= attempts` (per `phase-03-videos/TD-07`, `library-refs.md → bullmq`); e `src/video-processing/video-processing.module.ts` (importa `VideosModule`, `StorageModule`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: vídeo fora de `processing` ignorado, mídia inválida → `UnrecoverableError`, temporário removido em erro (mocks) | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration (DB + MinIO + FFmpeg reais): vídeo real vira `ready` com duração, metadata e thumbnail no bucket | `src/video-processing/video-processing.service.integration-spec.ts` |
| `VideoProcessingProcessor` | Unit: despacho por nome de job e mapeamento do evento `failed` (final vs não final, unrecoverable) | `src/video-processing/video-processing.processor.spec.ts` |

**Dependencies:** SI-03.5 — jobs e vídeos em `processing`; SI-03.8 — `MediaToolsService`.

**Acceptance criteria:**

- Processar um vídeo `processing` com MP4 válido grava `status = ready`, `duration_seconds` ≈ duração real, `metadata.width/height` corretos e `thumbnail_key = videos/{id}/thumbnail.jpg` existente no bucket.
- Processar um vídeo cujo arquivo não é vídeo termina em `failed` com `failure_reason = INVALID_MEDIA` sem novas tentativas.
- Uma falha transitória na última tentativa marca `failed` com `PROCESSING_ERROR`; falhas em tentativas anteriores não alteram o status.
- Processar novamente um vídeo já `ready` não altera o registro.

---

### SI-03.10 — Worker de vídeo: entrypoint, WorkerModule e serviço video-worker

**Description:** Materializa o container "Video Worker" da arquitetura: processo separado, sem HTTP, que consome a fila a partir do mesmo código.

**Technical actions:**

1. Criar `src/worker.module.ts` (ConfigModule global com env validation, `TypeOrmModule.forRootAsync` igual ao `AppModule`, `QueueModule`, `VideoProcessingModule`) e `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()` (per `phase-03-videos/TD-05`).
2. Adicionar scripts `start:worker` (`node dist/worker`) e `start:worker:dev` (watch com ts-node) ao `package.json`.
3. Adicionar o serviço `video-worker` ao `compose.yaml` (mesma imagem/volume do `nestjs-api`; aguarda `node_modules` e roda `npm run start:worker:dev`; `depends_on` db healthy, redis healthy, minio started; `restart: unless-stopped`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilação do contexto e presença do `VideoProcessingProcessor`, sem controllers HTTP | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.9 — o processor precisa existir.

**Acceptance criteria:**

- `docker compose up -d` sobe `video-worker` e seus logs mostram o contexto Nest inicializado e o worker da fila `video-processing` ativo.
- O `AppModule` (API) não registra o `VideoProcessingProcessor` — jobs só são consumidos pelo `video-worker`.
- Parar o container encerra o worker graciosamente (shutdown hooks).

---

### SI-03.11 — Limpeza de uploads abandonados (job sweep-expired-uploads)

**Description:** Evita crescimento invisível do storage expirando rascunhos cujo upload não foi concluído na janela configurada.

**Technical actions:**

1. Adicionar `VideosService.findExpiredDrafts(olderThan: Date)` e usar `markFailed(id, 'UPLOAD_EXPIRED')` (per `phase-03-videos/TD-12`).
2. Criar `src/video-processing/upload-sweeper.service.ts` com `sweep()`: para cada rascunho mais antigo que `VIDEO_UPLOAD_WINDOW_HOURS`, `abortMultipartUpload` (ignora `NoSuchUpload`) e marca `failed`/`UPLOAD_EXPIRED`; retorna a quantidade expirada.
3. No `VideoProcessingModule`, registrar o job scheduler `sweep-expired-uploads` (`upsertJobScheduler`, `every: 3600000`) no bootstrap do worker e despachar `VIDEO_JOBS.SWEEP` no processor (per `library-refs.md → bullmq`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadSweeperService` | Integration (DB + MinIO reais): rascunho antigo com multipart aberto vira `failed`/`UPLOAD_EXPIRED` e o upload é abortado; rascunho recente e vídeos não-`draft` intactos | `src/video-processing/upload-sweeper.service.integration-spec.ts` |

**Dependencies:** SI-03.10 — o scheduler é registrado no bootstrap do worker.

**Acceptance criteria:**

- Um rascunho criado há 25 h com multipart aberto termina `failed` com `failure_reason = UPLOAD_EXPIRED`, e o `upload_id` deixa de existir no storage.
- Um rascunho criado há 1 h e um vídeo `ready` antigo não são alterados.
- Após o worker iniciar, a fila `video-processing` possui o job scheduler `sweep-expired-uploads` com intervalo de 1 h.

---

### SI-03.12 — Fluxo completo upload → processamento → streaming (infra real)

**Description:** Prova os entregáveis da fase ponta a ponta contra a stack do Compose (API, MinIO, Redis e o container `video-worker`), sem mocks.

**Technical actions:**

1. Criar `test/video-pipeline.e2e-spec.ts`: registra/confirma/loga um usuário, gera um MP4 com `src/test/sample-video.ts`, chama `POST /videos`, envia as partes às URLs pré-assinadas (mesmo `Host` público assinado), conclui o upload e faz polling de `GET /videos/:slug` até `ready` (timeout limitado).
2. No mesmo spec, validar streaming (`/stream` → 302 → GET com `Range` → 206), download (`/download` → 302 → `Content-Disposition: attachment`), `thumbnail_url` acessível e um upload de arquivo não-vídeo terminando `failed`/`INVALID_MEDIA`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline de vídeo | E2E (supertest + MinIO + Redis + `video-worker` reais) | `test/video-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.7 — endpoints; SI-03.10 — worker rodando no Compose.

**Acceptance criteria:**

- Um MP4 enviado via URLs pré-assinadas e concluído chega a `ready` sem intervenção, com `duration_seconds`, `metadata` e `thumbnail_url` preenchidos.
- Dois vídeos criados em sequência recebem slugs distintos de 11 caracteres.
- O `Location` de `/stream` responde `206 Partial Content` a uma requisição com `Range: bytes=0-99`.
- O `Location` de `/download` responde `200` com `Content-Disposition: attachment; filename="{original_file_name}"`.
- Um arquivo de texto enviado como `video/mp4` termina `failed` com `failure_reason: "INVALID_MEDIA"`.

---

### SI-03.13 — Documentação de IA e de testes atualizada

**Description:** Mantém a fundação de IA coerente com o código entregue — seção de vídeos no CLAUDE.md e estratégia de storage real no guia de testes (validation.md IC-1).

**Technical actions:**

1. Atualizar `.claude/skills/testing-guide-nestjs-project/references/external-systems.md`: "Object Storage — Real (Docker MinIO)" e "Message Queue — Real (Docker Redis/BullMQ)" com os padrões usados nos specs desta fase (validation.md IC-1).
2. Atualizar `nestjs-project/CLAUDE.md` (serviços `minio`, `minio-init`, `redis`, `video-worker`, verificações de prontidão, comandos do worker, seção de vídeos com endpoints/fila/storage) e o `CLAUDE.md` raiz (Message Queue = BullMQ/Redis; módulo de vídeos entregue), e marcar a fila como BullMQ/Redis em `docs/diagrams/software-arch.mermaid`.

**Tests:** _(empty — documentação; verificada contra o código na revisão final)_

**Dependencies:** SI-03.12 — documenta o estado final do código.

**Acceptance criteria:**

- Todo arquivo, comando, serviço e endpoint citado nos CLAUDE.md existe no repositório e funciona como descrito.
- O guia de testes não prescreve mais adapter de filesystem para object storage.
- O diagrama de arquitetura não contém mais "TBD" para a fila.

---

### SI-03.14 (amendment of SI-03.2, SI-03.4, SI-03.5) — Integridade do upload: tamanho assinado por parte, lista completa e transições condicionais

**Description:** Fecha o bypass do limite de 10 GiB e as corridas da conclusão encontradas na reanálise (Revisions de `phase-03-videos/TD-02` e `phase-03-videos/TD-11`, 2026-09-28).

**Technical actions:**

1. `StorageService.presignUploadPart(key, uploadId, partNumber, contentLength, ttl)` assina `ContentLength` (header `content-length` entra em `X-Amz-SignedHeaders`); `VideosService` calcula o tamanho exato de cada parte (a última recebe o resto) e o expõe em `parts[].size` (per `phase-03-videos/TD-02`).
2. `completeUpload` exige a lista completa de partes planejadas (sem faltas, duplicatas ou números fora do plano) → senão `INVALID_UPLOAD_PARTS`; `NoSuchUpload` do storage vira `VIDEO_NOT_UPLOADABLE`; `getUploadSession` idem quando o storage já descartou o upload.
3. Transição `draft → processing` via UPDATE condicional (`WHERE status = 'draft'`; 0 linhas → `VIDEO_NOT_UPLOADABLE`); antes do `add`, remove job finalizado com o mesmo id; revert condicional `processing → draft` se a publicação falhar (per `phase-03-videos/TD-11`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService.presignUploadPart` | Integration (MinIO): corpo maior que o `Content-Length` assinado → 403 | `src/storage/storage.service.integration-spec.ts` |
| `VideosService` | Unit: tamanhos por parte, lista incompleta/duplicada/fora do plano, `NoSuchUpload`, corrida no UPDATE condicional, remoção do job antes do `add` | `src/videos/videos.service.spec.ts` |
| Endpoints de vídeo | E2E: URL de parte rejeita corpo maior; conclusão sem todas as partes → 400 (cenários 2.4 e 2.5 de `nestjs-project/specs/videos.plan.md`) | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.12 — corrige comportamento já entregue e coberto pelo pipeline E2E.

**Acceptance criteria:**

- `POST /videos` retorna cada parte com `size`; a soma dos `size` é igual a `file_size`.
- `PUT` numa URL de parte com corpo de tamanho diferente de `size` é rejeitado pelo storage com `403`.
- `POST /videos/:slug/upload/complete` sem todas as partes planejadas retorna `400` com `error: "INVALID_UPLOAD_PARTS"`.
- `GET /videos/:slug/upload` de um rascunho cujo upload não existe mais no storage retorna `409` `VIDEO_NOT_UPLOADABLE`.
- Um vídeo que mudou de status durante a conclusão não é enfileirado e a requisição retorna `409` `VIDEO_NOT_UPLOADABLE`.

---

### SI-03.15 (amendment of SI-03.8, SI-03.9, SI-03.11) — Robustez do processamento e do sweeper

**Description:** Corrige classificação de mídia e corridas/isolamento do sweeper apontados na reanálise (Revisions de `phase-03-videos/TD-06` e `phase-03-videos/TD-12`, 2026-09-28).

**Technical actions:**

1. `MediaToolsService`: stream com `disposition.attached_pic` (capa de áudio) não conta como vídeo; `VideoProcessingService` classifica falha de decodificação no `extractFrame` como `INVALID_MEDIA` (UnrecoverableError), além do `probe` (per `phase-03-videos/TD-06`).
2. `VideosService.expireDraft(id)` (UPDATE condicional `WHERE status = 'draft'`) substitui o uso de `markFailed` pelo sweeper; `markFailed` passa a valer só para `processing`.
3. `UploadSweeperService.sweep()`: aborta o multipart antes de expirar; rascunho sem `upload_id` (objeto montado, enfileiramento falhou) tem o original apagado (`StorageService.deleteObject`); falha de um rascunho não interrompe os demais e o job falha no fim para ser re-tentado (per `phase-03-videos/TD-12`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaToolsService` | Integration (FFmpeg): `.m4a` com capa não tem stream de vídeo | `src/video-processing/media-tools.service.integration-spec.ts` |
| `VideoProcessingService` | Unit: falha de decodificação no frame → `UnrecoverableError` | `src/video-processing/video-processing.service.spec.ts` |
| `UploadSweeperService` | Unit: abort antes de expirar, conclusão vencedora preservada, original apagado, isolamento de falhas | `src/video-processing/upload-sweeper.service.spec.ts` |
| `UploadSweeperService` | Integration (DB + MinIO): original montado de rascunho expirado é removido do bucket | `src/video-processing/upload-sweeper.service.integration-spec.ts` |

**Dependencies:** SI-03.14 — mesma rodada de correções; independe funcionalmente.

**Acceptance criteria:**

- Um áudio com capa enviado como `video/mp4` termina `failed` com `failure_reason = INVALID_MEDIA`.
- Um rascunho concluído enquanto o sweeper roda permanece em `processing` (não vira `UPLOAD_EXPIRED`).
- Rascunho expirado cujo objeto já estava montado não deixa `videos/{id}/original` no bucket.
- Erro de storage em um rascunho não impede a expiração dos demais na mesma varredura.

---

### SI-03.16 (amendment of SI-03.1) — Subida a frio do Compose e `.env.example` válido

**Description:** Garante que `cp .env.example .env && docker compose up -d` funcione numa máquina limpa (Revision de `phase-03-videos/TD-04`, 2026-09-28).

**Technical actions:**

1. `minio-init` usa `cgr.dev/chainguard/minio-client:latest-dev` (com shell): `until mc ready local; do sleep 1; done; mc mb --ignore-existing ...`; `nestjs-api` passa a depender de `minio-init` concluído com sucesso (per `phase-03-videos/TD-04`).
2. `.env.example`: `MAIL_FROM` entre aspas simples — o valor com `<...>` quebrava o parser do Compose (pré-existente, exposto porque o Compose agora interpola variáveis do `.env`).

**Tests:** _(empty — Infra; verificado por subida a frio com volume do MinIO vazio e `docker compose config` com o `.env.example`)_

**Dependencies:** none

**Acceptance criteria:**

- Com volume do MinIO vazio, `docker compose up -d` termina com `minio-init` `Exited (0)` e `nestjs-api`/`video-worker` iniciados só depois do bucket existir.
- `docker compose config` com um `.env` copiado de `.env.example` não gera erro de parse.

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`, `phase-03-videos/TD-04`). O `id` é gerado pela aplicação (`randomUUID()`) antes do insert porque compõe as chaves de storage.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK (gerado pela aplicação) |
| channel_id | uuid | not null, FK → `channels.id` ON DELETE CASCADE |
| slug | varchar(11) | unique, not null — 11 chars base64url (`[A-Za-z0-9_-]`), per `phase-03-videos/TD-08` |
| title | varchar(100) | not null — default: nome do arquivo sem extensão, truncado em 100 |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` — per `phase-03-videos/TD-07` |
| original_file_name | varchar(255) | not null |
| mime_type | varchar(100) | not null — começa com `video/` (validation.md AMB-2) |
| size_bytes | bigint | not null — ≤ 10 GiB; mapeado para `number` via transformer |
| storage_key | varchar(255) | not null — `videos/{id}/original` (per `phase-03-videos/TD-04`) |
| upload_id | varchar(255) | nullable — UploadId do multipart; `null` após complete/abort |
| thumbnail_key | varchar(255) | nullable — `videos/{id}/thumbnail.jpg`, preenchido quando `ready` |
| duration_seconds | double precision | nullable — preenchido quando `ready` |
| metadata | jsonb | nullable — `VideoMetadata` (abaixo), preenchido quando `ready` |
| failure_reason | varchar(64) | nullable — `INVALID_MEDIA` \| `PROCESSING_ERROR` \| `UPLOAD_EXPIRED` quando `failed` |
| created_at | timestamp | default now() |
| updated_at | timestamp | default now(), atualizado a cada save |

**Relations:** `Channel` has many `Video` (one-to-many; `Channel.videos` ↔ `Video.channel`, join column `channel_id`).
**Indexes:** unique on `slug`; index on `channel_id`; index on `(status, created_at)` (varredura do sweeper, per `phase-03-videos/TD-12`).

**`VideoMetadata` (jsonb):**

| Field | Type | Origem (ffprobe) |
|-------|------|------------------|
| format_name | string | `format.format_name` |
| size_bytes | number \| null | `format.size` |
| bit_rate | number \| null | `format.bit_rate` |
| width | number \| null | primeiro stream `codec_type=video` → `width` |
| height | number \| null | idem → `height` |
| frame_rate | number \| null | idem → `avg_frame_rate` (fração avaliada) |
| video_codec | string \| null | idem → `codec_name` |
| audio_codec | string \| null | primeiro stream `codec_type=audio` → `codec_name` |

**Transições de status** (per `phase-03-videos/TD-07`, `phase-03-videos/TD-12`):

| De | Para | Quando |
|----|------|--------|
| — | `draft` | `POST /videos` (pré-cadastro ao iniciar o upload) |
| `draft` | `processing` | `POST /videos/:slug/upload/complete` concluiu o multipart e enfileirou o job |
| `processing` | `ready` | worker gravou duração, metadados e thumbnail |
| `processing` | `failed` (`INVALID_MEDIA`) | ffprobe não encontrou stream de vídeo (sem retry) |
| `processing` | `failed` (`PROCESSING_ERROR`) | job esgotou as 3 tentativas |
| `draft` | `failed` (`UPLOAD_EXPIRED`) | sweeper: rascunho com mais de 24h sem completar upload |

**Storage keys** (bucket único e privado, per `phase-03-videos/TD-04`): `videos/{id}/original` (arquivo enviado) e `videos/{id}/thumbnail.jpg` (frame gerado).

### API Contracts

Todas as respostas de erro usam o envelope herdado `{ statusCode, error, message }` (`phase-02-auth/TD-07`, `ApiErrorEnvelope`). Todos os endpoints são documentados com `@nestjs/swagger` e exportados em `openapi.json` (`openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`). Vídeos são identificados na URL pelo `slug` (per `phase-03-videos/TD-08`).

**`VideoResponse`** (corpo comum de vídeo):
- id: string (uuid)
- slug: string — 11 chars, URL única do vídeo
- title: string
- status: `draft` | `processing` | `ready` | `failed`
- original_file_name: string
- mime_type: string
- size_bytes: number
- duration_seconds: number | null
- metadata: `VideoMetadata` | null (campos snake_case do Data Model)
- thumbnail_url: string | null — URL pré-assinada (TTL `VIDEO_PLAYBACK_URL_TTL_SECONDS`) quando `thumbnail_key` existe (per `phase-03-videos/TD-04`)
- failure_reason: string | null
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**`UploadPartUrl`:** `{ part_number: number, size: number, url: string }` — URL pré-assinada de `UploadPart` assinada para `S3_PUBLIC_ENDPOINT` com `Content-Length` = `size` assinado (partes cheias de `part_size`, a última com o resto); o storage rejeita (403) corpo de outro tamanho (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`; amended by SI-03.14).

#### POST /videos (SI-03.7)

Pré-cadastra o vídeo como `draft` e inicia o multipart upload direto no storage (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- file_name: string, required — 1..255 caracteres
- file_size: integer, required — ≥ 1; limite `VIDEO_MAX_UPLOAD_BYTES` (10 GiB) verificado no service
- mime_type: string, required — deve começar com `video/` (validation.md AMB-2)
- title: string, optional — 1..100 caracteres; default = `file_name` sem extensão

**Response 201:**
- video: `VideoResponse` (status `draft`)
- upload: `{ part_size: number, part_count: number, parts: UploadPartUrl[], expires_at: string (ISO-8601) }` — `part_count = ceil(file_size / part_size)`; uma URL por parte

**Error responses:**
- 400 validation error: body inválido (campos ausentes, `mime_type` fora de `video/*`)
- 400 VIDEO_FILE_TOO_LARGE: `file_size` > `VIDEO_MAX_UPLOAD_BYTES`
- 401 (guard JWT): token ausente ou inválido

---

#### GET /videos/:slug/upload (SI-03.7)

Retomada de upload interrompido (validation.md AMB-1): informa as partes já armazenadas (`ListParts`) e re-assina as faltantes.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- part_size: number
- part_count: number
- uploaded_parts: `{ part_number: number, etag: string, size: number }[]`
- parts: `UploadPartUrl[]` — somente as partes ainda não enviadas
- expires_at: string (ISO-8601)

**Error responses:**
- 401 (guard JWT): token ausente ou inválido
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo de outro canal
- 409 VIDEO_NOT_UPLOADABLE: vídeo não está em `draft`

---

#### POST /videos/:slug/upload/complete (SI-03.7)

Conclui o multipart (`CompleteMultipartUpload`), muda o status para `processing` e publica o job `process-video` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-11`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- parts: `{ part_number: integer ≥ 1, etag: string }[]`, required — exatamente uma entrada por parte planejada (1..`part_count`) (amended by SI-03.14)

**Response 202:** `VideoResponse` (status `processing`)

**Error responses:**
- 400 validation error: body inválido
- 400 INVALID_UPLOAD_PARTS: lista de partes incompleta/duplicada/fora do plano, ou storage rejeitou a lista (ETag/partNumber inválido)
- 401 (guard JWT): token ausente ou inválido
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo de outro canal
- 409 VIDEO_NOT_UPLOADABLE: vídeo não está em `draft`, mudou de status durante a conclusão, ou o upload não existe mais no storage
- 503 VIDEO_PROCESSING_UNAVAILABLE: falha ao publicar o job; status revertido para `draft` (per `phase-03-videos/TD-11`)

---

#### GET /videos/:slug (SI-03.7)

Metadados do vídeo. Público para vídeos `ready`; o dono (token válido opcional) vê qualquer status (per `phase-03-videos/TD-10`).

**Request headers:**
- Authorization: Bearer {access_token} — opcional

**Response 200:** `VideoResponse`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente, ou vídeo não-`ready` e requisitante não é o dono

---

#### GET /videos/:slug/stream (SI-03.7)

Redireciona para URL pré-assinada de `GetObject` do original; o storage atende `Range` → `206 Partial Content` (per `phase-03-videos/TD-09`).

**Request headers:**
- Authorization: Bearer {access_token} — opcional

**Response 302:** header `Location: {presigned GET url}` (assinada para `S3_PUBLIC_ENDPOINT`, TTL `VIDEO_PLAYBACK_URL_TTL_SECONDS`); sem corpo.

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente, ou vídeo não-`ready` e requisitante não é o dono
- 409 VIDEO_NOT_READY: dono requisitando vídeo que ainda não está `ready`

---

#### GET /videos/:slug/download (SI-03.7)

Igual a `/stream`, com `ResponseContentDisposition: attachment; filename="{original_file_name}"` assinado na URL — baixa o arquivo original (validation.md AMB-3, per `phase-03-videos/TD-09`).

**Request headers:**
- Authorization: Bearer {access_token} — opcional

**Response 302:** header `Location: {presigned GET url com response-content-disposition}`; sem corpo.

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente, ou vídeo não-`ready` e requisitante não é o dono
- 409 VIDEO_NOT_READY: dono requisitando vídeo que ainda não está `ready`

---

#### Validation Rules — videos

- `file_name`: required, string, 1..255
- `file_size`: required, integer ≥ 1 (teto de 10 GiB aplicado no service para retornar `VIDEO_FILE_TOO_LARGE`)
- `mime_type`: required, string, regex `^video\/[\w.+-]+$`
- `title`: optional, string, 1..100
- `parts`: required, array não vazio; cada item `part_number` inteiro 1..10000, `etag` string não vazia

### Authorization Matrix

Guard JWT global com opt-out `@Public()` (`phase-02-auth/TD-02`). Em rotas `@Public()`, um `Authorization: Bearer` válido é anexado a `request.user` (auth opcional) para que o dono seja reconhecido; token inválido em rota pública é ignorado (per `phase-03-videos/TD-10`).

| Endpoint | Anonymous | Authenticated (não dono) | Owner (usuário do canal do vídeo) |
|----------|-----------|--------------------------|-----------------------------------|
| POST /videos | ✗ (401) | ✓ (cria no próprio canal) | — |
| GET /videos/:slug/upload | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:slug/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:slug — vídeo `ready` | ✓ | ✓ | ✓ |
| GET /videos/:slug — `draft`/`processing`/`failed` | ✗ (404) | ✗ (404) | ✓ |
| GET /videos/:slug/stream — vídeo `ready` | ✓ | ✓ | ✓ |
| GET /videos/:slug/download — vídeo `ready` | ✓ | ✓ | ✓ |
| GET /videos/:slug/stream\|download — não-`ready` | ✗ (404) | ✗ (404) | ✗ (409 VIDEO_NOT_READY) |

### Error Catalog

Formato herdado de `phase-02-auth/TD-07` (`DomainException` → `DomainExceptionFilter`).

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_FILE_TOO_LARGE | 400 | `POST /videos` com `file_size` > `VIDEO_MAX_UPLOAD_BYTES` (10 GiB) |
| VIDEO_NOT_FOUND | 404 | slug inexistente; vídeo de outro canal em rotas de dono; vídeo não-`ready` para quem não é dono |
| VIDEO_NOT_UPLOADABLE | 409 | retomar/concluir upload de vídeo que não está em `draft` (inclusive por corrida) ou cujo upload o storage já descartou |
| INVALID_UPLOAD_PARTS | 400 | lista de partes diferente do plano, ou `CompleteMultipartUpload` rejeitado pelo storage (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) |
| VIDEO_PROCESSING_UNAVAILABLE | 503 | falha ao publicar o job na fila ao concluir upload |
| VIDEO_NOT_READY | 409 | dono pede stream/download de vídeo que não está `ready` |

Falhas de processamento não são erros HTTP: ficam registradas em `videos.failure_reason` (`INVALID_MEDIA`, `PROCESSING_ERROR`, `UPLOAD_EXPIRED`) e aparecem em `VideoResponse.failure_reason`.

### Events/Messages

Fila BullMQ `video-processing` no serviço Redis do Compose (per `phase-03-videos/TD-01`); consumida pelo processo `video-worker` (per `phase-03-videos/TD-05`). Opções padrão da fila: `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: 1000`, `removeOnFail: 1000`.

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` (per `phase-03-videos/TD-11`) — `queue.add('process-video', { videoId }, { jobId: videoId })`
**Consumer:** `VideoProcessingProcessor` → `VideoProcessingService.process(videoId)` no `video-worker` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
**Trigger:** upload concluído com sucesso (`draft → processing`)
**Delivery semantics:** at-least-once; `jobId = videoId` deduplica publicações repetidas enquanto o job está retido; o consumer é idempotente (ignora vídeo que não está em `processing`). Mídia sem stream de vídeo lança `UnrecoverableError` → `failed`/`INVALID_MEDIA` sem retry; demais erros usam as 3 tentativas e, na última falha, `failed`/`PROCESSING_ERROR` (per `phase-03-videos/TD-07`).

#### sweep-expired-uploads

**Payload:**

```json
{}
```

**Producer:** job scheduler `sweep-expired-uploads` (`queue.upsertJobScheduler(..., { every: 3600000 })`) registrado pelo `video-worker` ao iniciar (per `phase-03-videos/TD-12`)
**Consumer:** `VideoProcessingProcessor` → `UploadSweeperService.sweep()`
**Trigger:** a cada 1 hora
**Delivery semantics:** at-least-once; idempotente — só afeta vídeos `draft` com `created_at` anterior a `VIDEO_UPLOAD_WINDOW_HOURS` (24h): chama `AbortMultipartUpload` (ignorando `NoSuchUpload`) e então marca `failed`/`UPLOAD_EXPIRED` só se ainda for `draft`; rascunho sem `upload_id` tem o original apagado; falha de um rascunho não interrompe os demais e faz o job falhar para re-tentativa (amended by SI-03.15).

### Configuration (env)

Chaves novas validadas no schema Joi (`src/config/env.validation.ts`) e expostas via `registerAs` (convenção herdada da Fase 01); hosts usam nomes de serviço do Compose.

| Key | Default (dev) | Namespace | Uso |
|-----|---------------|-----------|-----|
| S3_ENDPOINT | `http://minio:9000` | `storage` | cliente interno (API e worker) |
| S3_PUBLIC_ENDPOINT | `http://localhost:9000` | `storage` | host assinado nas URLs entregues a clientes (per `phase-03-videos/TD-04`) |
| S3_REGION | `us-east-1` | `storage` | região de assinatura |
| S3_ACCESS_KEY | `streamtube` | `storage` | credencial MinIO |
| S3_SECRET_KEY | `streamtube-secret` | `storage` | credencial MinIO |
| S3_BUCKET | `streamtube-videos` | `storage` | bucket privado único |
| REDIS_HOST | `redis` | `queue` | conexão BullMQ |
| REDIS_PORT | `6379` | `queue` | conexão BullMQ |
| VIDEO_MAX_UPLOAD_BYTES | `10737418240` | `video` | teto do upload (10 GiB) |
| VIDEO_UPLOAD_PART_SIZE_BYTES | `67108864` | `video` | tamanho de parte (64 MiB; mínimo 5 MiB) |
| VIDEO_UPLOAD_URL_TTL_SECONDS | `3600` | `video` | validade das URLs de parte |
| VIDEO_PLAYBACK_URL_TTL_SECONDS | `3600` | `video` | validade das URLs de stream/download/thumbnail |
| VIDEO_UPLOAD_WINDOW_HOURS | `24` | `video` | idade a partir da qual o sweeper expira rascunhos |

---

## Dependency Map

```
SI-03.1 (root — infra, libs, config)
├── SI-03.2 — depends on SI-03.1 (MinIO + storage.config)
│   ├── SI-03.4 — depends on SI-03.2 + SI-03.3 (StorageService + Video)
│   │   └── SI-03.5 — depends on SI-03.4 (vídeos pré-cadastrados; fila)
│   │       └── SI-03.6 — depends on SI-03.5 (VideosService completo)
│   │           └── SI-03.7 — depends on SI-03.6 (endpoints HTTP)
│   │               └── SI-03.12 — depends on SI-03.7 + SI-03.10 (E2E do pipeline)
│   │                   └── SI-03.13 — depends on SI-03.12 (documentação do estado final)
│   └── SI-03.8 — depends on SI-03.2 (URLs internas p/ ffprobe/ffmpeg)
│       └── SI-03.9 — depends on SI-03.5 + SI-03.8 (jobs + MediaToolsService)
│           └── SI-03.10 — depends on SI-03.9 (worker entrypoint + Compose)
│               └── SI-03.11 — depends on SI-03.10 (scheduler no bootstrap do worker)
└── SI-03.3 — depends on SI-03.1 (entidade + migration)
```

Amendments (append-mode, 2026-09-28):

```
SI-03.12
├── SI-03.14 — amendment of SI-03.2/03.4/03.5 (integridade do upload)
│   └── SI-03.15 — amendment of SI-03.8/03.9/03.11 (processamento e sweeper)
SI-03.16 (root) — amendment of SI-03.1 (subida a frio do Compose)
```

Ordem de execução (topológica): SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14 → SI-03.15 → SI-03.16.

---

## Deliverables

- [x] SI-03.1 — Infra: dependências, FFmpeg, MinIO/Redis no Compose e configuração
- [x] SI-03.2 — Storage: StorageModule e StorageService sobre S3/MinIO
- [x] SI-03.3 — Entidade Video, relação com Channel e migration
- [x] SI-03.4 — Pré-cadastro do vídeo e início do upload direto
- [x] SI-03.5 — Fila de processamento, retomada e conclusão do upload
- [x] SI-03.6 — Acesso de reprodução: consulta por slug, stream, download e auth opcional
- [x] SI-03.7 — Endpoints de vídeos (VideosController, DTOs e OpenAPI)
- [x] SI-03.8 — Ferramentas de mídia: ffprobe e ffmpeg
- [x] SI-03.9 — Processamento automático do vídeo (job process-video)
- [x] SI-03.10 — Worker de vídeo: entrypoint, WorkerModule e serviço video-worker
- [x] SI-03.11 — Limpeza de uploads abandonados (job sweep-expired-uploads)
- [x] SI-03.12 — Fluxo completo upload → processamento → streaming (infra real)
- [x] SI-03.13 — Documentação de IA e de testes atualizada
- [x] SI-03.14 (amendment) — Integridade do upload: tamanho assinado por parte, lista completa e transições condicionais
- [x] SI-03.15 (amendment) — Robustez do processamento e do sweeper
- [x] SI-03.16 (amendment) — Subida a frio do Compose e `.env.example` válido

**Entregáveis da fase (project-plan):**

- [x] Upload de até 10GB funcional (multipart direto ao storage; limite validado)
- [x] Processamento automático do vídeo (duração, metadados, thumbnail) pelo `video-worker`
- [x] Streaming funcionando (302 → presigned GET com `206 Partial Content`) e download do original
- [x] URLs únicas geradas (slug de 11 chars com índice unique)

**Full test suites:**

- [x] Stack sobe completa (`cd nestjs-project && docker compose up -d && docker compose ps` — `db`, `mailpit`, `minio`, `redis`, `video-worker`, `nestjs-api` running; `minio-init` exited 0)
- [x] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [x] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [x] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
