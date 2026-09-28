---
libs:
  "bullmq":
    version: "^6.3.9"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-28T17:40:00-03:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-09-28T17:40:00-03:00"
  "ioredis":
    version: "^5.11.1"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-28T17:40:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1142.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-28T17:40:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1142.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-28T17:40:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T17:20:35-03:00"
---

# Library references — phase-03-videos

Distilled from Context7 (fetched 2026-09-28) for the surfaces this phase uses. Versions are the current npm releases, compatible with the installed stack (NestJS 11.1.16, Node 25 image). `@nestjs/bullmq@12` declares peers `@nestjs/core ^10 || ^11 || ^12` and `bullmq ^3 || ^4 || ^5 || ^6`.

### bullmq

_TD: phase-03-videos/TD-01, TD-11, TD-12_

- **v6 is datastore-agnostic.** `ioredis`, `redis` and `pg` are optional peer dependencies; the Redis backend (default) needs `ioredis` installed. `ConnectionOptions = RedisOptions | ClusterOptions | IRedisClient | RedisConnectionClient` — plain `{ host, port }` is forwarded to the ioredis constructor.
- **Workers** need `maxRetriesPerRequest: null` on a shared ioredis instance (BullMQ sets it when it creates the connection from options). Each Worker duplicates the connection for blocking commands.
- **Retries:** `defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }` on the queue, or per `queue.add(name, data, opts)`.
- **Job ids:** `opts.jobId` deduplicates — a second `add` with the same id is ignored **while the previous job still exists**. With `removeOnComplete`/`removeOnFail`, removed jobs no longer count as duplicates.
- **Retention:** `removeOnComplete: true | number`, `removeOnFail: number` (keep last N failed jobs).
- **Job schedulers (repeatable jobs):** `queue.upsertJobScheduler(schedulerId, { every: ms } | { pattern: cron }, { name, data, opts })` — idempotent upsert; the old `repeat` option on `add` was **removed in v6**, as was `debounce` (use `deduplication`).
- **Failure semantics:** when `process()` throws, the job is retried until `attempts` is exhausted; `job.attemptsMade` and `job.opts.attempts` tell whether the current failure is final (`worker.on('failed', (job, err) => …)`). `UnrecoverableError` fails a job without further retries.
- **Shutdown:** `queue.close()` / `worker.close()`; connections passed as shared instances are not quit by BullMQ.

### @nestjs/bullmq

_TD: phase-03-videos/TD-01, TD-05_

- Root config: `BullModule.forRootAsync({ inject: [...], useFactory: () => ({ connection: { host, port }, defaultJobOptions? }) })`.
- Queue registration: `BullModule.registerQueue({ name })` (or `registerQueueAsync`); inject with `@InjectQueue(name) queue: Queue`; token helper `getQueueToken(name)` for tests.
- Consumers: `@Processor(name, workerOptions?)` on a class extending `WorkerHost`, implementing `async process(job: Job): Promise<unknown>`; the return value is stored on the job. Worker events via `@OnWorkerEvent('failed' | 'completed' | 'active')` inside the processor class.
- Components are registered in `onModuleInit`; a processor only consumes when its module is part of the running application context — the API process must **not** import the processor module (TD-05), only the queue producer.

### ioredis

_TD: phase-03-videos/TD-01_

- Required peer of BullMQ's Redis backend (`>=5`). Pinned to **5.x**: `typeorm@0.3.28` declares an optional peer `ioredis@^5.0.4`, so `ioredis@6` fails npm peer resolution (fixed during SI-03.1). Used implicitly through `connection` options — no direct usage expected in application code.

### @aws-sdk/client-s3

_TD: phase-03-videos/TD-02, TD-03, TD-04, TD-06, TD-12_

- **MinIO/S3-compatible client:** `new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })`.
- **Checksum defaults (since 3.729/3.731):** the client computes CRC32 checksums by default for operations that support them (e.g., `UploadPart`, `PutObject`) and validates response checksums. For third-party S3-compatible services and for **presigned URLs used by clients that do not send checksum headers**, set `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'`.
- **Multipart commands:** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; `UploadPartCommand({ Bucket, Key, UploadId, PartNumber (1–10000), Body })` → `ETag`; `ListPartsCommand({ Bucket, Key, UploadId })` → `Parts[{ PartNumber, ETag, Size }]` (max 1,000 per page); `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })`; `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`.
- **Objects:** `PutObjectCommand({ Bucket, Key, Body, ContentType })`, `GetObjectCommand({ Bucket, Key, Range?, ResponseContentDisposition? })`, `HeadObjectCommand`, `DeleteObjectCommand`.
- **Limits (MinIO docs):** ≤ 10,000 parts per upload; each part 5 MiB–5 TiB except the last; AWS S3 single PUT ≤ 5 GiB (hence multipart for 10 GiB).

### @aws-sdk/s3-request-presigner

_TD: phase-03-videos/TD-02, TD-04, TD-06, TD-09_

- `getSignedUrl(client, command, { expiresIn })` — `expiresIn` in seconds, default **900**. Works for any command (`UploadPartCommand` for direct part uploads, `GetObjectCommand` for stream/download).
- The signature covers the **host** of the client's endpoint: sign with a client whose `endpoint` is the host the consumer will call (public endpoint for browsers, internal Compose host for the worker's ffprobe/ffmpeg).
- Download filename: `GetObjectCommand({ …, ResponseContentDisposition: 'attachment; filename="…"' })` is baked into the signed query string.
