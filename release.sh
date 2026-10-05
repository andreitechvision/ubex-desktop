#!/usr/bin/env bash
# Publish a new version of the desktop app, start to finish:
#
#   ./release.sh 1.1.0 "What changed, one line"
#
#   1. checks it is publishing as andreitechvision (never the active gh login by accident)
#   2. sets the version in package.json and builds the Linux installers
#   3. commits, tags and pushes to github.com/andreitechvision/ubex-desktop
#   4. creates the GitHub release as a draft with the Linux installers, waits for GitHub
#      Actions to add the Windows one (.github/workflows/windows.yml, started by the tag), then
#      publishes it. Only then do "latest" downloads and installed apps' updaters see it, so no
#      platform ever points at a file that is not there yet.
#   5. sets DESKTOP_LATEST_VERSION in the interface and deploys it, so older installs show the
#      "new version" banner. It runs only after the release exists, so the banner never points
#      at files that are not there yet.
#
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

FILES=(dist/Ubex-Chat-x86_64.rpm dist/Ubex-Chat-amd64.deb dist/Ubex-Chat-x86_64.AppImage dist/latest-linux.yml)
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

# 4. The release: a draft until the Windows installer is in it.
gh release create "v$VERSION" -R "$REPO" --draft --title "Ubex Chat $VERSION" \
  --notes "${NOTES:-Ubex Chat $VERSION}" "${FILES[@]}"

echo "Waiting for the Windows installer (GitHub Actions, usually 5-10 minutes)..."
RUN=""
for i in $(seq 1 30); do
  RUN="$(gh run list -R "$REPO" --workflow windows.yml --branch "v$VERSION" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  [ -n "$RUN" ] && break
  sleep 10
done
if [ -z "$RUN" ]; then
  echo "The Windows build did not start. The release is still a draft: check GitHub Actions, then run" >&2
  echo "  gh release edit v$VERSION -R $REPO --draft=false --latest   and deploy $IFACE_FILE" >&2
  exit 1
fi
if ! gh run watch "$RUN" -R "$REPO" --exit-status --interval 30 >/dev/null; then
  echo "The Windows build failed: https://github.com/$REPO/actions/runs/$RUN" >&2
  echo "The release is still a draft. Re-run the build there, then:" >&2
  echo "  gh release edit v$VERSION -R $REPO --draft=false --latest   and deploy $IFACE_FILE" >&2
  exit 1
fi
gh release edit "v$VERSION" -R "$REPO" --draft=false --latest >/dev/null

# 5. The interface: the banner for older installs.
sed -i "s/^export const DESKTOP_LATEST_VERSION = '[^']*';/export const DESKTOP_LATEST_VERSION = '$VERSION';/" \
  "$ROOT/Frontend/Interface/$IFACE_FILE"
grep -q "DESKTOP_LATEST_VERSION = '$VERSION'" "$ROOT/Frontend/Interface/$IFACE_FILE" \
  || { echo "could not set DESKTOP_LATEST_VERSION; set it by hand and deploy $IFACE_FILE" >&2; exit 1; }
(cd "$ROOT/Backend/scripts" && python3 deploy_interface.py --label "Desktop app $VERSION released" "$IFACE_FILE")

echo
echo "Released Ubex Chat $VERSION: https://github.com/$REPO/releases/tag/v$VERSION"
