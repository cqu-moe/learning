# LEARNING-02 implementation plan

Goal: prove shipped standalone read-only exports and interrupted downloads at the CLI, SQLite and file boundaries.
Spec: workspace docs/e2e/specs/learning.md and tickets/LEARNING-02.md.
Base: e9cd8a633d744e328d6f79f9d2b7e434c5e8e2e0. Only this ticket worktree is editable; the requested root result is the sole shared report.

The existing spec and ticket are the approved to-spec and to-tickets outputs. This file refines implement-spec without another confirmation. Node24.11.1/pnpm11.19.0 remain development tools; Bun1.4.3 builds the real release executable. Keep empty child PATH, TLS verification and the existing macOS proxy-only sandbox. Never import production SDK into the binary runner, preload Transport, seed sessions/jobs/checkpoints, or access real accounts.

## Tasks

- [x] Extend the LEARNING-01 HTTPS/CONNECT fixture at its external boundary with strict query/body matching, the actual exam hostname, and controlled streaming responses. Preserve existing catalog coverage.
- [x] Add shipped-binary read-only export journeys. Login through public commands, fetch courses/outline into real SQLite, export both providers' supported assessments, embedded read-only draft, slide images/PDF, direct media/HLS/subtitles. Independently inspect bytes, JSON/YAML and PDF rendered pages.
- [x] Interrupt real streams/processes, observe persisted checkpoints without modifying them, then resume in a new process. Test matching 206, ignored Range, validator change and 416. Check no partial publication, byte hashes, checkpoint retirement and public jobs readback.
- [x] Test unavailable resources, unsupported HLS, PDF limits/conversion failure, storage failure and cancellation. If production fails, capture the original binary failure, repair only the owner, rebuild and rerun.
- [x] Add two clean runs, fault controls and strict cleanup to all five native CI targets. Run focused existing gates, retain sanitized append-only evidence, sync current integration into this branch, check effective Git identity/signing, create a signed commit, and write the root result. No push/PR/integration edits.

## Test audit / ownership

Each new test owns a public standalone-process contract absent from the internal media/render tests and preload/seed-based legacy consumer E2E. External fixtures supply protocol input, never successful task state. CLI jobs/show and independent read-only SQLite/filesystem inspection establish persistence. No test-only production seam is allowed.

Review focus:
1. PNG page reordering or damaged image: independent PDF RGB pixels and page count; invalid PNG must fail without a PDF.
2. Partial media survives process death: actual checkpoint and prefix bytes observed, new process requests exact Range/If-Range, final hash matches fixed synthetic data.
3. Changed/ignored range and 416: fresh bytes replace old prefix; no concatenation of different representations.
4. HLS partial segment: restart at last committed segment and exclude uncommitted tail; unsupported encryption/byte range remains explicit.
5. Cancellation/storage/cleanup failure: no incomplete final file; retain initial and cleanup errors, fail nonzero, kill/wait children and close listeners before removal.

No docs/agents directory exists in this repository at this base. Canvas font decoding and legacy browser slides are unimplemented and excluded; ordinary article export is not a CLI capability. Real progress reporting, answer submission, exams starting/finalization and real credentials are outside this ticket.
