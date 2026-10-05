#!/usr/bin/env bash
# Publish a new version of the desktop app, start to finish:
#
#   ./release.sh 1.1.0 "What changed, one line"
#
#   1. checks it is publishing as andreitechvision (never the active gh login by accident)
#   2. sets the version in package.json and builds the Linux installers
#   3. commits, tags and pushes to github.com/andreitechvision/ubex-desktop
#   4. creates the GitHub release with the installers and the update manifest, which is what
#      installed apps check to update themselves
#   5. sets DESKTOP_LATEST_VERSION in the interface and deploys it, so older installs show the
#      "new version" banner. It runs only after the release exists, so the banner never points
#      at files that are not there yet.
#
# Windows is built on a Windows PC (npm run dist:win), then added to the same release:
#   gh release upload v<version> dist/Ubex-Setup.exe dist/Ubex-Setup.exe.blockmap dist/latest.yml
set -euo pipefail

ACCOUNT=andreitechvision
REPO=$ACCOUNT/ubex-desktop
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
IFACE_FILE=shared/desktop-app.js

VERSION="${1:-}"
NOTES="${2:-}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: ./release.sh <version, e.g. 1.1.0> \"what changed\"" >&2
  exit 1
fi
cd "$HERE"

# 1. The account. gh's active login on this machine is a different account, so every call
#    here carries andreitechvision's token explicitly instead of trusting the default.
GH_TOKEN="$(gh auth token -u "$ACCOUNT" 2>/dev/null || true)"
if [ -z "$GH_TOKEN" ]; then
  echo "gh is not logged in as $ACCOUNT (gh auth login, then choose that account)" >&2
  exit 1
fi
export GH_TOKEN
if [ "$(gh api user --jq .login)" != "$ACCOUNT" ]; then
  echo "token does not belong to $ACCOUNT, stopping" >&2
  exit 1
fi
if ! git remote get-url origin | grep -q "github.com/$REPO"; then
  echo "origin is not github.com/$REPO, stopping" >&2
  exit 1
fi
if gh release view "v$VERSION" -R "$REPO" >/dev/null 2>&1; then
  echo "v$VERSION is already released" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "note: uncommitted changes are included in this release:"
  git status --short
fi

# 2. Build. Fedora 44 lacks libcrypt.so.1, which electron-builder's packaging tool (fpm) needs
#    for .rpm and .deb. Rather than ask for root, fetch the library into a cache once.
if [ ! -e /usr/lib64/libcrypt.so.1 ] && [ ! -e /usr/lib/x86_64-linux-gnu/libcrypt.so.1 ]; then
  CACHE="$HOME/.cache/ubex-desktop/xcrypt"
  if [ ! -e "$CACHE/usr/lib64/libcrypt.so.1" ]; then
    mkdir -p "$CACHE"
    (cd "$CACHE" && dnf download --arch x86_64 libxcrypt-compat >/dev/null && rpm2cpio libxcrypt-compat-*.x86_64.rpm | cpio -idm 2>/dev/null)
  fi
  export LD_LIBRARY_PATH="$CACHE/usr/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
rm -rf dist
npm run dist:linux

FILES=(dist/Ubex-x86_64.rpm dist/Ubex-amd64.deb dist/Ubex-x86_64.AppImage dist/latest-linux.yml)
for f in "${FILES[@]}"; do
  [ -s "$f" ] || { echo "build did not produce $f" >&2; exit 1; }
done
grep -q "^version: $VERSION$" dist/latest-linux.yml || { echo "dist/latest-linux.yml is not $VERSION" >&2; exit 1; }

# 3. Source.
push() {
  git -c credential.helper= \
      -c "credential.helper=!f() { echo username=$ACCOUNT; echo password=\$GH_TOKEN; }; f" \
      push "$@"
}
git add -A
git commit -q -m "Release $VERSION${NOTES:+: $NOTES}" || true
git tag "v$VERSION"
push origin HEAD
push origin "v$VERSION"

# 4. The release.
gh release create "v$VERSION" -R "$REPO" --title "Ubex $VERSION" \
  --notes "${NOTES:-Ubex $VERSION}" "${FILES[@]}"

# 5. The interface: the banner for older installs.
sed -i "s/^export const DESKTOP_LATEST_VERSION = '[^']*';/export const DESKTOP_LATEST_VERSION = '$VERSION';/" \
  "$ROOT/Frontend/Interface/$IFACE_FILE"
grep -q "DESKTOP_LATEST_VERSION = '$VERSION'" "$ROOT/Frontend/Interface/$IFACE_FILE" \
  || { echo "could not set DESKTOP_LATEST_VERSION; set it by hand and deploy $IFACE_FILE" >&2; exit 1; }
(cd "$ROOT/Backend/scripts" && python3 deploy_interface.py --label "Desktop app $VERSION released" "$IFACE_FILE")

echo
echo "Released Ubex $VERSION: https://github.com/$REPO/releases/tag/v$VERSION"
