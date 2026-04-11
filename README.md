# quest-runner

CLI-first worker registry and quest planner for parallel agent execution.

`quest-runner` is designed for agents first:
- machine-readable JSON input and output
- no daemon required for correctness
- local state stored outside the repo
- conservative planning around worker capacity and file ownership

## Commands

```sh
bun run build

# upsert a worker from stdin JSON
cat worker.json | bun dist/cli.js workers upsert --stdin

# list workers
bun dist/cli.js workers list

# plan a quest from stdin JSON
cat spec.json | bun dist/cli.js plan --stdin

# plan a quest from file
bun dist/cli.js plan --file ./spec.json

# create and persist a quest run
cat spec.json | bun dist/cli.js run --stdin

# list persisted quest runs
bun dist/cli.js runs list

# inspect one persisted quest run
bun dist/cli.js runs status --id quest-abc12345-deadbeef

# execute a persisted run with the built-in dry-run adapter
bun dist/cli.js runs execute --id quest-abc12345-deadbeef --dry-run
```

## State

Defaults:
- state root: `~/.quest-runner`
- worker registry: `~/.quest-runner/workers.json`
- runs root: `~/.quest-runner/runs`

Overrides:
- `QUEST_RUNNER_STATE_ROOT`
- `QUEST_RUNNER_WORKER_REGISTRY_PATH`
- `QUEST_RUNNER_RUNS_ROOT`
- `--registry <path>`
- `--runs-root <path>`
- `--state-root <path>`

Do not commit runtime state, tokens, or local config.

## Current v0 scope

- typed worker registry
- typed quest specs and conservative wave planning
- persisted quest runs plus run events
- dry-run execution path for exercising run state transitions

Real runner adapters, git worktrees, tester lane, and integration are still pending.

## Validation

```sh
bun install
bun run typecheck
bun run test
bun run build
```
