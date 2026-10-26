#!/usr/bin/env bash
# Fails when HEAD differs from the upstream commit named in factory/UPSTREAM in a
# file that is neither factory-owned nor listed in factory/SEAMS. Only committed
# changes count; staged, unstaged and untracked files are not checked.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
read -r _ref sha < "$root/factory/UPSTREAM"

if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
  git fetch --quiet https://github.com/pingdotgg/t3code "$sha"
fi

# Captured first so set -e stops the script when the diff fails.
changed=$(git diff --name-only --no-renames "$sha" HEAD)

bad=0
while IFS= read -r path; do
  [[ -n $path ]] || continue
  case "$path" in
    apps/server/src/factory/*|apps/web/src/factory/*|apps/desktop/src/factory/*|apps/mobile/src/factory/*|factory/*|.dw/*|apps/web/src/routes/factory*|apps/web/src/routes/_chat.settings.factory*|.github/workflows/factory-*)
      continue ;;
  esac
  if grep -qxF -- "$path" "$root/factory/SEAMS"; then
    continue
  fi
  echo "check-seams: not a listed seam: $path"
  bad=1
done <<< "$changed"

exit "$bad"
