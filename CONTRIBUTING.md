# Contributing to Raspechatka OS

Development is parallelized through short-lived feature branches and Pull Requests.

## Standard workflow

1. Start from the latest `origin/version-16`.
2. Create `codex/<task-slug>`.
3. Implement one bounded module task.
4. Run Python, JSON and frontend checks described in `AGENTS.md`.
5. Open a Pull Request into `version-16`.
6. Wait for CI and integration review.
7. Deploy only after the change is present in `version-16`.

Do not use `version-16` as a working branch. Do not force-push it.

## Integration

An integration agent is explicitly assigned by the user and works in `codex/integration-<scope>`. The agent:

- combines approved feature PRs;
- resolves shared-file conflicts;
- verifies patches and access rules;
- runs the full frontend build;
- commits generated bundles;
- performs the final regression check;
- merges into `version-16`.

The local or hosted Raspechatka OS instance pulls only `version-16`.

See `AGENTS.md` for module ownership, security constraints and the mandatory handoff format.
