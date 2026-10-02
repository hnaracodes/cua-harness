#!/usr/bin/env bash
# Freeze the daemon into one binary and put it where Tauri's externalBin expects it:
# app/src-tauri/binaries/oversight-daemon-<target triple>.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
daemon="$(dirname "$here")"
binaries="$(dirname "$daemon")/app/src-tauri/binaries"

triple="${TARGET_TRIPLE:-}"
if [ -z "$triple" ] && command -v rustc >/dev/null 2>&1; then
  triple="$(rustc -vV | sed -n 's/^host: //p')"
fi
if [ -z "$triple" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) triple=aarch64-apple-darwin ;;
    Darwin-x86_64) triple=x86_64-apple-darwin ;;
    Linux-x86_64) triple=x86_64-unknown-linux-gnu ;;
    Linux-aarch64) triple=aarch64-unknown-linux-gnu ;;
    *) echo "set TARGET_TRIPLE (unknown platform $(uname -s)-$(uname -m))" >&2; exit 1 ;;
  esac
fi

cd "$daemon"
uv run --group packaging pyinstaller --noconfirm --clean \
  --distpath build/dist --workpath build/work packaging/oversight-daemon.spec

mkdir -p "$binaries"
cp build/dist/oversight-daemon "$binaries/oversight-daemon-$triple"
echo "sidecar: $binaries/oversight-daemon-$triple"
