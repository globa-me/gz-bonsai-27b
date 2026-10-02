#!/bin/sh
set -eu

VERSION="prism-b10709-9a9394a"
ARCHIVE="llama-${VERSION}-bin-macos-arm64.tar.gz"
EXPECTED_SHA="f9cdf245fb7b832f1996dd776b321d4ae1f23b6d88c380100f636742c3a980ff"
URL="https://github.com/PrismML-Eng/llama.cpp/releases/download/${VERSION}/${ARCHIVE}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
TARGET="$PROJECT_DIR/src-tauri/runtime/$VERSION"
TEMP_DIR=$(mktemp -d /tmp/gz-bonsai-runtime.XXXXXX)
STAGING_DIR=""
trap 'rm -rf "$TEMP_DIR" "$STAGING_DIR"' EXIT HUP INT TERM

python3 "$SCRIPT_DIR/macos_signing.py" identity > "$TEMP_DIR/identity.json"
SIGNING_IDENTITY=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha1"])' "$TEMP_DIR/identity.json")

if [ -e "$TARGET" ]; then
  echo "Refusing to overwrite existing runtime: $TARGET" >&2
  exit 1
fi

curl --fail --location --proto '=https' --tlsv1.2 "$URL" --output "$TEMP_DIR/$ARCHIVE"
echo "$EXPECTED_SHA  $TEMP_DIR/$ARCHIVE" | shasum -a 256 -c -
tar -xzf "$TEMP_DIR/$ARCHIVE" -C "$TEMP_DIR"
SOURCE="$TEMP_DIR/$VERSION"
STAGING_DIR=$(mktemp -d "$PROJECT_DIR/src-tauri/runtime/.g2-staged.XXXXXX")
cp -a "$SOURCE/llama-server" "$SOURCE"/lib*.dylib "$SOURCE/LICENSE" "$STAGING_DIR/"

for file in "$STAGING_DIR"/*.dylib; do
  if [ -f "$file" ] && [ ! -L "$file" ]; then
    codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$file"
  fi
done
codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$STAGING_DIR/llama-server"

python3 "$SCRIPT_DIR/macos_signing.py" verify "$STAGING_DIR" --sha1 "$SIGNING_IDENTITY" --arm64
python3 - "$STAGING_DIR" "$TARGET" <<'PYINSTALL'
import os, sys
if os.path.lexists(sys.argv[2]):
    raise SystemExit("Refusing to overwrite an existing runtime")
os.rename(sys.argv[1], sys.argv[2])
PYINSTALL

echo "Prepared signed runtime in $TARGET"
