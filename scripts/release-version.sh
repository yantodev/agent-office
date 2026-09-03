#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/release-version.sh <version> [--push]

Examples:
  bash scripts/release-version.sh 0.0.2-beta
  bash scripts/release-version.sh v0.0.2-beta --push

The script updates package.json and package-lock.json, creates a release
commit, and creates an annotated Git tag. Use --push to push the current
branch and tag to origin.
USAGE
}

if [[ $# -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 2
fi

VERSION="${1#v}"
PUSH=false

if [[ $# -eq 2 ]]; then
  if [[ "$2" != "--push" ]]; then
    echo "Unknown option: $2" >&2
    usage >&2
    exit 2
  fi
  PUSH=true
fi

# Menerima SemVer stabil dan prerelease seperti beta.1 atau rc.1.
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  echo "Invalid SemVer: $VERSION" >&2
  echo "Contoh yang valid: 0.0.2-beta, 0.0.2-beta.1, 1.0.0" >&2
  exit 2
fi

TAG="v$VERSION"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

if ! command -v git >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  echo "git, npm, dan node wajib tersedia." >&2
  exit 1
fi

# Jangan menimpa perubahan tracked yang belum disimpan.
if ! git diff --quiet HEAD --; then
  echo "Working tree memiliki perubahan tracked. Commit atau stash terlebih dahulu." >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/tags/$TAG"; then
  echo "Tag lokal sudah ada: $TAG" >&2
  exit 1
fi

if [[ "$PUSH" == true && -z "$(git branch --show-current)" ]]; then
  echo "--push membutuhkan branch aktif, bukan detached HEAD." >&2
  exit 1
fi

CURRENT_VERSION="$(node -p "require('./package.json').version")"
if [[ "$CURRENT_VERSION" == "$VERSION" ]]; then
  echo "Versi sudah berada di $VERSION." >&2
  exit 1
fi

echo "Updating package version: $CURRENT_VERSION -> $VERSION"
npm version "$VERSION" --no-git-tag-version

LOCK_VERSION="$(node -p "require('./package-lock.json').packages[''].version")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
if [[ "$PACKAGE_VERSION" != "$VERSION" || "$LOCK_VERSION" != "$VERSION" ]]; then
  echo "package.json dan package-lock.json tidak konsisten setelah update." >&2
  exit 1
fi

git add package.json package-lock.json
git commit -m "release: prepare $TAG"
git tag --annotate "$TAG" --message "Release $TAG"

if [[ "$PUSH" == true ]]; then
  git push origin HEAD
  git push origin "$TAG"
  echo "Release $TAG sudah dipush ke origin."
else
  echo "Release $TAG sudah dibuat secara lokal. Gunakan --push untuk mengirimnya ke origin."
fi
