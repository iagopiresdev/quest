# quest-runner

CLI-first worker registry and quest planner for parallel agent execution.

`quest-runner` is designed for agents first:
- machine-readable JSON input and output
- no daemon required for correctness
- local state stored outside the repo
- conservative planning around worker capacity and file ownership
- event-driven observability with optional sinks such as webhooks

CLI output modes:
- JSON remains the stable automation contract
- interactive terminals default to a readable text view
- `--json` forces machine output
- `--pretty` forces human-readable output
- `bun run lint` now also fails on circular imports in `src/**`

Engineering guidance for future work lives in [docs/engineering-guide.mdx](./docs/engineering-guide.mdx).
Project structure, spec-driven workflow, and documentation rules live in [docs/design-system.mdx](./docs/design-system.mdx).
Future roadmap notes for the training-ground system live in [docs/specs/training-grounds-v2.mdx](./docs/specs/training-grounds-v2.mdx).

Testing rule:
- mocked coverage is not enough for execution-facing work
- runner, steering, integration, and sink changes should also be battle-tested through disposable real canaries when the backend exists locally

Mintlify powers the docs surface for this repo. Local preview runs from the project root with:

```sh
bun run docs:dev
```

## Worker Backends

Current adapters:
- `dry-run` via `runs execute --dry-run`
- `local-command` for real local subprocess execution
- `codex-cli` for native Codex CLI execution with optional native login, env-var auth, or keychain-backed secret lookup
- `hermes-api` for Hermes/OpenAI-compatible HTTP execution with controlled owned-path file writes

Current built-in worker evaluation:
- `training-grounds-v1` calibration suite for scoring a worker on throwaway coding, testing, and docs tasks

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

Example `codex-cli` worker:

```json
{
  "id": "ember-codex",
  "name": "Ember Codex",
  "title": "Battle Engineer",
  "class": "engineer",
  "enabled": true,
  "backend": {
    "runner": "codex",
    "profile": "gpt-5.4",
    "adapter": "codex-cli",
    "runtime": {
      "reasoningEffort": "high",
      "maxOutputTokens": 12000,
      "temperature": 0.2,
      "topP": 0.9,
      "contextWindow": 240000,
      "providerOptions": {
        "model_provider": "\"responses\""
      }
    },
    "auth": {
      "mode": "native-login"
    },
    "toolPolicy": { "allow": [], "deny": [] }
  },
  "persona": {
    "voice": "terse",
    "approach": "finish the change with minimal churn",
    "prompt": "Keep diffs narrow and state residual risks briefly."
  },
  "stats": {
    "coding": 85,
    "testing": 70,
    "docs": 40,
    "research": 40,
    "speed": 60,
    "mergeSafety": 80,
    "contextEndurance": 60
  },
  "resources": {
    "cpuCost": 1,
    "memoryCost": 1,
    "gpuCost": 0,
    "maxParallel": 1
  },
  "trust": {
    "rating": 0.8,
    "calibratedAt": "2026-04-11T00:00:00Z"
  },
  "progression": {
    "level": 1,
    "xp": 0
  },
  "tags": ["codex"]
}
```

`codex-cli` runs `codex exec` inside the slice workspace, persists Codex stdout/stderr, and captures the final response through `--output-last-message`.
The prompt includes owned paths, dependencies, and acceptance-check summaries. It shows exact argv for known safe test and build tools so runners do not have to guess common commands, while still redacting generic command payloads and all env override values.
Common runtime controls such as reasoning effort, output-token limits, sampling, and context window live under `backend.runtime`, and Quest Runner translates them into Codex `-c key=value` overrides when it starts `codex exec`.
If a Codex-specific knob does not have a first-class runtime field yet, put it in `backend.runtime.providerOptions`.

Auth modes for `codex-cli`:
- `native-login`: reuse the local `codex login` session
- `env-var`: copy a named env var into the target subprocess env
- `secret-store`: load a named secret from the OS keychain backend

For `native-login`, Quest Runner probes `codex login status` before execution so a missing or broken local session fails fast as a runner-availability problem instead of surfacing later as a partial run failure.

Example `hermes-api` worker:

```json
{
  "id": "ember-hermes",
  "name": "Ember Hermes",
  "title": "Arcane Engineer",
  "class": "sage",
  "enabled": true,
  "backend": {
    "runner": "hermes",
    "profile": "hermes-local",
    "adapter": "hermes-api",
    "baseUrl": "http://127.0.0.1:8000/v1",
    "runtime": {
      "reasoningEffort": "medium",
      "maxOutputTokens": 4096,
      "temperature": 0.3,
      "topP": 0.8,
      "providerOptions": {
        "frequency_penalty": "0.5"
      }
    },
    "toolPolicy": { "allow": [], "deny": [] }
  },
  "persona": {
    "voice": "precise",
    "approach": "analyze carefully and return precise file updates",
    "prompt": "Return only the exact file updates needed for the slice."
  },
  "stats": {
    "coding": 78,
    "testing": 82,
    "docs": 35,
    "research": 48,
    "speed": 55,
    "mergeSafety": 72,
    "contextEndurance": 62
  },
  "resources": {
    "cpuCost": 1,
    "memoryCost": 2,
    "gpuCost": 1,
    "maxParallel": 1
  },
  "trust": {
    "rating": 0.75,
    "calibratedAt": "2026-04-11T00:00:00Z"
  },
  "progression": {
    "level": 1,
    "xp": 0
  },
  "tags": ["hermes"]
}
```

`hermes-api` calls an OpenAI-compatible `/chat/completions` endpoint, asks Hermes for a strict JSON write plan, and applies only owned-path writes inside the slice workspace. The runner rejects responses that try to write outside the owned paths or escape the slice workspace.
For Hermes, the same `backend.runtime` object maps onto request-body controls such as `max_tokens`, `temperature`, `top_p`, `reasoning_effort`, and provider-specific extra request fields from `providerOptions`.

If the run has `--source-repo <path>`, Quest Runner materializes each slice workspace as a detached Git worktree from that repository before the worker starts. Source repositories must be clean; dirty working trees fail fast with a typed error instead of silently forking from stale or partial state.
Workspace cleanup is explicit through `runs cleanup`; Quest Runner does not auto-delete workspaces after execution.
Completed runs can then be integrated serially with `runs integrate`, which replays slice results into a dedicated integration worktree instead of mutating the user’s main checkout directly.
Top-level spec `acceptanceChecks` run in that integration worktree after slices are replayed. If they fail, integration exits non-zero and the recorded integration checks stay on the run for inspection.
Acceptance checks are structured argv commands, not shell strings. Example:

```json
{
  "argv": ["bun", "-e", "console.log('ok')"],
  "env": {}
}
```

## Tester Lane

Each slice can define `acceptanceChecks`. After the worker command succeeds, Quest Runner executes those argv-defined checks in order and persists their results into slice logs.

If any check exits non-zero:
- the slice becomes `failed`
- the run becomes `failed`
- `runs execute` exits non-zero
- `runs logs` shows both the worker output and the failing check result

## Observability

Runs emit typed events. Observability is the layer that persists and dispatches those events to sinks.

Current sink support:
- `webhook`
- `telegram`

Internally, sinks already live behind a typed sink model instead of a webhook-only config shape. That keeps the current webhook path simple while leaving room for future Telegram, Linear, Slack, or metrics sinks without rewriting delivery storage.

The core model is:
- run or calibration emits an event
- observability dedupes and records delivery attempts
- sinks react to the event

This matters because webhook delivery is only the first consumer. The same event stream should support future sinks such as Telegram, Linear, Slack, or metrics without changing the run model itself.

Delivery records keep the observable payload snapshot that was sent to the sink. That gives operators a stable audit trail and lets Quest Runner retry failed deliveries without needing to reconstruct the original event from a possibly-mutated local state tree.

## Worker Calibration

`quest workers calibrate` reuses the normal run planner and executor against a throwaway fixture repo under the calibrations root. The current built-in suite is `training-grounds-v1`.

The suite is intentionally made of independent slices. Calibration slices must be solvable from a clean base because Quest Runner isolates slice workspaces; later slices do not inherit file changes from earlier ones unless integration happens.

Calibration results are written back onto the worker record:
- calibration history entry with suite id, run id, score, and per-discipline scores
- updated trust rating and `calibratedAt` timestamp
- XP gain when the suite passes

## Commands

```sh
# install a stable local quest command
bun run install:local

# bootstrap state paths and optionally create the first Codex worker
quest setup --yes

# bootstrap a Hermes worker instead
quest setup --yes --backend hermes --hermes-base-url http://127.0.0.1:8000/v1

# upsert a worker from stdin JSON
cat worker.json | quest workers upsert --stdin

# add a Codex worker from flags instead of hand-writing worker JSON
quest workers add codex \
  --name "Quest Codex" \
  --profile gpt-5.4 \
  --coding 90 \
  --testing 72 \
  --merge-safety 84 \
  --reasoning-effort high \
  --max-output-tokens 12000 \
  --temperature 0.2 \
  --top-p 0.9 \
  --context-window 240000 \
  --provider-option 'model_provider="responses"'

# add a Hermes worker from flags
quest workers add hermes \
  --name "Quest Hermes" \
  --base-url http://127.0.0.1:8000/v1 \
  --profile hermes-local \
  --testing 92 \
  --gpu-cost 1 \
  --reasoning-effort medium \
  --max-output-tokens 4096 \
  --temperature 0.3 \
  --top-p 0.8 \
  --provider-option frequency_penalty=0.5

# inspect one worker with strengths and calibration summary
quest workers status --id quest-codex

# inspect the whole worker roster
quest workers summary

# inspect one worker's calibration history
quest workers history --id quest-codex

# tune a worker after calibration or real runs
quest workers update \
  --id quest-codex \
  --coding 95 \
  --testing 80 \
  --trust-rating 0.84 \
  --profile gpt-5.4-mini

# list configured observability sinks
quest observability sinks list

# list normalized events for a run
quest observability events list --run-id quest-abc12345-deadbeef

# inspect stored delivery attempts
quest observability deliveries list --status failed

# add or update a webhook sink
quest observability webhook upsert \
  --id local-webhook \
  --url https://example.com/quest-events \
  --events run_failed,run_completed,worker_calibration_recorded

# add or update a Telegram sink
quest observability telegram upsert \
  --id local-telegram \
  --chat-id 123456 \
  --bot-token-secret-ref telegram.bot \
  --events run_failed,run_completed

# retry failed webhook deliveries after the sink is healthy again
quest observability deliveries retry --sink-id local-webhook --status failed

# delete a sink
quest observability sinks delete --id local-webhook

# list built-in calibration suites
quest workers calibrate --list-suites

# run the default training-grounds calibration for one worker
quest workers calibrate --id quest-codex

# list workers
quest workers list

# plan a quest from stdin JSON
cat spec.json | quest plan --stdin

# plan using only one registered worker
cat spec.json | quest plan --stdin --worker-id quest-codex

# explain why workers rank the way they do for each slice
cat spec.json | quest plan --stdin --explain

# plan a quest from file
quest plan --file ./spec.json

# create and persist a quest run
cat spec.json | quest run --stdin

# force a run onto one registered worker
cat spec.json | quest run --stdin --worker-id quest-codex

# create a run that will materialize slice workspaces from a git repo
cat spec.json | quest run --stdin --source-repo /abs/path/to/repo

# list persisted quest runs
quest runs list

# inspect one persisted quest run
quest runs status --id quest-abc12345-deadbeef

# inspect a compact run summary
quest runs summary --id quest-abc12345-deadbeef

# execute a persisted run with the built-in dry-run adapter
quest runs execute --id quest-abc12345-deadbeef --dry-run

# execute a persisted run and backfill a source repo for worktree materialization
quest runs execute --id quest-abc12345-deadbeef --source-repo /abs/path/to/repo

# integrate a completed run into a dedicated integration worktree
quest runs integrate --id quest-abc12345-deadbeef --target-ref main

# inspect persisted slice logs/output
quest runs logs --id quest-abc12345-deadbeef

# put a run on hold before the next execute call
quest runs pause --id quest-abc12345-deadbeef --reason "waiting on review"

# resume a paused run
quest runs resume --id quest-abc12345-deadbeef

# reassign one slice to a different worker
quest runs slices reassign --id quest-abc12345-deadbeef --slice parser --worker-id quest-hermes

# retry only one failed slice in place
quest runs slices retry --id quest-abc12345-deadbeef --slice parser

# skip one slice and mark it as a no-op for integration
quest runs slices skip --id quest-abc12345-deadbeef --slice parser --reason "handled elsewhere"

# store a backend secret in the local keychain backend
printf 'sk-example' | quest secrets set --name codex.api --stdin

# inspect whether a keychain secret exists
quest secrets status --name codex.api

# delete a stored secret
quest secrets delete --name codex.api

# verify the local operator/runtime prerequisites
quest doctor

# remove quest-managed workspaces for a run
# completed source-repo runs must be integrated before cleanup
# aborted source-repo runs can be cleaned directly
quest runs cleanup --id quest-abc12345-deadbeef

# abort a pending or running run
quest runs abort --id quest-abc12345-deadbeef

# create a fresh run from a prior run's spec
quest runs rerun --id quest-abc12345-deadbeef

# rerun a prior run but force a different worker
quest runs rerun --id quest-abc12345-deadbeef --worker-id quest-codex

# optional: compile a standalone Bun executable
bun run build
./dist/quest runs list

# development fallback if you do not want to install the wrapper
./bin/quest runs list
```

## State

Defaults:
- state root: `~/.quest-runner`
- worker registry: `~/.quest-runner/workers.json`
- runs root: `~/.quest-runner/runs`
- workspaces root: `~/.quest-runner/workspaces`
- calibrations root: `~/.quest-runner/calibrations`
- observability config: `~/.quest-runner/observability/config.json`
- observability deliveries: `~/.quest-runner/observability/deliveries.json`
- secret-store service name: `quest-runner`

Overrides:
- `QUEST_RUNNER_STATE_ROOT`
- `QUEST_RUNNER_WORKER_REGISTRY_PATH`
- `QUEST_RUNNER_RUNS_ROOT`
- `QUEST_RUNNER_WORKSPACES_ROOT`
- `QUEST_RUNNER_CALIBRATIONS_ROOT`
- `QUEST_RUNNER_OBSERVABILITY_CONFIG_PATH`
- `QUEST_RUNNER_OBSERVABILITY_DELIVERIES_PATH`
- `QUEST_RUNNER_SECRET_STORE_SERVICE_NAME`
- `--registry <path>`
- `--runs-root <path>`
- `--workspaces-root <path>`
- `--calibrations-root <path>`
- `--state-root <path>`

Do not commit runtime state, tokens, or local config.

## Current v0 scope

- typed worker registry
- setup command for bootstrapping state paths and the first Codex worker
- setup support for Codex or Hermes workers
- typed quest specs and conservative wave planning
- explicit worker forcing for plan/run/rerun flows
- persisted quest runs plus run events
- dry-run execution path for exercising run state transitions
- persisted slice output logs and basic control commands (`runs logs`, `runs abort`)
- real local subprocess execution through the `local-command` adapter
- native Codex execution through the `codex-cli` adapter
- Hermes/OpenAI-compatible execution through the `hermes-api` adapter
- slice-level tester lane through `acceptanceChecks`
- richer steering commands for pause/resume plus per-slice reassign/retry/skip
- runtime-managed per-run and per-slice workspace directories
- optional Git worktree materialization via `--source-repo`
- serial integration into a dedicated worktree via `runs integrate`
- integration-time execution of top-level `acceptanceChecks`
- resume-safe `runs integrate` when the existing integration worktree is clean
- explicit workspace cleanup via `runs cleanup`
- cleanup confinement under the configured workspaces root
- local keychain-backed secret storage for runner auth
- built-in worker calibration through the throwaway `training-grounds-v1` suite
- persisted calibration history, trust updates, and XP awards on workers
- event-driven observability with a webhook sink
- Telegram sink delivery through the same eventing model
- persisted webhook delivery records with payload snapshots for dedupe, audit, and retries

Additional runner adapters, more sinks, feature-doc generation, and a fuller setup TUI are still pending.

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
