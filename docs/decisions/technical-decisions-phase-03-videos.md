---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-28
scope_description: "Backend foundation for video upload and processing: object storage usage, background job queue, direct-to-storage upload of files up to 10GB, draft pre-registration, FFmpeg worker (metadata + thumbnail), unique video URL, streaming and download delivery, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (pre-registration, upload handshake, completion, metadata, stream/download endpoints), the object-storage integration, the queue producer, the video worker (same codebase, separate process) and the new Compose infrastructure (object storage, queue broker, worker).
- `next-frontend/` — no open decision in this document: the phase has no UI capability bullet and the video interface is explicitly out of scope for this delivery. Cross-layer TDs below (upload handshake, unique URL, streaming/download delivery, status lifecycle, access policy) define the contract the frontend will consume in a later phase.

**Already decided / not reopened:**

- Object storage **product** is not an open choice: S3-compatible storage, run locally as MinIO in Docker and swapped for S3 in production (`docs/diagrams/software-arch.mermaid` — "Object Storage (S3 or MinIO)"). This document only decides **how** it is used (client library, bucket/key layout, presigned access).
- Worker processing engine is FFmpeg (`docs/diagrams/software-arch.mermaid` — "Video Worker (FFmpeg)"). This document decides how FFmpeg is invoked and how the worker runs.
- Inherited from prior phases: `@nestjs/config` + Joi env validation with namespaced `registerAs` configs (phase-01/TD-01..04), class-validator DTOs (phase-02-auth/TD-06), custom domain exception filter `{ statusCode, error, message }` (phase-02-auth/TD-07), custom JWT guard registered globally with `@Public()` opt-out (phase-02-auth/TD-02), `@nestjs/swagger` + CLI plugin with exported `openapi.json` (openapi-docs-nestjs/TD-01..02).

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan and the architecture diagram leave the message queue explicitly as "TBD". Video processing (ffprobe + thumbnail extraction) is CPU/IO heavy and must run outside the HTTP request lifecycle. The queue must deliver jobs to a separate worker process, support retries with backoff, and keep failed jobs inspectable. Installed stack: NestJS 11.1, Node 25 (Docker image `node:25.6.0-slim`), PostgreSQL 17. Current versions on npm: `bullmq@6.3.9` (released 2026-07-30; datastore-agnostic, Redis or PostgreSQL backend), `@nestjs/bullmq@12.0.0` (peer `@nestjs/core ^10 || ^11 || ^12`, `bullmq ^3..^6`), `@golevelup/nestjs-rabbitmq@9.1.0`, `pg-boss@12.35.0`.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq` + `bullmq` + a `redis` Compose service)
- Jobs live in Redis; the API registers the queue (`BullModule.registerQueue`) and adds jobs; the worker process declares a `@Processor()` extending `WorkerHost`. Retries (`attempts` + exponential `backoff`), job ids, `removeOnComplete/removeOnFail`, events and progress are built in.
- **Pros:** Official NestJS integration (`@nestjs/bullmq`), the most battle-tested BullMQ backend (docs call Redis "the default and the most battle-tested option"). Job-oriented semantics out of the box (retries, backoff, deduplication by `jobId`, failed-job retention). Redis is a small, well-known container that materializes the "Message Queue" container of the architecture diagram as real infrastructure.
- **Cons:** New infrastructure component to operate (Redis persistence/`maxmemory-policy` must be configured so jobs are not evicted). Jobs and relational data live in different stores (no transactional enqueue).

### Option B: BullMQ on PostgreSQL (BullMQ 6 `createPostgresBackend`)
- Same `Queue`/`Worker` API as Option A, but the queue tables live in the existing PostgreSQL 17 instance (BullMQ runs its own idempotent schema migrations).
- **Pros:** No new container; jobs live next to relational data (enables transactional patterns). Same application code as Option A.
- **Cons:** Brand-new backend (BullMQ 6.0 released 2026-07-30) — little production mileage; docs report ~1.5–2× lower throughput than Redis. `@nestjs/bullmq` documentation and examples are Redis-centric, so wiring the Postgres backend through the Nest module is less documented. Mixes queue load (polling/locks) into the primary database, and does not materialize a dedicated queue container as the architecture expects.

### Option C: RabbitMQ (`@golevelup/nestjs-rabbitmq` + `rabbitmq` Compose service)
- A message broker: the API publishes a message to an exchange; the worker consumes from a durable queue with manual ack.
- **Pros:** Mature broker with strong delivery guarantees, routing (exchanges/bindings), management UI. Language-agnostic (a future non-Node worker could consume the same queue).
- **Cons:** A broker, not a job queue — retries with backoff, attempt counting and failed-job retention must be built with dead-letter exchanges/TTL queues. Heavier container (Erlang VM) and more moving parts for a single job type. Community NestJS integration (not `@nestjs/*`).

**Recommendation:** Option A (BullMQ on Redis) — it gives job semantics the phase needs (retries with backoff, deterministic job ids, failed-job retention) with the official NestJS integration and zero custom plumbing, and it materializes the architecture's dedicated "Message Queue" container; the Postgres backend (B) is attractive for avoiding a container but is two months old and less documented through `@nestjs/bullmq`, and RabbitMQ (C) would require hand-building retry/backoff via dead-letter exchanges for a single job type.

**Decision:** A (BullMQ on Redis)
**Libraries:** bullmq, @nestjs/bullmq, ioredis

---

## TD-02: Upload Strategy for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB upload must not hold API resources (event loop, memory, request timeouts) and, per `docs/project-plan.md` §4, should allow resuming after a connection failure. S3/MinIO limits (MinIO docs): single PUT ≤ 5 TiB on MinIO but ≤ 5 GiB on AWS S3 — so a single presigned PUT cannot carry 10GB on production S3; multipart uploads allow up to 10,000 parts of 5 MiB–5 GiB each (last part may be smaller). The handshake is a contract between backend and the future frontend uploader, hence Cross-layer.

**Options:**

### Option A: Stream the file through the API (`multipart/form-data` → S3 `Upload`)
- The client POSTs the file to the API; the API streams it (busboy) straight into an S3 multipart upload without buffering to disk.
- **Pros:** Simplest client (one request). The API sees every byte (can validate content on the fly). No presigned-URL handling in the frontend.
- **Cons:** The API holds a long-lived connection and proxies the full 10GB — bandwidth, sockets and request timeouts become API concerns, which is exactly the "sem travar o sistema" risk. No resume: a dropped connection restarts from zero. Scaling uploads means scaling the API.

### Option B: tus resumable protocol (`@tus/server` + `@tus/s3-store`)
- A tus endpoint (mounted in the API or as its own service) accepts resumable chunked PATCH requests and writes chunks to S3 via multipart.
- **Pros:** Standard resumable protocol with mature clients (tus-js-client, Uppy). Resume is built into the protocol. Upload lifecycle hooks (`onUploadFinish`) for triggering processing.
- **Cons:** Bytes still flow through a Node server (the tus server) — same bandwidth/socket pressure as Option A unless deployed separately. Extra protocol and two new libraries; the tus server must be kept consistent with the S3 multipart state.

### Option C: Direct-to-storage S3 multipart upload with presigned part URLs
- The API pre-registers the video, calls `CreateMultipartUpload`, and returns presigned `UploadPart` URLs; the client PUTs each part directly to MinIO/S3 and reports the returned ETags; the API calls `CompleteMultipartUpload` and enqueues processing. Resume = ask the API which parts are already stored (`ListParts`) and for fresh URLs of the missing ones.
- **Pros:** The API only handles small JSON requests — zero video bytes pass through it, so 10GB uploads have no effect on API performance. Parts can be uploaded in parallel and retried individually; resume after connection loss is native (`ListParts`). Works identically on MinIO and AWS S3 (respects the 5 GiB single-PUT limit).
- **Cons:** More complex client handshake (initiate → upload parts → complete). Presigned URLs must be signed for a host the client can reach (a public storage endpoint distinct from the internal Compose host). The API cannot inspect content during upload — validation happens after upload (the worker's ffprobe rejects non-video files).

**Recommendation:** Option C (direct-to-storage multipart with presigned part URLs) — it is the only option where no video byte crosses the API, which is the literal requirement ("sem impacto na performance"), it gives resume after connection loss via `ListParts` (project-plan §4), and it stays within AWS S3's 5 GiB single-PUT limit when MinIO is swapped for S3. Suggested policy: max size 10 GiB (10,737,418,240 bytes) validated at initiate time, fixed part size of 64 MiB (≤ 160 parts for 10 GiB, far from the 10,000-part limit), presigned part URLs valid for a bounded window (e.g., 1 hour) and re-issuable on resume.

**Decision:** C (Direct-to-storage S3 multipart with presigned part URLs)

**Note:** User accepted the recommendation, noting that this is an MBA demo project and 10GB uploads will not occur in practice; the strategy is still implemented and tested at the contract level (size limit, part plan) with small real files.

**Revisions:**
- 2026-09-28 — Each presigned part URL signs its exact `Content-Length` (every part = part size, last = remainder, exposed as `parts[].size`), and completion requires the full planned part list. Rationale: reanalysis showed an unbound part URL accepted any body size (verified against MinIO), so the 10 GiB limit and `size_bytes` could be bypassed.

---

## TD-03: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API (multipart initiate/complete, presigned URLs) and the worker (read the original, write the thumbnail) both need an S3 client that works against MinIO locally and AWS S3 in production without code changes.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Modular official AWS client; commands (`CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `ListPartsCommand`, `GetObjectCommand`, `PutObjectCommand`) sent through an `S3Client`; `getSignedUrl()` presigns any command. MinIO is targeted via `endpoint` + `forcePathStyle: true`.
- **Pros:** The reference S3 implementation — production S3 behavior is guaranteed. Presigns every multipart command (including `UploadPart`). Tree-shakable modular packages, first-class TypeScript types. Swapping MinIO → S3 is only config (endpoint/credentials).
- **Cons:** Verbose command-based API. Two packages. Large transitive dependency tree (Smithy runtime).

### Option B: MinIO JavaScript client (`minio`)
- MinIO's own S3-compatible SDK with a high-level API (`putObject`, `presignedGetObject`, `presignedPutObject`).
- **Pros:** Concise API, small footprint, works against AWS S3 as well.
- **Cons:** No public helper to presign `UploadPart` of a multipart upload (the high-level API hides multipart) — the direct-to-storage multipart flow (TD-02 Option C) would need low-level workarounds. Vendor SDK for what should be a vendor-neutral S3 contract.

**Recommendation:** Option A (AWS SDK v3) — it presigns every multipart command needed by TD-02's direct upload and is the reference behavior for the production S3 target, keeping MinIO → S3 a configuration swap; the MinIO client lacks presigned multipart part URLs.

**Decision:** A (AWS SDK v3 — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Note:** User delegated this choice to the recommendation ("deixo você sugerir"), reminding that the project is an MBA demo with no real production use.

---

## TD-04: Bucket and Object Key Organization and Access

**Scope:** Cross-layer

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails must be stored with keys that never collide, and access must be controllable (the phase has drafts that are not yet ready; Phase 04/05 will add visibility rules). The access model defines what the API returns to clients (stable public URLs vs expiring signed URLs), hence Cross-layer. Presigned URLs are signed for a host, so the storage endpoint the client reaches (e.g., `http://localhost:9000` in dev) differs from the internal Compose host (`http://minio:9000`) — both must be configuration.

**Options:**

### Option A: Single private bucket, per-video key prefix, presigned access for everything
- One bucket (e.g., `streamtube-videos`), no public policy. Keys: `videos/{videoId}/original` for the uploaded file and `videos/{videoId}/thumbnail.jpg` for the generated frame. Every read (stream, download, thumbnail) is served through short-lived presigned GET URLs issued by the API. Bucket created by a one-shot `minio/mc` init container in Compose (production buckets are provisioned outside the app).
- **Pros:** One access model and one policy; nothing is readable without the API deciding (drafts, failed videos and future unlisted/private rules stay enforceable). Keys derive from the immutable video UUID — no collisions, trivial per-video cleanup by prefix.
- **Cons:** Thumbnail URLs expire, so they cannot be cached forever by clients/CDN and listings must sign one URL per item (cheap, local HMAC).

### Option B: Two buckets — private `videos` + public-read `thumbnails`
- Originals stay private behind presigned URLs; thumbnails go to a bucket with an anonymous read policy and are referenced by stable URLs.
- **Pros:** Stable, cacheable thumbnail URLs (CDN-friendly for the future home grid). No signing for thumbnails.
- **Cons:** Two bucket policies to manage. Thumbnails of drafts/failed/future unlisted videos become publicly fetchable by anyone who learns the key. Access rules split between API and bucket policy.

**Recommendation:** Option A (single private bucket, per-video prefix, presigned access) — it keeps a single access model where the API decides every read, which Phase 03 needs for drafts and Phase 04/05 need for visibility, with collision-free keys derived from the video UUID; stable CDN URLs for thumbnails (Option B) can be introduced later without migrating originals.

**Decision:** A (Single private bucket, per-video key prefix, presigned access)

**Revisions:**
- 2026-09-28 — `minio-init` uses the `minio-client:latest-dev` image to wait with `mc ready` before creating the bucket, and `nestjs-api`/`video-worker` wait for it to complete. Rationale: on a cold start the shell-less image relied on restart-on-failure, racing Compose's `service_completed_successfully` dependency.

---

## TD-05: Video Worker Runtime and Deployment

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture defines a separate "Video Worker (FFmpeg)" container that consumes jobs and updates DB and storage. The worker needs the `Video` entity, database config and S3 config that the API also uses. It also needs the FFmpeg binaries, which the current `Dockerfile.dev` (`node:25.6.0-slim`) does not include. Depends on TD-01.

**Options:**

### Option A: Same `nestjs-project/` codebase, separate entrypoint and Compose service
- A worker bootstrap file creates a Nest application context (`NestFactory.createApplicationContext(WorkerModule)`, no HTTP server) that imports the shared config/TypeORM/storage modules and registers the queue processor. A new Compose service (`video-worker`) runs it from the same image (with FFmpeg added to the image).
- **Pros:** Entities, configs, storage service and validation schemas are shared — no duplication or drift. Isolated process: FFmpeg load never touches the API event loop, and the worker scales independently (more replicas). Same test toolchain (Jest, DoD) covers both.
- **Cons:** API and worker share one `package.json` and image (the API image carries FFmpeg). Module boundaries must keep HTTP-only providers out of the worker context.

### Option B: Processor inside the API process
- Register the `@Processor()` in the API application itself.
- **Pros:** Zero extra services or entrypoints; simplest setup.
- **Cons:** FFmpeg jobs compete with HTTP requests for CPU and the event loop — contradicts "sem impacto na performance" and the architecture's separate worker container. Cannot scale processing independently.

### Option C: New standalone subproject (e.g., `video-worker/`)
- A separate Node (or other language) project with its own `package.json`, Dockerfile and data access.
- **Pros:** Strongest isolation; independent dependencies and release cycle; could use another language.
- **Cons:** Duplicates the `Video` entity/schema knowledge, config validation and S3 wiring, or requires a shared package (monorepo tooling that does not exist). Second test/lint/tsc pipeline.

**Recommendation:** Option A (same codebase, separate entrypoint and Compose service) — it honors the architecture's separate worker container and keeps FFmpeg off the API event loop while reusing the entity, config and storage modules instead of duplicating them; a standalone subproject (C) adds duplication with no requirement demanding language or release independence.

**Decision:** A (Same codebase, separate entrypoint and Compose service)

---

## TD-06: FFmpeg Invocation and Processing Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration/metadata (ffprobe) and generate a thumbnail from a frame (ffmpeg) for files up to 10GB. Copying 10GB to the worker's disk before probing is slow and needs disk capacity; FFmpeg can read HTTP inputs with range requests. `fluent-ffmpeg` (the historical wrapper) is marked on npm as "Package no longer supported". Depends on TD-05.

**Options:**

### Option A: Spawn `ffprobe`/`ffmpeg` binaries (`child_process.execFile`) reading the object over a presigned HTTP URL
- `ffprobe -v error -print_format json -show_format -show_streams <presigned-url>` returns metadata as JSON; `ffmpeg -ss <t> -i <presigned-url> -frames:v 1 -vf scale=...` writes one JPEG frame to a temp file that is uploaded as the thumbnail. FFmpeg issues HTTP range requests, so only the needed bytes (container header/index and the region around the seek point) are fetched.
- **Pros:** No wrapper dependency; full control of arguments; JSON output parsed with typed DTOs. No full download of 10GB files — processing time and disk usage stay small. `execFile` avoids shell injection (arguments array).
- **Cons:** Must parse ffprobe JSON and handle exit codes/timeouts manually. Files whose index sits at the end (non-faststart MP4) cost extra range requests.

### Option B: Download the object to a temp file, then spawn `ffprobe`/`ffmpeg` locally
- Stream `GetObject` to the worker's disk, run the binaries on the local path, delete the temp file.
- **Pros:** Simplest mental model; FFmpeg works on local seeks (fastest per-seek).
- **Cons:** Copies up to 10GB per job (time, network and ephemeral disk proportional to video size) just to read headers and one frame.

### Option C: `fluent-ffmpeg` wrapper
- Node API over the same binaries (`ffprobe()`, `.screenshots()`).
- **Pros:** Convenient API, widely known.
- **Cons:** Unsupported package (npm deprecation notice) — conflicts with the project rule of following maintained, documented libraries; adds nothing that `execFile` + JSON parsing does not already cover.

**Recommendation:** Option A (spawn binaries over a presigned URL) — it avoids copying up to 10GB per job while keeping FFmpeg as the only dependency, and `fluent-ffmpeg` is unsupported. Suggested policy: persist `duration_seconds` plus a `metadata` JSON (container format, size, bitrate, width, height, frame rate, video/audio codecs); take the thumbnail at 10% of the duration clamped to [0 s, duration − 0.1 s], scaled to 1280 px wide JPEG; bounded execution timeout per command.

**Decision:** A (Spawn ffprobe/ffmpeg via execFile reading a presigned URL)
**Libraries:** ffmpeg (Debian package in the Docker image — not an npm dependency)

**Revisions:**
- 2026-09-28 — Streams flagged `disposition.attached_pic` (cover art) do not count as video, and an ffmpeg decode failure is also classified `INVALID_MEDIA`. Rationale: audio files with artwork were accepted as videos; undecodable frames were retried 3× as transient errors.

---

## TD-07: Video Status Lifecycle and Failure Handling

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video is pre-registered as a draft when the upload starts, then processed in background; the status must be persisted and exposed to clients (the future upload UI polls it), hence Cross-layer. Failure handling decides what users see and whether the system retries. Phase 04 will add the publication flow (draft → published) and visibility; this phase must not preclude it. Depends on TD-01 (retries) and TD-02 (when the upload is considered complete).

**Options:**

### Option A: Single processing-status enum `draft → processing → ready | failed`, with bounded retries
- `draft` on pre-registration (upload in progress); `processing` when the API completes the multipart upload and enqueues the job; `ready` when metadata and thumbnail are stored; `failed` after the queue exhausts its retries (e.g., 3 attempts, exponential backoff), with a `failure_reason`. Terminal `failed` keeps the original object for diagnosis/re-processing (re-processing endpoint out of scope). Phase 04 adds publication/visibility as separate columns.
- **Pros:** Matches the challenge's cycle literally (rascunho → processando → pronto/erro); one column to query and index. Transient failures (storage hiccup) are retried automatically; permanent failures (not a video) end in a visible terminal state.
- **Cons:** `draft` carries upload-in-progress meaning, while Phase 04 "rascunho → publicação" is about publication — Phase 04 must keep the two concepts in separate columns.

### Option B: Two independent enums — `upload_status` and `processing_status`
- `upload_status: pending | completed | aborted`; `processing_status: pending | processing | ready | failed`.
- **Pros:** Each concern is explicit; aborted uploads are representable.
- **Cons:** Invalid combinations become possible (e.g., upload pending + processing ready) and must be guarded; more columns and states than the phase needs.

### Option C: Finer single enum `draft → uploaded → processing → ready | failed`
- Adds an `uploaded` state between multipart completion and the worker picking up the job.
- **Pros:** Distinguishes "queued" from "being processed" for observability.
- **Cons:** Extra state with no user-facing meaning in this phase (the queue already tracks waiting vs active); more transitions to test.

**Recommendation:** Option A (single enum `draft → processing → ready | failed` with bounded retries) — it reflects the required cycle with the fewest states, lets BullMQ retries absorb transient errors before marking `failed`, and leaves publication/visibility to dedicated Phase 04 columns.

**Decision:** A (Single enum `draft → processing → ready | failed` with bounded retries)

---

## TD-08: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, non-conflicting identifier used in its public URL (project-plan §4: "URL curta e única que nunca conflite"). The identifier appears in API routes and in frontend routes, hence Cross-layer. The `videos` primary key is a UUID like the other tables. The channel nickname already uses a "generate → unique constraint → retry on 23505" pattern (phase-02-auth/TD-10 + `typeorm-queries` rule).

**Options:**

### Option A: Use the UUID primary key in the URL
- `/videos/2f1c…-…` — no extra column.
- **Pros:** Zero extra logic; globally unique by construction.
- **Cons:** 36-character URLs — not "curta"; exposes the internal primary key.

### Option B: Random short slug (11 base64url chars from `crypto.randomBytes`) with a unique index
- Generate 8 random bytes → 11-char base64url string (YouTube-like); store in a `slug` column with a UNIQUE constraint; on the (astronomically rare) collision retry with a new value.
- **Pros:** Short, URL-safe, unguessable (64 bits of entropy — suitable for future unlisted videos), no dependency (Node `crypto`). Uniqueness guaranteed by the database, not by probability.
- **Cons:** An extra indexed column; collision-retry path to implement/test.

### Option C: Sqids/Hashids encoding of a sequential integer
- Add a `bigserial` column and encode it into a short string with a library.
- **Pros:** Collision-free by construction; very short URLs.
- **Cons:** Reversible/enumerable (reveals volume, enables scraping unlisted videos); new dependency; second key column anyway.

**Recommendation:** Option B (random 11-char base64url slug with unique index) — short and unguessable URLs without a new dependency, with uniqueness enforced by the database and a retry path consistent with the existing nickname generation pattern; enumerable Sqids (C) would undermine future unlisted videos.

**Decision:** B (Random 11-char base64url slug with unique index)

---

## TD-09: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, and users must be able to download the original. HTTP range requests (`Range` → `206 Partial Content`) enable progressive playback of MP4/WebM in browsers; S3/MinIO serve ranges natively. The architecture diagram shows the frontend streaming directly from Object Storage. The delivery mechanism is a contract for the future player, hence Cross-layer. Depends on TD-04 (private bucket).

**Options:**

### Option A: API endpoints redirect (302) to short-lived presigned GET URLs
- `GET …/stream` returns `302 Location: <presigned GET>`; the browser/player follows it and issues range requests directly to storage, which answers `206`. `GET …/download` does the same with `response-content-disposition=attachment; filename=…` baked into the signature.
- **Pros:** Zero video bytes through the API (matches the diagram's "Frontend → Object Storage: Streams"); storage/CDN handles ranges, seeking and bandwidth. Stable API URLs for the player while storage URLs stay private and expiring. Same mechanism for streaming and download.
- **Cons:** Signed URLs expire (players re-request the API URL on expiry). Requires the public storage endpoint configuration (TD-04).

### Option B: API proxies bytes with range support
- The API reads the `Range` header, calls `GetObject` with that range and pipes the body with `206` + `Content-Range`.
- **Pros:** Storage never exposed to clients; single origin; fine-grained access checks per request.
- **Cons:** All playback bandwidth flows through the API process — the same performance concern the upload strategy avoids; the API must implement range parsing and error cases.

### Option C: Adaptive streaming (HLS) generated by the worker
- The worker transcodes into renditions + segments and a `.m3u8` playlist; players fetch segments.
- **Pros:** Adaptive bitrate, best UX on poor networks; industry standard at scale.
- **Cons:** Full transcoding of up to 10GB per video (hours of CPU), multiplied storage, a player library on the frontend; far beyond the phase's capabilities (metadata + thumbnail).

**Recommendation:** Option A (302 to presigned GET, storage serves ranges) — progressive range streaming satisfies "sem necessidade de download completo" while keeping the API out of the byte path as the architecture intends, and one mechanism covers both streaming and download; HLS (C) can be added later as an additional rendition without changing the API contract.

**Decision:** A (302 redirect to short-lived presigned GET URLs)

---

## TD-10: Playback Access Policy in Phase 03

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Phase 03 introduces playback before Phase 04's visibility (public/unlisted) and publication flow exist. The project principle is that anonymous users can watch freely (`docs/project-plan.md` §1). The rule decides which endpoints are `@Public()` and what non-owners see, hence Cross-layer (Authorization Matrix). Depends on TD-07 (statuses).

**Options:**

### Option A: Anyone with the unique URL can watch/download `ready` videos; owner-only for everything else
- Public (anonymous) access to metadata, stream and download of `ready` videos by slug; `draft`/`processing`/`failed` videos are visible only to the owning channel's user (non-owners get 404). Upload handshake endpoints are owner-only.
- **Pros:** Aligns with "acesso anônimo" and makes the unique URL meaningful (shareable link). Unfinished videos never leak. Phase 04 narrows access with visibility/publication filters without changing endpoints.
- **Cons:** Until Phase 04, every `ready` video behaves like "unlisted" (reachable by link, but not listed anywhere) — there is no way to keep a finished video private in this phase.

### Option B: Owner-only playback until Phase 04
- All video endpoints require the owner's JWT in this phase; public access arrives with Phase 04/05.
- **Pros:** Nothing is reachable anonymously before publication rules exist.
- **Cons:** Contradicts the anonymous-viewing principle and makes the "URL única" non-shareable in this phase; Phase 05 must flip endpoints from protected to public.

**Recommendation:** Option A (public-by-link for `ready`, owner-only otherwise) — it realizes the anonymous-viewing principle and a shareable unique URL now, never exposes unfinished videos, and lets Phase 04 add visibility as an extra filter on the same endpoints.

**Decision:** A (Public-by-link for `ready` videos; owner-only otherwise)

---

## TD-11: Job Enqueue Consistency and Idempotency

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Completing an upload changes the video row (`draft → processing`) in PostgreSQL and publishes a job to the queue — two stores without a shared transaction. A crash or queue outage between the two leaves a video stuck in `processing` with no job, and client retries of "complete" could enqueue duplicates. Depends on TD-01 and TD-07.

**Options:**

### Option A: Enqueue after the DB update with a deterministic job id; idempotent worker
- The API updates the status, then adds the job with `jobId = videoId`; if enqueuing fails the request fails and the status transition is reverted, so the client can retry "complete". BullMQ ignores duplicate `jobId`s while the job is retained; the worker re-checks the video status and skips videos that are already `ready`.
- **Pros:** No extra tables or relay process; duplicates are absorbed by the job id and by the worker's status check; failures surface to the client immediately.
- **Cons:** Not atomic: a process crash exactly between the DB update and the enqueue leaves a `processing` video without a job (needs a manual/periodic re-enqueue, out of scope).

### Option B: Transactional outbox
- The status update and an `outbox` row are written in the same DB transaction; a relay polls the outbox and publishes to the queue, marking rows as sent.
- **Pros:** Atomic — a committed status change always produces a job eventually.
- **Cons:** New table, relay process/poller and its own retry/cleanup logic — significant machinery for a single job type.

**Recommendation:** Option A (deterministic job id + idempotent worker) — it covers client retries and duplicate enqueues with no extra infrastructure; the only uncovered window (process crash between two local calls) is narrow and can be addressed later with a sweeper, whereas an outbox adds a table and a relay for one job type.

**Decision:** A (Deterministic job id + idempotent worker)

**Revisions:**
- 2026-09-28 — The `draft → processing` transition is a conditional UPDATE, and any finished job with the same id is removed before `add`. Rationale: a lost-response enqueue could leave a completed job that made the retry a silent duplicate (video stuck in `processing`); concurrent completions/sweeps could overwrite each other.

---

## TD-12: Cleanup of Abandoned Uploads and Stale Drafts

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Raised by `plan-validate` (MD-1). With direct-to-storage multipart uploads (TD-02), a client that starts an upload and never completes it leaves (1) incomplete multipart parts in the bucket — invisible to object listings but billed as storage — and (2) a `draft` row whose upload can no longer complete once its parts are gone. `docs/project-plan.md` §4 asks to plan storage growth and cost from the start. MinIO aborts stale multipart uploads on its own (server settings `api stale_uploads_expiry`, default 24h), while AWS S3 needs an `AbortIncompleteMultipartUpload` lifecycle rule. Depends on TD-01, TD-02 and TD-07.

**Options:**

### Option A: Storage-level lifecycle only
- Rely on MinIO's stale-upload expiry locally and on an S3 `AbortIncompleteMultipartUpload` lifecycle rule in production; the application does nothing.
- **Pros:** Zero application code; storage reclaims orphaned parts automatically.
- **Cons:** `draft` rows stay forever in a state that can never complete (their parts are gone), so the database contradicts the storage; behavior depends on per-environment bucket configuration outside the codebase.

### Option B: Application sweeper as a scheduled queue job
- A repeatable job (BullMQ job scheduler, consumed by the video worker) runs periodically and, for `draft` videos older than an upload window (e.g., 24h), aborts their multipart upload (`AbortMultipartUpload`) and marks them `failed` with reason `UPLOAD_EXPIRED`.
- **Pros:** Database and storage stay consistent; the rule lives in code and is tested with the real queue and storage; works identically on MinIO and S3; reuses the queue and worker already introduced by TD-01/TD-05.
- **Cons:** One more job type and schedule to implement and test; the upload window becomes a hard limit (a 10GB upload must finish within it).

### Option C: Defer cleanup to a later phase
- Keep abandoned drafts and parts; address cleanup when the channel dashboard (Phase 04) exists.
- **Pros:** No work in this phase.
- **Cons:** Storage grows unbounded from day one, against project-plan §4; data cleanup later must deal with an accumulated backlog.

**Recommendation:** Option B (scheduled sweeper job) — it keeps the `draft` status truthful and reclaims orphaned parts through the queue and worker that this phase already builds, independent of per-environment bucket configuration; a 24h upload window is generous for a 10GB file on any realistic connection, and storage-level lifecycle rules can still be added in production as a second safety net.

**Decision:** B (Scheduled sweeper queue job)

**Revisions:**
- 2026-09-28 — The sweeper aborts the multipart first and then expires only rows still in `draft` (conditional UPDATE), deletes the assembled original of drafts never enqueued, and isolates per-draft failures (job fails afterwards for a retry). Rationale: a completion racing the sweep could be marked `UPLOAD_EXPIRED`; one storage error stopped the whole sweep.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | BullMQ on Redis | A |
| TD-02 | Cross-layer | Upload Strategy for Files up to 10GB | Direct-to-storage S3 multipart with presigned part URLs | C |
| TD-03 | Backend | S3 Client Library | AWS SDK v3 (`@aws-sdk/client-s3` + presigner) | A |
| TD-04 | Cross-layer | Bucket and Object Key Organization and Access | Single private bucket, per-video prefix, presigned access | A |
| TD-05 | Backend | Video Worker Runtime and Deployment | Same codebase, separate entrypoint and Compose service | A |
| TD-06 | Backend | FFmpeg Invocation and Processing Strategy | Spawn ffprobe/ffmpeg over a presigned URL | A |
| TD-07 | Cross-layer | Video Status Lifecycle and Failure Handling | Single enum `draft → processing → ready \| failed` + bounded retries | A |
| TD-08 | Cross-layer | Unique Video URL Identifier | Random 11-char base64url slug + unique index | B |
| TD-09 | Cross-layer | Streaming and Download Delivery | 302 to presigned GET (storage serves ranges) | A |
| TD-10 | Cross-layer | Playback Access Policy in Phase 03 | Public-by-link for `ready`, owner-only otherwise | A |
| TD-11 | Backend | Job Enqueue Consistency and Idempotency | Deterministic job id + idempotent worker | A |
| TD-12 | Backend | Cleanup of Abandoned Uploads and Stale Drafts | Scheduled sweeper queue job | B |
