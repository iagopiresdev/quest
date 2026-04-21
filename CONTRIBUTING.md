# Contributing

## Scope

`quest` is a spec-driven orchestration tool. Contributions should preserve:
- explicit domain boundaries
- schema-first persisted state
- battle-tested execution behavior
- machine-stable CLI contracts

Read these first:
- [README.md](./README.md)
- [docs/design-system.mdx](./docs/design-system.mdx)
- [docs/engineering-guide.mdx](./docs/engineering-guide.mdx)

## Workflow

1. Research the existing boundary you are changing.
2. Write or update a spec when the change is architectural or execution-facing.
3. Keep the implementation narrow.
4. Add automated coverage for happy path and edge cases.
5. Run a real canary when the change touches execution, setup, integration, steering, or sink delivery.

## Branches

Do not push directly to `main` or `master`. Create a topic branch, push it, and open a pull request.

GitHub branch protection is configured as the authoritative guard for `main`. For a local early warning before a push reaches GitHub, install the tracked pre-push hook:

```sh
bun run hooks:install
```

## Local Validation

Before opening a pull request, run:

```sh
bun run lint
bun run typecheck
bun test
bun run build
```

For execution-facing work, also run a real canary. Examples:

```sh
bun ./scripts/canaries/fresh-install.ts --backend local-command
bun ./scripts/canaries/fresh-install.ts --backend codex
```

## Pull Requests

Keep pull requests small enough that:
- the affected domain boundary is obvious
- the validation story is credible
- battle-tested changes can be reviewed without reconstructing hidden state

Maintainer-authored PRs can opt into GitHub auto-merge by adding the `automerge` label. Auto-merge is only enabled for non-draft PRs from this repository when the PR author is an owner, member, or collaborator. Branch protection still has to pass before GitHub merges the PR.

Include:
- what changed
- why it changed
- risks or non-goals
- exact validation performed

## Secrets And State

Do not commit:
- runtime state under `.quest/`
- secrets, API keys, or local auth material
- machine-specific config

Use placeholder values that do not resemble real credentials.
