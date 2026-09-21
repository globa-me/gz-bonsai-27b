#!/bin/sh
set -eu

VERSION="prism-b10709-9a9394a"
ARCHIVE="llama-${VERSION}-bin-macos-arm64.tar.gz"
EXPECTED_SHA="f9cdf245fb7b832f1996dd776b321d4ae1f23b6d88c380100f636742c3a980ff"
URL="https://github.com/PrismML-Eng/llama.cpp/releases/download/${VERSION}/${ARCHIVE}"
SIGNING_IDENTITY="${BONSAI_SIGNING_IDENTITY:-Developer ID Application: Gennadiy Zakharov (BN3D9H4C7J)}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
TARGET="$PROJECT_DIR/src-tauri/runtime/$VERSION"
TEMP_DIR=$(mktemp -d /tmp/gz-bonsai-runtime.XXXXXX)
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

if [ -e "$TARGET" ]; then
  echo "Refusing to overwrite existing runtime: $TARGET" >&2
  exit 1
fi

curl --fail --location --proto '=https' --tlsv1.2 "$URL" --output "$TEMP_DIR/$ARCHIVE"
echo "$EXPECTED_SHA  $TEMP_DIR/$ARCHIVE" | shasum -a 256 -c -
tar -xzf "$TEMP_DIR/$ARCHIVE" -C "$TEMP_DIR"
SOURCE="$TEMP_DIR/$VERSION"
mkdir -p "$TARGET"
cp -a "$SOURCE/llama-server" "$SOURCE"/lib*.dylib "$SOURCE/LICENSE" "$TARGET/"

for file in "$TARGET"/*.dylib; do
  if [ -f "$file" ] && [ ! -L "$file" ]; then
    codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$file"
  fi
done
codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$TARGET/llama-server"

find "$TARGET" -maxdepth 1 -type f -print0 | while IFS= read -r -d '' file; do
  if file "$file" | grep -q 'Mach-O'; then
    codesign --verify --strict "$file"
  fi
done

echo "Prepared signed runtime in $TARGET"
