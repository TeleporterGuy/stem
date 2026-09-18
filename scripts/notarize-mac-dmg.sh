#!/usr/bin/env bash
# Final release gate. --verify-only checks an already stapled installer locally.
set -euo pipefail

verify_only=false
if [ "${1:-}" = --verify-only ]; then
  verify_only=true
  shift
fi
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo 'Usage: bash scripts/notarize-mac-dmg.sh [--verify-only] path/to/Stem.dmg' >&2
  exit 1
fi
dmg="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
requirement='=anchor apple generic and certificate leaf[subject.OU] = "AX23G9CAL9"'

# Fail before submission if the container is unsigned or signed by another team.
codesign --verify --strict --verbose=2 -R "$requirement" "$dmg"

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/stem-dmg-check.XXXXXX")
mount_point="$work_dir/mounted"
mkdir "$mount_point"
mounted=false
cleanup() {
  if [ "$mounted" = true ]; then
    if ! hdiutil detach "$mount_point"; then
      echo "Could not detach installer; leaving temporary directory: $work_dir" >&2
      return 1
    fi
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

if [ "$verify_only" = false ]; then
  : "${APPLE_API_KEY:?Notarization key path is required}"
  : "${APPLE_API_KEY_ID:?Notarization key ID is required}"
  : "${APPLE_API_ISSUER:?Notarization issuer is required}"
  xcrun notarytool submit "$dmg" \
    --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" --wait --output-format json > "$work_dir/notarization.json"
  cat "$work_dir/notarization.json"
  node -e '
    const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (result.status !== "Accepted") {
      console.error("DMG notarization was not accepted:", result.id, result.status);
      process.exit(1);
    }
  ' "$work_dir/notarization.json"
  xcrun stapler staple "$dmg"
fi

xcrun stapler validate "$dmg"
codesign --verify --strict --verbose=2 -R "$requirement" "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"

# Assess the bytes users receive, not just the app in the build directory.
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount_point" "$dmg"
mounted=true
app="$mount_point/Stem.app"
test "$(lipo -archs "$app/Contents/MacOS/Stem")" = arm64
codesign --verify --deep --strict --verbose=2 -R "$requirement" "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=4 "$app"
syspolicy_check distribution "$app"
hdiutil detach "$mount_point"
mounted=false
echo 'DMG and mounted Apple Silicon app passed release verification.'
