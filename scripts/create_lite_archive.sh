#!/usr/bin/env bash
set -euo pipefail

# Creates a smaller archive by excluding heavyweight local/dev folders.
WORKSPACE_ROOT="/workspaces"
REPO_DIR="SherryJo_Cal_App"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_PATH="${HOME}/${REPO_DIR}-lite-${TIMESTAMP}.tar.gz"

cd "$WORKSPACE_ROOT"

tar -czf "$OUTPUT_PATH" \
  --exclude='SherryJo_Cal_App/.git' \
  --exclude='SherryJo_Cal_App/.venv' \
  --exclude='SherryJo_Cal_App/node_modules' \
  SherryJo_Cal_App

echo "Lite archive created: $OUTPUT_PATH"
