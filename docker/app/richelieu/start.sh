#!/bin/sh
# Installs packages when the project's package.json differs from the installed one, then runs the dev server.
set -e
cd /app
if ! cmp -s package.json .richelieu/installed.json; then
  echo "[richelieu] installing packages"
  npm install --no-audit --no-fund --loglevel=error
  cp package.json .richelieu/installed.json
fi
exec node node_modules/vite/bin/vite.js --config .richelieu/vite.config.mjs
