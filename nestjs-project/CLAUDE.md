# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, object storage, queue, video worker) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis (queue):** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO (object storage):** `docker compose exec nestjs-api curl -s -o /dev/null -w '%{http_code}' http://minio:9000/minio/health/live` — expect `200`; `docker compose ps -a minio-init` must show `Exited (0)` (bucket created)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started — consuming "video-processing"` (it waits for `node_modules` on a fresh clone, so run `npm install` first)

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (FFmpeg installed in the image — used by tests)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, ports `1025` (SMTP) / `8025` (UI/API)
- `minio` — S3-compatible object storage (`cgr.dev/chainguard/minio`), ports `9000` (S3 API) / `9001` (console), credentials `S3_ACCESS_KEY` / `S3_SECRET_KEY`
- `minio-init` — one-shot job that creates the `S3_BUCKET` bucket (exits `0`)
- `redis` — Redis 8 for BullMQ, port `6379` (AOF on, `noeviction`)
- `video-worker` — video processing worker: same image/code as `nestjs-api`, runs `npm run start:worker:dev` (no HTTP)

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Run the compiled video worker (dist/worker.js)
npm run start:worker:dev                 # Video worker in watch mode (what the video-worker service runs)
npm run openapi:export                   # Regenerate openapi.json

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (script already passes --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos (Phase 03 — upload and processing)

Plan and decisions: `docs/phases/phase-03-videos/phase-03-videos.md`, `docs/decisions/technical-decisions-phase-03-videos.md`.

**Modules**

- `src/videos/` — `VideosModule`: `Video` entity (`videos` table, belongs to a channel), `VideosService` (pre-registration, resume, completion, visibility, status transitions), `VideosController`, DTOs. Registers the `video-processing` queue (producer only).
- `src/storage/` — `StorageService` over `@aws-sdk/client-s3`: multipart create/presign/list/complete/abort, `putObject`, presigned GETs. Two clients: `S3_ENDPOINT` (internal) and `S3_PUBLIC_ENDPOINT` (the host signed into URLs handed to clients).
- `src/queue/` — `QueueModule`: BullMQ root connection (`REDIS_HOST`/`REDIS_PORT`) and default job options (3 attempts, exponential backoff).
- `src/video-processing/` — worker side only: `VideoProcessingProcessor` (`@Processor('video-processing')`), `VideoProcessingService` (ffprobe metadata + thumbnail), `MediaToolsService` (`execFile` of `ffprobe`/`ffmpeg` over presigned URLs), `UploadSweeperService` (hourly expiry of abandoned uploads).
- `src/worker.ts` + `src/worker.module.ts` — worker entrypoint (`createApplicationContext`, no HTTP). `AppModule` never imports `VideoProcessingModule`; `RootConfigModule` and `DatabaseModule` are shared by both roots.

**Endpoints** (`/videos`, identified by an 11-char `slug`; `@SkipThrottle()` on the controller)

| Method | Path | Auth | Result |
|--------|------|------|--------|
| POST | `/videos` | Bearer | 201 — draft video + presigned part URLs (`file_size` ≤ 10 GiB, `mime_type` `video/*`) |
| GET | `/videos/:slug/upload` | Bearer (owner) | 200 — uploaded parts + URLs for missing parts (resume) |
| POST | `/videos/:slug/upload/complete` | Bearer (owner) | 202 — completes multipart, status `processing`, enqueues `process-video` |
| GET | `/videos/:slug` | Public (optional Bearer) | 200 — `ready` for anyone; other statuses only for the owner (404 otherwise) |
| GET | `/videos/:slug/stream` | Public (optional Bearer) | 302 → presigned GET of the original (storage answers `Range` with 206) |
| GET | `/videos/:slug/download` | Public (optional Bearer) | 302 → presigned GET with `Content-Disposition: attachment` |

On `@Public()` routes `JwtAuthGuard` attaches `request.user` when a valid Bearer token is sent and ignores invalid tokens (optional auth). Error codes: `VIDEO_FILE_TOO_LARGE`, `VIDEO_NOT_FOUND`, `VIDEO_NOT_UPLOADABLE`, `INVALID_UPLOAD_PARTS`, `VIDEO_PROCESSING_UNAVAILABLE`, `VIDEO_NOT_READY` (`src/common/exceptions/domain.exception.ts`).

**Lifecycle** — `draft` (upload in progress) → `processing` (upload completed, job queued) → `ready` | `failed` (`failure_reason`: `INVALID_MEDIA` — not a video, no retries; `PROCESSING_ERROR` — 3 attempts exhausted; `UPLOAD_EXPIRED` — draft older than `VIDEO_UPLOAD_WINDOW_HOURS`).

**Queue jobs** (queue `video-processing`, consumed by `video-worker`): `process-video` `{ videoId }` with `jobId = videoId` (idempotent consumer); `sweep-expired-uploads` via job scheduler every hour (registered when the worker boots).

**Storage keys** (single private bucket `S3_BUCKET`): `videos/{id}/original`, `videos/{id}/thumbnail.jpg`. All reads go through short-lived presigned URLs.

**Env keys** (Joi-validated, defaults in `src/config/env.validation.ts`): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `REDIS_HOST`, `REDIS_PORT`, `VIDEO_MAX_UPLOAD_BYTES`, `VIDEO_UPLOAD_PART_SIZE_BYTES` (≥ 5 MiB), `VIDEO_UPLOAD_URL_TTL_SECONDS`, `VIDEO_PLAYBACK_URL_TTL_SECONDS`, `VIDEO_UPLOAD_WINDOW_HOURS`.

**Testing notes** — storage and queue are tested against the real Compose services (see `.claude/skills/testing-guide-nestjs-project/references/external-systems.md`): presigned URLs are exercised with `src/test/storage-http.ts`; service-level queue tests use the BullMQ prefix `bull-test` so `video-worker` does not consume them; `test/video-pipeline.e2e-spec.ts` requires `video-worker` running and uses `src/test/sample-video.ts` to generate MP4s with FFmpeg.

