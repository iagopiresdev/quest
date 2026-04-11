# quest-runner

CLI-first worker registry and quest planner for parallel agent execution.

`quest-runner` is designed for agents first:
- machine-readable JSON input and output
- no daemon required for correctness
- local state stored outside the repo
- conservative planning around worker capacity and file ownership

Engineering guidance for future work lives in [docs/engineering-guide.md](./docs/engineering-guide.md).

## Worker Backends

Current adapters:
- `dry-run` via `runs execute --dry-run`
- `local-command` for real local subprocess execution

Example `local-command` worker:

```json
{
  "id": "ember",
  "name": "Ember",
  "title": "Battle Engineer",
  "class": "engineer",
  "enabled": true,
  "backend": {
    "runner": "codex",
    "profile": "gpt-5.4",
    "adapter": "local-command",
    "command": ["bun", "./worker.ts"],
    "toolPolicy": { "allow": ["git"], "deny": [] }
  },
  "persona": {
    "voice": "terse",
    "approach": "test-first",
    "prompt": "Keep diffs tight and explicit."
  },
  "stats": {
    "coding": 82,
    "testing": 77,
    "docs": 44,
    "research": 51,
    "speed": 63,
    "mergeSafety": 79,
    "contextEndurance": 58
  },
  "resources": {
    "cpuCost": 2,
    "memoryCost": 3,
    "gpuCost": 0,
    "maxParallel": 1
  },
  "trust": {
    "rating": 0.74,
    "calibratedAt": "2026-04-11T00:00:00Z"
  },
  "progression": {
    "level": 7,
    "xp": 1840
  },
  "tags": ["typescript"]
}
```

The command receives a JSON payload on stdin with the run, slice, slice state, and worker metadata. Its stdout/stderr and exit code are persisted into run logs.
Execution happens from the slice workspace path for that run, and the process also gets:
- `QUEST_RUN_ID`
- `QUEST_SLICE_ID`
- `QUEST_WORKER_ID`
- `QUEST_WORKSPACE`
- `QUEST_WORKSPACE_ROOT`
- `QUEST_SLICE_WORKSPACE`

## Tester Lane

Each slice can define `acceptanceChecks`. After the worker command succeeds, Quest Runner executes those checks in order and persists their results into slice logs.

If any check exits non-zero:
- the slice becomes `failed`
- the run becomes `failed`
- `runs execute` exits non-zero
- `runs logs` shows both the worker output and the failing check result

## Commands

```sh
# upsert a worker from stdin JSON
cat worker.json | bun ./src/cli.ts workers upsert --stdin

# list workers
bun ./src/cli.ts workers list

# plan a quest from stdin JSON
cat spec.json | bun ./src/cli.ts plan --stdin

# plan a quest from file
bun ./src/cli.ts plan --file ./spec.json

# create and persist a quest run
cat spec.json | bun ./src/cli.ts run --stdin

# list persisted quest runs
bun ./src/cli.ts runs list

# inspect one persisted quest run
bun ./src/cli.ts runs status --id quest-abc12345-deadbeef

# execute a persisted run with the built-in dry-run adapter
bun ./src/cli.ts runs execute --id quest-abc12345-deadbeef --dry-run

# inspect persisted slice logs/output
bun ./src/cli.ts runs logs --id quest-abc12345-deadbeef

# abort a pending or running run
bun ./src/cli.ts runs abort --id quest-abc12345-deadbeef

# create a fresh run from a prior run's spec
bun ./src/cli.ts runs rerun --id quest-abc12345-deadbeef

# optional: compile a standalone Bun executable
bun run build
./dist/quest runs list
```

## State

Defaults:
- state root: `~/.quest-runner`
- worker registry: `~/.quest-runner/workers.json`
- runs root: `~/.quest-runner/runs`
- workspaces root: `~/.quest-runner/workspaces`

Overrides:
- `QUEST_RUNNER_STATE_ROOT`
- `QUEST_RUNNER_WORKER_REGISTRY_PATH`
- `QUEST_RUNNER_RUNS_ROOT`
- `QUEST_RUNNER_WORKSPACES_ROOT`
- `--registry <path>`
- `--runs-root <path>`
- `--workspaces-root <path>`
- `--state-root <path>`

Do not commit runtime state, tokens, or local config.

## Current v0 scope

- typed worker registry
- typed quest specs and conservative wave planning
- persisted quest runs plus run events
- dry-run execution path for exercising run state transitions
- persisted slice output logs and basic control commands (`runs logs`, `runs abort`)
- real local subprocess execution through the `local-command` adapter
- slice-level tester lane through `acceptanceChecks`
- basic steering commands to abort and rerun runs
- runtime-managed per-run and per-slice workspace directories

Additional runner adapters, git worktrees, merge/integration, notifications, and richer steering are still pending.

## Validation

```sh
bun install
bun run lint
bun run typecheck
bun test
bun run test:coverage
bun run build
```

## Linting

This repo uses Biome for formatting, import organization, and linting.

```sh
bun run lint
bun run lint:fix
bun run format
bun run test:coverage
```
