---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 16
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-28T17:07:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T17:07:32-03:00"
issues:
  - id: IC-1
    status: open
    summary: "Testing guide mandates local-filesystem storage; phase requires real S3/MinIO"
  - id: AMB-1
    status: open
    summary: "Resume after connection loss (project-plan §4) — in scope for phase 03?"
  - id: AMB-2
    status: open
    summary: "Accepted upload formats undefined (MIME/container allow-list vs ffprobe)"
  - id: AMB-3
    status: open
    summary: "Download bullet does not say which file is served (original upload)"
  - id: MD-1
    status: resolved
    summary: "No TD for storage growth: abandoned multipart uploads and stale drafts"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Background Job Queue Technology"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — Upload Strategy for Files up to 10GB"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — S3 Client Library"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — Bucket and Object Key Organization and Access"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Video Worker Runtime and Deployment"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — FFmpeg Invocation and Processing Strategy"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — Video Status Lifecycle and Failure Handling"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Unique Video URL Identifier"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Streaming and Download Delivery"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Playback Access Policy in Phase 03"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Job Enqueue Consistency and Idempotency"
  - id: OQ-12
    status: open
    summary: "TD-12 pending — Cleanup of Abandoned Uploads and Stale Drafts"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `## Testing Requirements` (from `testing-guide-nestjs-project/references/external-systems.md`) states "Object Storage — Local Filesystem … In tests, use the local filesystem adapter", while the phase scope ("Serviço de armazenamento de arquivos") and the architecture (`Object Storage (S3 or MinIO)`, echoed by every storage TD — TD-02/03/04/06/09 rely on multipart uploads, presigned URLs and HTTP range reads that only an S3 API provides) require a real S3-compatible service. A filesystem adapter cannot exercise presigned multipart uploads or range requests. Explicit choice: (a) tests run against the real MinIO service from Compose and the testing guide's storage strategy is updated in this phase; (b) keep the filesystem adapter for tests and add an S3 adapter only for runtime (presigned/multipart paths untested).

### Ambiguities

- **AMB-1** — `docs/project-plan.md` §4 (Pontos de Atenção) says the 10GB upload must "permitir retomar em caso de falha de conexão", but the capability bullet "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" does not mention resume. It is unclear whether resuming an interrupted upload is a Phase 03 deliverable (an API surface to list uploaded parts and re-issue part URLs) or only a property the strategy must not preclude. Explicit choice: (a) resume is in scope — plan an endpoint that reports stored parts and re-signs missing ones; (b) resume is out of scope — the strategy must only allow it later.
- **AMB-2** — No capability, TD or inherited decision defines which files are accepted as video uploads. The initiate request can only validate declared metadata (name, size, MIME type) because bytes go straight to storage (TD-02 recommendation). Explicit choice: (a) accept any declared `video/*` MIME type at initiate and let ffprobe (worker) reject non-video content by marking the video `failed`; (b) enforce a fixed allow-list of containers (e.g., mp4/webm/mov/mkv) at initiate plus ffprobe validation.
- **AMB-3** — "Download do vídeo pelo usuário" does not state which file is downloaded. The phase produces no transcoded renditions (TD-06 recommendation extracts metadata and one frame only), so the only candidate is the uploaded original. Explicit choice: (a) download serves the original uploaded file with its original file name; (b) other (e.g., a normalized rendition — would require transcoding, which no TD covers).

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — Background Job Queue Technology. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-2** — TD-02 pending — Upload Strategy for Files up to 10GB. Resolution: fill the **Decision:** field of TD-02, then re-run /plan-validate phase-03-videos.
- **OQ-3** — TD-03 pending — S3 Client Library. Resolution: fill the **Decision:** field of TD-03, then re-run /plan-validate phase-03-videos.
- **OQ-4** — TD-04 pending — Bucket and Object Key Organization and Access. Resolution: fill the **Decision:** field of TD-04, then re-run /plan-validate phase-03-videos.
- **OQ-5** — TD-05 pending — Video Worker Runtime and Deployment. Resolution: fill the **Decision:** field of TD-05, then re-run /plan-validate phase-03-videos.
- **OQ-6** — TD-06 pending — FFmpeg Invocation and Processing Strategy. Resolution: fill the **Decision:** field of TD-06, then re-run /plan-validate phase-03-videos.
- **OQ-7** — TD-07 pending — Video Status Lifecycle and Failure Handling. Resolution: fill the **Decision:** field of TD-07, then re-run /plan-validate phase-03-videos.
- **OQ-8** — TD-08 pending — Unique Video URL Identifier. Resolution: fill the **Decision:** field of TD-08, then re-run /plan-validate phase-03-videos.
- **OQ-9** — TD-09 pending — Streaming and Download Delivery. Resolution: fill the **Decision:** field of TD-09, then re-run /plan-validate phase-03-videos.
- **OQ-10** — TD-10 pending — Playback Access Policy in Phase 03. Resolution: fill the **Decision:** field of TD-10, then re-run /plan-validate phase-03-videos.
- **OQ-11** — TD-11 pending — Job Enqueue Consistency and Idempotency. Resolution: fill the **Decision:** field of TD-11, then re-run /plan-validate phase-03-videos.
- **OQ-12** — TD-12 pending — Cleanup of Abandoned Uploads and Stale Drafts. Resolution: fill the **Decision:** field of TD-12, then re-run /plan-validate phase-03-videos.

### UI Coverage Gaps

_None._

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-12)_ — No TD for storage growth: abandoned multipart uploads and stale drafts. Added TD-12 via /research; context.md regenerated.
