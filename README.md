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

Pretty-mode vocabulary keeps the engine plain and adds light RPG flavor:
- `Briefing`
  plan and quest context
- `Party Selection`
  worker assignment and candidate ranking
- `Roster`
  worker lists and summaries
- `Encounter`
  one slice of work
- `Boss Fight`
  final integration state and checks
- `Turn-in`
  successful integrated outcome
- `Training Grounds`
  calibration output

Engineering guidance for future work lives in [docs/engineering-guide.mdx](./docs/engineering-guide.mdx).
Project structure, spec-driven workflow, and documentation rules live in [docs/design-system.mdx](./docs/design-system.mdx).
Future roadmap notes for the training-ground system live in [docs/specs/training-grounds-v2.mdx](./docs/specs/training-grounds-v2.mdx).
Worker-role planning notes live in [docs/specs/worker-role-separation-v1.mdx](./docs/specs/worker-role-separation-v1.mdx).
Auto-integration planning notes live in [docs/specs/auto-integrate-v1.mdx](./docs/specs/auto-integrate-v1.mdx).
Turn-in and recovery notes live in [docs/specs/run-turn-in-and-recovery-v1.mdx](./docs/specs/run-turn-in-and-recovery-v1.mdx).
Tester-lane planning notes live in [docs/specs/tester-lane-v1.mdx](./docs/specs/tester-lane-v1.mdx).
Fresh-install canary notes live in [docs/specs/fresh-install-canary-v1.mdx](./docs/specs/fresh-install-canary-v1.mdx).
Contribution guidance lives in [CONTRIBUTING.md](./CONTRIBUTING.md).
Security guidance lives in [SECURITY.md](./SECURITY.md).
Community expectations live in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

Testing rule:
- mocked coverage is not enough for execution-facing work
- runner, steering, integration, and sink changes should also be battle-tested through disposable real canaries when the backend exists locally
- install and setup changes should also pass a fresh-install `tmux` canary through the public `quest` command

Mintlify powers the docs surface for this repo. Local preview runs from the project root with:

```sh
bun run docs:dev
```

Fresh-install canaries:

```sh
# hermetic package-install smoke with a local-command builder/tester pair
bun ./scripts/canaries/fresh-install.ts --backend local-command

# real package-install canary through Codex
bun ./scripts/canaries/fresh-install.ts --backend codex
```

Repo-edit canaries:

```sh
bun ./scripts/canaries/repo-edit.ts --backend local-command
bun ./scripts/canaries/repo-edit.ts --backend codex
bun ./scripts/canaries/repo-edit.ts --backend openclaw

# Hermes requires a live compatible endpoint.
bun ./scripts/canaries/repo-edit.ts --backend hermes --hermes-base-url http://127.0.0.1:8000/v1
```

## Open Source Readiness

This repository is intended to be publishable on GitHub as source code, not as a dump of local state.

Rules:
- do not commit runtime state, tokens, or local config
- examples should use clearly fake placeholder values
- execution-facing changes should ship with both automated coverage and real canaries
- install/setup changes should be validated through the fresh-install `tmux` canary

## Worker Backends

Current adapters:
- `dry-run` via `runs execute --dry-run`
- `local-command` for real local subprocess execution
- `codex-cli` for native Codex CLI execution with optional native login, env-var auth, or keychain-backed secret lookup
- `hermes-api` for Hermes/OpenAI-compatible HTTP execution with controlled owned-path file writes
- `openclaw-cli` for real OpenClaw agent execution through the installed `openclaw` CLI

Current built-in worker evaluation:
- `training-grounds-v1` calibration suite for scoring a worker on throwaway coding, testing, and docs tasks

Worker roles:
- `builder`
  preferred for encounters
- `tester`
  preferred for trials
- `hybrid`
  can do both and acts as the safe fallback

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

Quest specs can now persist execution policy explicitly under `execution`, for example:

```json
{
  "version": 1,
  "title": "Feedback canary",
  "workspace": "feedback-canary",
  "execution": {
    "timeoutMinutes": 20,
    "idleTimeoutMinutes": 5,
    "testerSelectionStrategy": "balanced",
    "preInstall": true,
    "prepareCommands": [
      {
        "argv": ["bun", "install", "--frozen-lockfile"],
        "env": {}
      }
    ],
    "shareSourceDependencies": true
  },
  "slices": [
    {
      "id": "fix-status",
      "title": "Fix status",
      "discipline": "coding",
      "goal": "Update status.ts so the exported status is fixed instead of stale.",
      "description": "Keep the change minimal and rely on the workspace manifest for context.",
      "owns": ["status.ts"],
      "dependsOn": [],
      "contextHints": ["Do not create extra files."],
      "acceptanceChecks": []
    }
  ],
  "acceptanceChecks": []
}
```

When a run materializes from `--source-repo`, Quest Runner also writes `.quest-runner/workspace-manifest.md` into each slice workspace and, by default, links source-repo `node_modules` into the isolated worktree when that dependency tree already exists locally. If a repo needs a real prep step before honest checks can run, add `execution.prepareCommands` and Quest Runner will execute those commands inside each slice workspace before the builder starts, and again in the integration workspace before top-level acceptance checks. If a repo needs a conventional dependency bootstrap first, set `execution.preInstall: true`; Quest Runner will infer safe install commands from the workspace contents, run them before custom preparation, and avoid shared dependency linking for that workspace.

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

Example `openclaw-cli` worker:

```json
{
  "id": "ember-openclaw",
  "name": "Ember OpenClaw",
  "title": "Guild Operator",
  "class": "captain",
  "enabled": true,
  "backend": {
    "runner": "openclaw",
    "profile": "openai-codex/gpt-5.4",
    "adapter": "openclaw-cli",
    "agentId": "codex",
    "runtime": {
      "reasoningEffort": "medium",
      "providerOptions": {
        "timeout_seconds": "120",
        "verbose": "off"
      }
    },
    "toolPolicy": { "allow": [], "deny": [] }
  },
  "persona": {
    "voice": "steady",
    "approach": "route the work through the configured OpenClaw agent with minimal churn",
    "prompt": "Use the configured OpenClaw agent and keep the final report terse."
  },
  "stats": {
    "coding": 82,
    "testing": 70,
    "docs": 52,
    "research": 58,
    "speed": 54,
    "mergeSafety": 80,
    "contextEndurance": 78
  },
  "resources": {
    "cpuCost": 1,
    "memoryCost": 1,
    "gpuCost": 0,
    "maxParallel": 1
  },
  "trust": {
    "rating": 0.78,
    "calibratedAt": "2026-04-12T00:00:00Z"
  },
  "progression": {
    "level": 1,
    "xp": 0
  },
  "tags": ["openclaw"]
}
```

`openclaw-cli` runs `openclaw agent` inside the slice workspace and currently maps:
- `reasoningEffort` to `--thinking`
- `providerOptions.timeout_seconds` or `providerOptions.timeoutSeconds` to `--timeout`
- `providerOptions.verbose` to `--verbose`

Operational notes:
- the installed OpenClaw CLI may print plugin banners and even its structured `--json` payload on `stderr`, not just `stdout`
- Quest Runner parses structured OpenClaw output from either stream instead of assuming clean JSON on stdout
- Quest Runner creates workspace-bound temporary OpenClaw agents for quest execution so repo-edit runs do not inherit a persistent agent workspace
- OpenClaw `--local` mode is currently not supported for quest execution; gateway-backed runs are the supported path because they preserve workspace isolation reliably
- those temporary OpenClaw agents are intentionally kept past the slice turn so they do not delete a live quest workspace before trials or turn-in complete
- `runs cleanup` now reaps those temporary OpenClaw agents after the quest workspace is no longer needed
- real OpenClaw code-edit canaries should always include acceptance checks, because the backend can still report success before a file change is proven on disk

If the run has `--source-repo <path>`, Quest Runner materializes each slice workspace as a detached Git worktree from that repository before the worker starts. Source repositories must be clean; dirty working trees fail fast with a typed error that includes the changed-path count and the underlying `git status --short` output instead of silently forking from stale or partial state.
Workspace cleanup is explicit through `runs cleanup`; Quest Runner does not auto-delete workspaces after execution.
Completed runs can then be integrated serially with `runs integrate`, which replays slice results into a dedicated integration worktree instead of mutating the user’s main checkout directly.
If you want the happy path as one command, `runs execute --auto-integrate` advances from execution into the boss fight automatically after all slice trials pass.
If you want full turn-in in the same command, `runs execute --auto-integrate --land` advances from execution through boss fight into a fast-forward landing step on the current clean source checkout.
`runs land` is the explicit turn-in command when you want to inspect an integrated run before landing it.
If turn-in fails because the source branch drifted after boss fight, `runs refresh-base` rebuilds the integration workspace against the latest target revision so landing can be retried without replaying the full encounter phase.
Top-level spec `acceptanceChecks` run in that integration worktree after slices are replayed. If they fail, integration exits non-zero and the recorded integration checks stay on the run for inspection.
`--dry-run --auto-integrate` is intentionally invalid because the dry-run adapter does not produce real slice results to land.
`--land` without `--auto-integrate` is intentionally invalid on `runs execute`; use `runs land` for already integrated runs.
`runs cancel` is the explicit stop command for active execution, boss fight, or turn-in phases. `runs abort` remains as a compatibility alias.
`runs babysit` marks dead or stale in-flight runs as `orphaned`, and `runs rescue` records whether a failed boss fight or turn-in was manually recovered or abandoned. The latest rescue note is denormalized onto the run so summaries can show it without replaying the full event log.
Planner conflict handling is conservative on purpose: overlapping `owns` patterns are serialized into separate waves and now emit explicit plan warnings so hot ownership conflicts are visible before execution starts.
Acceptance checks are structured argv commands, not shell strings. Example:

```json
{
  "argv": ["bun", "-e", "console.log('ok')"],
  "env": {}
}
```

## Tester Lane

Each slice can define `acceptanceChecks`. After the worker command succeeds, Quest Runner executes those argv-defined checks in order and persists their results into slice logs.

If a slice has a distinct assigned tester worker, Quest Runner now runs that tester on the built workspace before the raw checks execute. The tester can validate or minimally correct the slice result, but the structured acceptance checks still decide pass/fail.

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
- `slack`
- `linear`
- `openclaw`

The `openclaw` sink delivers quest events into a dedicated OpenClaw agent/session thread, so setup can reuse an existing local OpenClaw agent as an observability inbox without coupling the run engine to OpenClaw’s task scheduler.

Internally, sinks already live behind a typed sink model instead of a webhook-only config shape. That keeps the current webhook path simple while leaving room for future Telegram, Linear, Slack, or metrics sinks without rewriting delivery storage.

The core model is:
- run or calibration emits an event
- observability dedupes and records delivery attempts
- sinks react to the event

This matters because webhook delivery is only the first consumer. The same event stream should support future sinks such as Telegram, Linear, Slack, or metrics without changing the run model itself.

Delivery records keep the observable payload snapshot that was sent to the sink. That gives operators a stable audit trail and lets Quest Runner retry failed deliveries without needing to reconstruct the original event from a possibly-mutated local state tree. Every sink should also be probeable from the operator surface; `quest observability sinks test` and `quest doctor --test-sinks` send a synthetic event through the configured sink path so wiring can be checked without waiting for a real quest.

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

# launch the interactive setup TUI
quest setup

# bootstrap a Hermes worker instead
quest setup --yes --backend hermes --hermes-base-url http://127.0.0.1:8000/v1

# bootstrap an OpenClaw worker instead
quest setup --yes --backend openclaw --openclaw-executable /path/to/openclaw

# when flags are omitted, setup imports usable backend defaults from the local machine
# examples:
# - Codex native login or OPENAI_API_KEY
# - first reachable Hermes model from /models
# - preferred OpenClaw agent (codex first, then first listed agent)
# - sink auth defaults from TELEGRAM_BOT_TOKEN, SLACK_WEBHOOK_URL, and LINEAR_API_KEY when present

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

# add a Hermes worker from flags, or let quest import the first detected model
quest workers add hermes \
  --name "Quest Hermes" \
  --base-url http://127.0.0.1:8000/v1 \
  --testing 92 \
  --gpu-cost 1 \
  --reasoning-effort medium \
  --max-output-tokens 4096 \
  --temperature 0.3 \
  --top-p 0.8 \
  --provider-option frequency_penalty=0.5

# add an OpenClaw worker from flags, or let quest import the preferred local agent/profile
quest workers add openclaw \
  --name "Quest OpenClaw" \
  --executable /path/to/openclaw \
  --reasoning-effort medium \
  --provider-option timeout_seconds=120 \
  --provider-option verbose=off

# inspect one worker with strengths, runtime, and backend detail
quest workers inspect --id quest-codex

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

# remove a worker from the roster
quest workers remove --id quest-codex --yes

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

# add or update a Slack sink
quest observability slack upsert \
  --id local-slack \
  --url-env SLACK_WEBHOOK_URL \
  --events run_failed,run_completed

# add or update a Linear sink
quest observability linear upsert \
  --id local-linear \
  --issue-id ISSUE-123 \
  --api-key-secret-ref linear.api-key \
  --events run_failed,run_completed

# add or update an OpenClaw sink that injects events into an agent/session
quest observability openclaw upsert \
  --id local-openclaw \
  --agent-id codex \
  --session-id main \
  --events run_failed,run_completed

# send a synthetic probe event through one sink or all configured sinks
quest observability sinks test --id local-openclaw
quest observability sinks test --label "manual smoke"

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
quest runs list --skip-invalid

# inspect one persisted quest run
quest runs status --id quest-abc12345-deadbeef

# watch one run live until it settles
quest runs watch --id quest-abc12345-deadbeef

# inspect a compact run summary
quest runs summary --id quest-abc12345-deadbeef

# execute a persisted run with the built-in dry-run adapter
quest runs execute --id quest-abc12345-deadbeef --dry-run

# execute a persisted run and backfill a source repo for worktree materialization
quest runs execute --id quest-abc12345-deadbeef --source-repo /abs/path/to/repo

# execute and auto-integrate in one step
quest runs execute --id quest-abc12345-deadbeef --auto-integrate --target-ref main

# execute, boss fight, and turn-in in one step
quest runs execute --id quest-abc12345-deadbeef --auto-integrate --land --target-ref main

# integrate a completed run into a dedicated integration worktree
quest runs integrate --id quest-abc12345-deadbeef --target-ref main

# land an already integrated run into the current clean source checkout
quest runs land --id quest-abc12345-deadbeef --target-ref main

# rebuild the boss-fight workspace against the latest target after landing drift
quest runs refresh-base --id quest-abc12345-deadbeef --target-ref main

# inspect persisted slice logs/output
quest runs logs --id quest-abc12345-deadbeef

# inspect best-effort token usage from persisted runner output
quest runs usage --id quest-abc12345-deadbeef
quest runs usage --all
quest runs usage --all --skip-invalid

# validate or quarantine one bad persisted run document
quest runs validate --id quest-abc12345-deadbeef
quest runs quarantine --id quest-abc12345-deadbeef

# preview or write the post-turn-in chronicle
quest runs chronicle --id quest-abc12345-deadbeef
quest runs chronicle --id quest-abc12345-deadbeef --write

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
printf 'example-openai-api-key' | quest secrets set --name codex.api --stdin

# inspect whether a keychain secret exists
quest secrets status --name codex.api

# delete a stored secret
quest secrets delete --name codex.api

# verify the local operator/runtime prerequisites
quest doctor
quest doctor --check-openclaw --agent-id codex
quest doctor --test-sinks
quest doctor --test-sinks --sink-id local-openclaw

# the interactive setup flow lets you choose:
# - backend
# - hybrid vs split party mode
# - builder/tester archetypes and strengths
# - tester routing strategy
# - one observability sink
# - optional Training Grounds calibration

# remove quest-managed workspaces for a run
# completed source-repo runs must be integrated before cleanup
# aborted source-repo runs can be cleaned directly
# boss-fight failures can also be cleaned directly because the turn-in path is already broken
quest runs cleanup --id quest-abc12345-deadbeef

# prune old quest workspaces in bulk
# default statuses: landed, completed, aborted, orphaned
quest workspaces prune
quest workspaces prune --older-than 168h --status landed,completed
quest workspaces prune --dry-run --skip-invalid

# abort a pending or running run
quest runs abort --id quest-abc12345-deadbeef

# cancel an active execution / boss fight / turn-in phase
quest runs cancel --id quest-abc12345-deadbeef

# mark stale dead-host runs as orphaned
quest runs babysit --stale-minutes 15

# record manual rescue state after a failed boss fight or turn-in
quest runs rescue --id quest-abc12345-deadbeef --status rescued --note "landed manually"

# create a fresh run from a prior run's spec
quest runs rerun --id quest-abc12345-deadbeef

# rerun a prior run but force a different worker
quest runs rerun --id quest-abc12345-deadbeef --worker-id quest-codex

# optional: compile a standalone Bun executable
bun run build
QUEST_RUNNER_USE_DIST=1 ./bin/quest runs list

# repo-local wrapper defaults to source execution for reliability;
# set QUEST_RUNNER_USE_DIST=1 if you want to validate the compiled artifact explicitly
./bin/quest runs list

# JSON and YAML quest specs are both supported
yq -o=json spec.yaml | quest run --stdin
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
- interactive setup TUI for Codex, Hermes, or OpenClaw workers with party mode, archetype-based strengths, optional sink wiring, and optional Training Grounds calibration
- typed quest specs and conservative wave planning
- explicit worker forcing for plan/run/rerun flows
- persisted quest runs plus run events
- dry-run execution path for exercising run state transitions
- persisted slice output logs and basic control commands (`runs logs`, `runs abort`)
- real local subprocess execution through the `local-command` adapter
- native Codex execution through the `codex-cli` adapter
- Hermes/OpenAI-compatible execution through the `hermes-api` adapter
- OpenClaw execution through gateway-backed temporary workspace agents in the `openclaw-cli` adapter
- slice-level tester lane through `acceptanceChecks`
- richer steering commands for pause/resume plus per-slice reassign/retry/skip
- runtime-managed per-run and per-slice workspace directories
- optional Git worktree materialization via `--source-repo`
- workspace manifest injection for slice prompts
- optional source dependency linking into isolated worktrees for more honest acceptance checks
- explicit execution policy in specs (`timeoutMinutes`, optional `idleTimeoutMinutes`, `preInstall`, `shareSourceDependencies`)
- serial integration into a dedicated worktree via `runs integrate`
- integration-time execution of top-level `acceptanceChecks`
- resume-safe `runs integrate` when the existing integration worktree is clean
- explicit `runs refresh-base` recovery for drifted turn-in paths
- explicit workspace cleanup via `runs cleanup`
- cleanup confinement under the configured workspaces root
- cleanup-time reaping of temporary OpenClaw quest agents
- local keychain-backed secret storage for runner auth
- built-in worker calibration through the throwaway `training-grounds-v1` suite
- persisted calibration history, trust updates, and XP awards on workers
- event-driven observability with a webhook sink
- Telegram sink delivery through the same eventing model
- Slack sink delivery through the same eventing model
- Linear sink delivery through the same eventing model
- OpenClaw session-delivery sink through the same eventing model
- sink probe/test-send support from `quest observability sinks test` and `quest doctor --test-sinks`
- persisted webhook delivery records with payload snapshots for dedupe, audit, and retries
- best-effort run usage summaries via `runs usage`
- post-turn-in chronicle generation when `featureDoc.enabled` is true

Additional sink integrations and broader backend tuning are still pending.

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
