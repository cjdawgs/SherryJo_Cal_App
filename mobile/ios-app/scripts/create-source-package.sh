#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPOSITORY_DIR=$(CDPATH= cd -- "$PROJECT_DIR/../.." && pwd)
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
OUTPUT_DIR=${1:-"$REPOSITORY_DIR/artifacts/mobile"}
ARCHIVE="$OUTPUT_DIR/SherryJo-Calendar-iOS-source-$VERSION.zip"

mkdir -p "$OUTPUT_DIR"
rm -f "$ARCHIVE"

cd "$PROJECT_DIR"
zip -q -r "$ARCHIVE" . \
  -x 'node_modules/*' \
     'ios/App/DerivedData/*' \
     'ios/App/build/*' \
     'ios/App/*.xcworkspace/xcuserdata/*' \
     'ios/App/*.xcodeproj/xcuserdata/*' \
     '**/.DS_Store'

unzip -tq "$ARCHIVE" >/dev/null
(cd "$OUTPUT_DIR" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
printf '%s\n' "$ARCHIVE"