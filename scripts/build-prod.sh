#!/bin/zsh
# Builds frontend + backend and applies pending migrations.
# Run it from anywhere; paths are resolved from this script.
set -euo pipefail

ROOT="${0:A:h:h}" # scripts/.. -> repo root
cd "$ROOT"

echo "==> frontend"
cd frontend
npm ci
npm run build

echo "==> backend"
cd ../backend
npm ci
npx prisma migrate deploy
npm run build

echo
echo "Build done. Start it with: scripts/start-prod.sh"
