---
name: learning-cli
description: Use an installed learning CLI for 雨课堂 (Yuketang), 学堂在线 (Xuetang), and 智慧树 (Zhihuishu) profiles, courses, exports, homework, and recovery. Discover command schemas and interpret JSON/JSONL results; not for developing the CLI itself.
---

# learning CLI for agents

## Start

1. Verify the installed command with `learning --version` and inspect the environment with `learning doctor`.
2. If `learning` is unavailable, tell the user to install the official standalone program using the project's `INSTALL.md` and Releases instructions. Do not assume this repository or a source checkout is present.
3. Discover commands locally: bare `learning` or a command group returns its command catalog. Use `learning schema <command...>` immediately before invocation for arguments, options, defaults, and required fields; do not copy a full command catalog into another document.

If the installed command lacks `schema` or emits a text menu, it predates this interface. Use the matching Agent CLI build supplied for the task or report that an upgrade is needed before operating it.

The CLI is agent-only. It does not prompt for missing input or adapt output by TTY. Stdout is one `schemaVersion: 1` JSON envelope by default; `--output-format jsonl` emits ordered events ending in `result`. `--json` is only a compatibility alias. Treat stderr diagnostic lines separately from stdout results.

## Scope and authorization

Resolve the data directory and profile explicitly. Create a profile with `learning profile add <name> --platform ykt|xuetang|zhs`; there is no `--name` option. Reuse the user's existing `--home`/profile when the task identifies it, and do not move or copy the data directory.

Do not treat `--yes` as permission. Before the first real platform read or write in a session, or before any paid model call, ensure the user explicitly authorized that scope. A request that directly asks for that operation is authorization; do not ask again. Use `--dry-run` when the user wants a preview or when the authorized next step is only inspection.

Preserve the CLI's safety behavior: profile scope and session generation, the local write lock, unique export paths, skipped/partial reporting, and uncertain-operation non-retry. Never fabricate platform success; report the envelope status, warnings, job ID, operation ID, or skipped items as returned.

## Common workflows

- Login: in JSON mode pass a new image path with `--qr-file`; in JSONL mode omit it to receive an automatically created path. Auth events expose only the path, generation, and expiry. Let the human scan the code or handle verification; cookie import still requires `whoami` validation.
- Courses: use `courses` for one profile or `--all-profiles` for aggregation. Check each result's `completeness` and warnings; `unknown` does not mean the list is exhaustive. Course cursor pagination is not implemented and has no CLI flag.
- Study: `run` requires a course/resource key and defaults to speed 1 and target 1. The SDK still enforces platform limits and pauses unknown answers.
- Homework: `homework download <course-or-resource>` requires an explicit key; add `--all` for every ordinary homework in a course. Edit the generated `answers.yaml`, preview with `--dry-run`, and submit only with the user's authorization and `--yes`. `homework apply <directory> --all` selects every draft in the directory.
- Live: `live <lesson-url> --dry-run` only previews check-in; `live <lesson-url> --yes --output-format jsonl` checks in and emits question/gap events. The CLI has no live answer submission entry point; do not claim or imply that it can answer a live question.

## Result handling

- Exit 2: fix arguments using `error.fields` and the corresponding `learning schema` output.
- Exit 3: handle login, cancellation, human verification, or an unverified capability. Do not invent credentials or answers.
- Exit 4: inspect skipped/partial items and continue only the properly authorized remaining work.
- Exit 5: run the suggested `jobs reconcile` or `operations reconcile` before any retry; an unresolved operation stays uncertain.

Report only observed outcomes. Say when something is unverified, partial, uncertain, or not run.
