---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-28T17:21:21-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T17:20:35-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide mandates local-filesystem storage; phase requires real S3/MinIO"
    resolved_by: clarification
  - id: AMB-1
    status: resolved
    summary: "Resume after connection loss (project-plan §4) — in scope for phase 03?"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Accepted upload formats undefined (MIME/container allow-list vs ffprobe)"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Download bullet does not say which file is served (original upload)"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "No TD for storage growth: abandoned multipart uploads and stale drafts"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Background Job Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Upload Strategy for Files up to 10GB"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — S3 Client Library"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Bucket and Object Key Organization and Access"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Video Worker Runtime and Deployment"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — FFmpeg Invocation and Processing Strategy"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Video Status Lifecycle and Failure Handling"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Unique Video URL Identifier"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Playback Access Policy in Phase 03"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Job Enqueue Consistency and Idempotency"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Cleanup of Abandoned Uploads and Stale Drafts"
    resolved_by: phase-03-videos/TD-12
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-12)_ — No TD for storage growth: abandoned multipart uploads and stale drafts. Added TD-12 via /research; context.md regenerated.
- **IC-1** _(resolved_by clarification)_ — Testing guide mandates local-filesystem storage; phase requires real S3/MinIO. User answer: Integration/E2E tests run against the real MinIO service from Compose; the testing guide's storage strategy (`references/external-systems.md`) is updated in this phase to "Object Storage — Real (Docker MinIO)".
- **AMB-1** _(resolved_by clarification)_ — Resume after connection loss (project-plan §4) — in scope for phase 03?. User answer: Resume is in scope: the plan must include an owner-only endpoint that lists the parts already stored (ListParts) and re-signs URLs for the missing parts.
- **AMB-2** _(resolved_by clarification)_ — Accepted upload formats undefined (MIME/container allow-list vs ffprobe). User answer: Initiate accepts any declared MIME type starting with `video/` (plus size ≤ 10 GiB); content is validated by ffprobe in the worker — non-video content ends as `failed`.
- **AMB-3** _(resolved_by clarification)_ — Download bullet does not say which file is served (original upload). User answer: Download serves the original uploaded file, with its original file name in `Content-Disposition`.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 pending — Background Job Queue Technology. Decision: A (BullMQ on Redis).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 pending — Upload Strategy for Files up to 10GB. Decision: C (Direct-to-storage S3 multipart with presigned part URLs).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 pending — S3 Client Library. Decision: A (AWS SDK v3 — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 pending — Bucket and Object Key Organization and Access. Decision: A (Single private bucket, per-video key prefix, presigned access).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 pending — Video Worker Runtime and Deployment. Decision: A (Same codebase, separate entrypoint and Compose service).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 pending — FFmpeg Invocation and Processing Strategy. Decision: A (Spawn ffprobe/ffmpeg via execFile reading a presigned URL).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 pending — Video Status Lifecycle and Failure Handling. Decision: A (Single enum `draft → processing → ready | failed` with bounded retries).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 pending — Unique Video URL Identifier. Decision: B (Random 11-char base64url slug with unique index).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 pending — Streaming and Download Delivery. Decision: A (302 redirect to short-lived presigned GET URLs).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 pending — Playback Access Policy in Phase 03. Decision: A (Public-by-link for `ready` videos; owner-only otherwise).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 pending — Job Enqueue Consistency and Idempotency. Decision: A (Deterministic job id + idempotent worker).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 pending — Cleanup of Abandoned Uploads and Stale Drafts. Decision: B (Scheduled sweeper queue job).
