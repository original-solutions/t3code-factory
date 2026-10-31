#!/usr/bin/env bash
# Builds HEAD and installs it on this machine: build.sh, then install.sh on the archive it made.
# An archive already in release/ for this commit is installed as it is, since its name carries
# the commit; --rebuild builds it again. --build-only stops after the build, for a tree you
# want to install later or on another machine of the same kind. Refuses a tree with uncommitted changes, as build.sh
# does, so the installed version always names what is in the tree.
set -euo pipefail

root=${T3FAC_REPO_ROOT:-$(git rev-parse --show-toplevel)}
source "$(dirname "${BASH_SOURCE[0]}")/lib/platform.sh"
cd "$root"

rebuild=0
build_only=0
for arg in "$@"; do
  case $arg in
    --rebuild) rebuild=1 ;;
    --build-only) build_only=1 ;;
    *)
      echo "usage: deploy.sh [--rebuild] [--build-only]" >&2
      exit 2
      ;;
  esac
done

if [[ -n $(git status --porcelain) ]]; then
  echo "deploy: refusing a tree with uncommitted changes; commit or remove them" >&2
  exit 1
fi

version=$(factory/scripts/build.sh --print-version)
archive="release/t3fac-${version}-${archive_suffix}.tar.gz"

if [[ $rebuild == 1 || ! -f $archive ]]; then
  factory/scripts/build.sh
  [[ -f $archive ]] || {
    echo "deploy: build.sh finished but $archive is missing" >&2
    exit 1
  }
else
  # build.sh prints the archive path when it builds; say the same here.
  echo "deploy: reusing $root/$archive (--rebuild to build it again)"
fi

[[ $build_only == 0 ]] || exit 0

factory/scripts/install.sh "$archive"
