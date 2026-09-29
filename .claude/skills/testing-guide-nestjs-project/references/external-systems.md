> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real (Docker MinIO)

**Strategy:** Real S3-compatible storage via the Compose `minio` service (bucket created by `minio-init`). S3 in production — same `StorageService`, only the `S3_*` env changes. No filesystem adapter: presigned multipart uploads and HTTP range reads only exist on a real S3 API.

**Setup pattern:**
```typescript
Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
    StorageModule,
  ],
});
```

**Presigned URLs from inside the container:** client-facing URLs are signed for `S3_PUBLIC_ENDPOINT` (`http://localhost:9000`), which is unreachable from the `nestjs-api` container. Use `requestPresigned()` from `src/test/storage-http.ts`: it connects to `S3_ENDPOINT` (`minio:9000`) while sending the signed `Host` header — exactly what a browser on the host sends.

```typescript
const url = await storage.presignUploadPart(key, uploadId, 1, 300);
const res = await requestPresigned(url, { method: 'PUT', body: bytes });
expect(res.status).toBe(200); // res.headers.etag feeds CompleteMultipartUpload
```

**Test isolation:** use unique keys per test (`test/${randomUUID()}/original`, or the video id); abort multipart uploads a test leaves open. Sample videos come from `generateSampleVideo()` (`src/test/sample-video.ts`, FFmpeg `lavfi`).

---

## Message Queue — Real (Docker Redis + BullMQ)

**Strategy:** Real BullMQ on the Compose `redis` service. The `video-worker` container consumes the default queue, so tests must decide who consumes:

- **Producer / service integration tests** register their own root connection with an isolated prefix so the running worker never steals their jobs, and assert on the queue directly:
```typescript
BullModule.forRoot({
  connection: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT ?? 6379) },
  prefix: 'bull-test',
}),
// ...
const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
const job = await queue.getJob(videoId); // jobId = videoId
await queue.obliterate({ force: true }); // cleanup (beforeEach/afterAll)
```
- **Consumer logic** (processor / processing service) is tested by calling the service method directly (`VideoProcessingService.process(videoId)`) with real DB + MinIO + FFmpeg; the processor's retry/failure mapping is a unit test.
- **Full pipeline E2E** (`test/video-pipeline.e2e-spec.ts`) uses the default prefix on purpose: the Compose `video-worker` must be running (`docker compose up -d`) and the test polls `GET /videos/:slug` until `ready`/`failed`.

`Test.createTestingModule(...).compile()` does not run `onModuleInit`, so compiling a module that declares a `@Processor()` does not start a consumer.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
