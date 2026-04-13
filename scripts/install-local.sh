#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.local/bin"
if [[ -n "${QUEST_RUNNER_INSTALL_BIN_DIR:-}" ]]; then
  TARGET_DIR="${QUEST_RUNNER_INSTALL_BIN_DIR}"
fi
TARGET_BIN="${TARGET_DIR}/quest"
SOURCE_BIN="${PROJECT_ROOT}/bin/quest"

mkdir -p "${TARGET_DIR}"
ln -sf "${SOURCE_BIN}" "${TARGET_BIN}"

printf 'Installed quest -> %s\n' "${TARGET_BIN}"
printf 'Source wrapper -> %s\n' "${SOURCE_BIN}"
