# Changelog

All notable changes to Quest Runner are tracked here. The format follows a compressed Keep-a-Changelog shape, keyed by commit hash for quick lookup.

## Unreleased

### Added
- Telegram HTML card formatter with RPG flavor copy (`⚔️ Quest Accepted`, `💀 Party Wiped`, `🔥 Resting at Bonfire`). Opt-in via `--parse-mode HTML` on the Telegram sink. Slack/Linear/webhook/OpenClaw keep the portable plain-text formatter. `d1fbb48`, `6b856dc`.
- Three daemon party-admin observability events: `daemon_party_created`, `daemon_party_resting`, `daemon_party_resumed`. Emitted from the CLI party handlers covering both named-party and global `*` forms. Complete the full 8-event daemon observability surface. `5447aba`.
- Setup wizard now imports Telegram bot token + default chat id from `~/.openclaw/openclaw.json` when available (new `openclaw-import` auth mode), and prompts whether to render events as RPG flavor cards. `a5bac46`.
- Observability cards v1 spec (`docs/specs/observability-cards-v1.mdx`). `4ade39b`.
- Daemon state schema now tolerates legacy `process: null` in `daemon-state.json` (previously failed the Zod parse on startup). `<pending>`.
- Sink dispatch test coverage: 11 new tests across webhook, Slack, Linear, and Telegram handlers (happy path, HTTP failures, transport errors, missing auth). Dispatch path coverage went from 0-24% to 93-100%. `<pending>`.
- Daemon budget enforcement test that back-to-back ticks with `maxSpecsPerHour=1` refuse to dispatch twice. `<pending>`.

### Fixed
- `ObservableDaemonEvent.specFile` is nullable; previously the budget path wrote `specFile: ""` which would have failed the `nonEmptyString(240)` schema. `5447aba`.
- `runs execute` locked in with two new tests proving it reuses the run document's persisted `sourceRepositoryPath` when `--source-repo` is omitted (behavior was shipped but untested, looked like a gap in FEEDBACK). `ddb4509`.

### Docs
- `docs/internals/observability-sinks.md` — full reference for the event model, dispatcher seam, formatter split, setup wizard wiring, canary path, and extension points. Local-only (`docs/internals/` is gitignored). `4ade39b`.
- `docs/internals/daemon-design.md` — marked party-admin events as shipped, documented that they emit from the CLI boundary (not the tick loop). `5447aba`.
- `README.md` — daemon event list now covers all 8 types; setup docs mention RPG card opt-in and OpenClaw credential import. `5447aba`, `a5bac46`.
- `FEEDBACK.md` — closed "Smart credential import", partially closed "Observability sink TUI", closed "No daemon-level observability events". `5447aba`, `a5bac46`.

---

Release versioning resumes at v0.1.0 once the remaining Tier 1 item (rate-limit auto-throttle) ships.
