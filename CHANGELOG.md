# Changelog

All notable changes to Quest Runner are tracked here. The format follows a compact Keep-a-Changelog shape until tagged releases begin.

## Unreleased

### Added
- Optional rich Telegram and Linear observability cards, while webhook, Slack, and OpenClaw keep the portable plain-text formatter by default.
- Daemon lifecycle and party-admin observability events covering dispatch, landing, failure, budget exhaustion, recovery, creation, rest, and resume.
- Setup import for Telegram bot token and default chat id from local OpenClaw config when available.
- Observability cards v1 spec in `docs/specs/observability-cards-v1.mdx`.
- Daemon state compatibility for legacy `process: null` records in `daemon-state.json`.
- Sink dispatch tests covering webhook, Slack, Linear, and Telegram success/failure paths.
- Daemon budget enforcement coverage for `maxSpecsPerHour`.

### Fixed
- `ObservableDaemonEvent.specFile` is nullable; the budget path can now persist events that do not belong to a single spec file.
- `runs execute` now has regression coverage proving it reuses the run document's persisted `sourceRepositoryPath` when `--source-repo` is omitted.

### Docs
- `README.md` documents the daemon event surface, OpenClaw credential import, and the public operator workflows.
- Public docs avoid links to local-only notes and removed TUI assets.

---

Release versioning resumes at v0.1.0 once the remaining Tier 1 item (rate-limit auto-throttle) ships.
