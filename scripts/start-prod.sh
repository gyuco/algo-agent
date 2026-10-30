#!/bin/zsh
# Runs the compiled app: Nest serves both `/api` and the built SPA (`frontend/dist`).
# Reads backend/.env through Nest ConfigModule (cwd must be backend/).
set -euo pipefail

ROOT="${0:A:h:h}" # scripts/.. -> repo root
cd "$ROOT/backend"

# launchd starts with a minimal PATH: nvm lives outside it.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || true
fi
# `claude` (used by `claude setup-token`) is installed here.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

exec node dist/main.js
