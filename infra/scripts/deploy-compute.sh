#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/orchestrace/app"
PORT="${ORCHESTRACE_PORT:-4310}"

if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm
fi

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

sudo mkdir -p /opt/orchestrace
sudo chown -R "$USER":"$USER" /opt/orchestrace

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$GITHUB_REPOSITORY_URL" "$APP_DIR"
fi


cd "$APP_DIR"

git fetch --all --prune
git checkout "$GITHUB_REF_NAME"
git reset --hard "origin/$GITHUB_REF_NAME"

pnpm install --frozen-lockfile
pnpm build

pm2 delete orchestrace-backend >/dev/null 2>&1 || true
pm2 start "pnpm --filter @orchestrace/cli dev ui --port $PORT" --name orchestrace-backend
pm2 save