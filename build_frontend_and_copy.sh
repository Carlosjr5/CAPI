#!/usr/bin/env bash
set -euo pipefail

# Build the frontend and copy the production build into ./static
# This script is intended for CI/deploy (Linux) environments such as Railway.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
STATIC_DIR="$ROOT_DIR/static"

echo "Building frontend in $FRONTEND_DIR"
cd "$FRONTEND_DIR"

# Install dependencies and build
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npm run build

echo "Copying dist -> $STATIC_DIR"
mkdir -p "$STATIC_DIR"
cp -r dist/* "$STATIC_DIR/"

echo "Frontend build copied to static/"