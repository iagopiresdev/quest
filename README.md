# quest-runner

CLI-first worker registry and quest planner for parallel agent execution.

`quest-runner` is designed for agents first:
- machine-readable JSON input and output
- no daemon required for correctness
- local state stored outside the repo
- conservative planning around worker capacity and file ownership

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

# optional: compile a standalone Bun executable
bun run build
./dist/quest runs list
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
bun test
bun run build
```
