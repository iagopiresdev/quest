# Security Policy

## Reporting

If you find a security issue, do not open a public issue with exploit details or live secrets.

Report it privately through GitHub private vulnerability reporting when it is enabled for this repository.
If private vulnerability reporting is not enabled yet, open a minimal public issue that asks for a private
reporting path without disclosing the vulnerability itself.

## Scope

Security-sensitive areas include:
- credential and secret handling
- subprocess execution
- workspace materialization and cleanup
- integration and git worktree handling
- observability sink delivery

## Disclosure Expectations

When reporting an issue, include:
- affected version or commit
- reproduction steps
- expected vs actual behavior
- impact
- whether secrets, filesystem escape, or arbitrary command execution are involved

## Repository Hygiene

This repository should not contain:
- real API keys or tokens
- exported session state
- machine-specific private paths in docs or examples

Examples should use obviously fake placeholder values.
