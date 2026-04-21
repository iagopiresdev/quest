# Code Review Guide

Use this guide for human reviews, Codex reviews, and any other automated review
agent attached to the repository.

## Review Priorities

Review in this order:

1. Correctness regressions, unsafe state transitions, data loss, and security issues.
2. CLI JSON contract stability and operator-facing behavior.
3. Type safety, schema validation, and explicit domain errors.
4. Test coverage, validation commands, and required canaries.
5. Documentation, examples, and public project hygiene.

## Quest-Specific Checks

- Preserve the current bounded contexts:
  - `src/core/planning`
  - `src/core/workers`
  - `src/core/runs`
  - `src/core/observability`
  - `src/core/setup`
- Keep builder and tester policy explicit. Do not hide them behind a defaulted selector parameter.
- Keep JSON output machine-stable when changing CLI behavior.
- Treat runner output and external adapter output as hostile transport.
- Keep secrets, runtime state, and local auth material out of prompts, logs, fixtures, and commits.
- Require real canaries for execution, setup, integration, backend import, and sink-delivery changes.
- Prefer focused helper extraction over lint disables.

## Validation Expectations

The standard gate is:

```sh
bun run lint
bun run typecheck
bun test
bun run build
```

For execution-facing work, verify that the PR names the relevant canary and
whether it was run or intentionally deferred.

## Review Output

- Lead with blocking findings and concrete file or line references.
- Separate correctness issues from preferences.
- If there are no blocking findings, say so and call out any residual risk.
- Do not approve or request merge based only on an AI review. Maintainer merge
  intent is expressed through the `automerge` label and branch protection.
