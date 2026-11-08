#!/usr/bin/env bash
# Merges upstream's newest nightly tag into main through a pull request, in two
# phases that .github/workflows/factory-sync.yml runs as two jobs:
#
#   sync.sh prepare <dir>   no token: merge, install, regenerate, check
#   sync.sh publish <dir>   the write token, git and gh only: push, land, file
#   sync.sh                 both in turn, from one checkout
#
# prepare runs upstream's code (`vp i`, the route generator, check.sh), so it
# runs where no write token exists. It picks the newest v*-nightly.* tag at the
# upstream repo by version order and stops at "up to date" when main's
# factory/UPSTREAM names it, or at "exists" when sync/<tag> is already on
# origin. Otherwise it creates sync/<tag> from origin/main, merges the tag with
# --no-ff, regenerates apps/web/src/routeTree.gen.ts when only that file
# conflicts, records <tag> <sha> in factory/UPSTREAM, commits, runs
# factory/scripts/check.sh, and bundles the branch. It writes the outcome to
# <dir> and exits 0; anything else (a merge that fails without a conflict) exits
# 1 and publishes nothing.
#
# publish treats <dir> as untrusted. It refuses a bundled branch that is not the
# merge of a commit on main and the tag, with only factory/UPSTREAM and a
# conflicted route tree differing from what git merges itself. Two things stay
# prepare's word, since checking them means running upstream's code: whether the
# checks passed, and the content of a regenerated route tree. A compromised
# prepare can land upstream's merge unchecked, but a regenerated route tree
# never lands without a person. Green: push sync/<tag>, open `sync: <tag>` and
# fast-forward main to the checked merge commit, which merges it; when main
# moved meanwhile, or the route tree was regenerated, the pull request waits for
# a person. Red: push, open it as a
# draft, and file `Sync to <tag> fails checks` with the failing step and the
# last 200 lines of its output. A conflict in any other file, a failing `vp i`
# or generator, a refused push, a refused fast-forward and a regenerated route
# tree each file their own issue (`conflicts`, `fails checks`, `cannot be
# pushed`, `cannot land`, `needs a route-tree review`) and
# exit 1; an open issue of the same kind gets a comment and the new tag in its
# title instead, so a lasting problem keeps one issue. A sync branch already on
# origin waits on its open pull request, or files `is stuck` when it has none.
# gh targets origin's GitHub repository, never the fork's parent.
#
# publish's pushes use the GitHub App's token when SYNC_APP_CONFIGURED is true
# (SYNC_APP_TOKEN, empty when the workflow could not mint it, which fails the
# push), else SYNC_TOKEN when set, else whatever git is configured with:
# GITHUB_TOKEN in the workflow. A refused push names the token, and when it was
# GITHUB_TOKEN the secrets to add. Fetches and gh calls never use a sync secret.
#
# Pull requests opened with GITHUB_TOKEN trigger no workflows, which is why the
# checks run here and the landing happens only when they pass. The landing push
# triggers none either, so inside the workflow (GITHUB_ACTIONS set) publish
# dispatches Factory CI, Factory desktop and, when the merge touched apps/mobile
# or packages, Factory mobile on the landed main. A landing pushed with a sync
# secret starts them itself, so publish then dispatches only Factory mobile, for
# the reason dispatch() gives. A failed dispatch leaves the landing in place
# and exits 1. Run locally, the person's own push starts them.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

upstream=${SYNC_UPSTREAM:-https://github.com/pingdotgg/t3code}
base=main
route_tree=apps/web/src/routeTree.gen.ts
tag_pattern='^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+\.[0-9]+$'

# Runs a command, printing its output and keeping it in <log>; returns its status.
run_logged() {
  local log=$1 status
  shift
  set +e
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

# The token publish pushes with, as the workflow passes it; see the header.
push_with=
if [[ ${SYNC_APP_CONFIGURED:-} == true ]]; then
  push_with=SYNC_APP_ID
elif [[ -n ${SYNC_TOKEN:-} ]]; then
  push_with=SYNC_TOKEN
elif [[ -n ${GITHUB_ACTIONS:-} ]]; then
  push_with=GITHUB_TOKEN
fi
dispatched=

# git push with the sync secret's token in place of git's own credentials. The
# token reaches git's credential helper through the environment, not argv.
push_origin() {
  local token
  case $push_with in
    SYNC_APP_ID) token=${SYNC_APP_TOKEN:-} ;;
    SYNC_TOKEN) token=$SYNC_TOKEN ;;
    *)
      git push "$@"
      return
      ;;
  esac
  if [[ -z $token ]]; then
    echo "sync: no SYNC_APP_ID token was minted; the workflow's Mint step says why" >&2
    return 1
  fi
  # shellcheck disable=SC2016 # the helper's shell expands it, from git's env
  SYNC_PUSH_TOKEN=$token git -c credential.helper= \
    -c credential.helper='!f() { echo username=x-access-token; echo "password=$SYNC_PUSH_TOKEN"; }; f' \
    push "$@"
}

# Records the outcome for publish and ends prepare.
outcome() {
  echo "$1" > "$out/outcome"
  echo "sync: prepared $1"
  exit 0
}

# A step that fails before anything is committed: abort the merge and record
# the step, its status and the last 200 lines of its output.
stopped() {
  local step=$1 status=$2 log=$3
  git merge --abort
  echo "$step" > "$out/step"
  echo "$status" > "$out/status"
  tail -n 200 "$log" > "$out/output.txt"
  outcome stopped
}

prepare() {
  out=$1
  mkdir -p "$out"
  local current tag sha branch others conflicts status=0 check_status=0

  tag=$(git ls-remote --refs --tags --sort=-version:refname "$upstream" 'v*-nightly.*' |
    awk 'NR == 1 { sub(".*refs/tags/", ""); print }')
  if [[ -z $tag ]]; then
    echo "sync: no v*-nightly.* tag at $upstream" >&2
    exit 1
  fi
  if [[ ! $tag =~ $tag_pattern ]]; then
    echo "sync: unexpected tag name: $tag" >&2
    exit 1
  fi
  echo "newest nightly: $tag"
  echo "$tag" > "$out/tag"

  # What main records, not the checkout, which an earlier local run may have
  # left on a sync branch.
  git fetch --quiet origin "$base"
  read -r current _ < <(git show "origin/$base:factory/UPSTREAM")
  if [[ $current == "$tag" ]]; then
    outcome up-to-date
  fi

  branch="sync/$tag"
  if git ls-remote --exit-code --heads origin "$branch" > /dev/null; then
    outcome exists
  fi

  git fetch --quiet --no-tags "$upstream" "refs/tags/$tag:refs/tags/$tag"
  sha=$(git rev-parse "$tag^{commit}")
  echo "$sha" > "$out/sha"
  git checkout --quiet -B "$branch" "origin/$base"

  local route_tree_conflicted=0
  if ! git merge --no-ff --no-commit "$tag" > "$out/merge.log" 2>&1; then
    conflicts=$(git diff --name-only --diff-filter=U)
    if [[ -z $conflicts ]]; then
      echo "sync: git merge $tag failed:" >&2
      cat "$out/merge.log" >&2
      exit 1
    fi
    others=$(grep -vxF "$route_tree" <<< "$conflicts" || true)
    if [[ -n $others ]]; then
      git merge --abort
      echo "$others" > "$out/conflicts"
      outcome conflicts
    fi
    route_tree_conflicted=1
  fi

  run_logged "$out/install.log" vp i || status=$?
  [[ $status == 0 ]] || stopped "vp i" "$status" "$out/install.log"
  if [[ $route_tree_conflicted == 1 ]]; then
    run_logged "$out/regenerate.log" factory/scripts/regenerate-routes.sh || status=$?
    [[ $status == 0 ]] || stopped factory/scripts/regenerate-routes.sh "$status" "$out/regenerate.log"
    git add "$route_tree"
  fi
  echo "$tag $sha" > factory/UPSTREAM
  git add factory/UPSTREAM
  git commit --quiet -m "sync: $tag"

  run_logged "$out/check.log" factory/scripts/check.sh || check_status=$?
  git bundle create --quiet "$out/sync.bundle" "origin/$base..$branch"
  [[ $check_status == 0 ]] && outcome green

  awk '/^check: / { step = substr($0, 8) } END { print step }' "$out/check.log" > "$out/step"
  echo "$check_status" > "$out/status"
  awk '/^check: / { out = "" ; next } { out = out $0 "\n" } END { printf "%s", out }' \
    "$out/check.log" | tail -n 200 > "$out/output.txt"
  outcome red
}

# Files `Sync to <tag> <kind>`, or comments on the open issue of that kind and
# retitles it to this tag, so a problem that lasts across tags keeps one issue.
# An issue the factory is claiming or building keeps its title: the factory
# reads a title change from someone who is not an instructor as the issue
# changing under it, and stops the run. The search is fuzzy, so the exact match
# happens here, not in gh. Extra arguments go to `gh issue create`.
file_issue() {
  local kind=$1 body=$2
  shift 2
  local title="Sync to $tag $kind" match number labels
  match=$(gh issue list --state open --search "\"$kind\" in:title" --json number,title,labels \
    --jq '.[] | "\(.number)\t\(.title)\t\([.labels[].name] | join(","))"' |
    awk -F '\t' -v kind="$kind" '
      $2 ~ ("^Sync to v[0-9]+\\.[0-9]+\\.[0-9]+-nightly\\.[0-9]+\\.[0-9]+ " kind "$") { print $1 "\t" $3; exit }')
  IFS=$'\t' read -r number labels <<< "$match"
  if [[ -n $number ]]; then
    [[ ",$labels," =~ ,factory:(ready|triage|building|pr-open), ]] ||
      gh issue edit "$number" --title "$title"
    gh issue comment "$number" --body-file "$body"
  else
    gh issue create --title "$title" "$@" --body-file "$body"
  fi
}

# Files `Sync to <tag> fails checks` with a summary naming the failed step and
# the last 200 lines of its output, then exits 1.
fails_checks() {
  local summary=$1
  {
    echo "$summary"
    echo
    echo "Last 200 lines of its output:"
    echo
    echo '```'
    tail -n 200 "$out/output.txt"
    echo '```'
  } > "$scratch/fails.md"
  file_issue "fails checks" "$scratch/fails.md" --label factory:proposed
  exit 1
}

# Dispatches the workflows a push to main would have started and the landing
# push did not, on the landed main, and sets $dispatched to their files. <before>
# is main before the landing. A push with a sync secret starts Factory CI,
# desktop and server, but GitHub matches Factory mobile's paths filter against
# only the first 300 changed files, which a sync can pass, so mobile is
# dispatched after any push; its concurrency group keeps one build when the push
# started it too.
# Every one is tried; each that fails gets its own line, then publish exits 1.
dispatch() {
  local before=$1 workflow failed=0 workflows=()
  [[ $push_with != GITHUB_TOKEN ]] || workflows=(factory-ci.yml factory-desktop.yml factory-server.yml)
  if [[ -n $(git diff --name-only "$before..$candidate" -- apps/mobile packages) ]]; then
    workflows+=(factory-mobile.yml)
  fi
  ((${#workflows[@]})) || return 0
  for workflow in "${workflows[@]}"; do
    if ! gh workflow run "$workflow" --ref "$base"; then
      echo "sync: $tag merged into $base through $pr_url; dispatch of $workflow failed" >&2
      failed=1
    fi
  done
  ((failed == 0)) || exit 1
  printf -v dispatched '%s, ' "${workflows[@]}"
  dispatched=${dispatched%, }
}

# Fails publish when the bundled branch is anything but what prepare should
# have built: the merge of a commit on main and the tag, where only
# factory/UPSTREAM (naming the tag) and a conflicted route tree differ from the
# tree git merges itself. Sets $candidate, and $route_tree_regenerated to 1
# when the route tree conflicted, so its content is prepare's alone.
verify_candidate() {
  local refuse="sync: the prepared $branch is not the merge of $base and $tag; not publishing it"
  local first second extra merged merge_status=0 tree conflicted allowed path
  git fetch --quiet --no-tags "$upstream" "refs/tags/$tag:refs/tags/$tag"
  sha=$(git rev-parse "$tag^{commit}")
  git fetch --quiet "$out/sync.bundle" "+refs/heads/$branch:refs/sync/candidate"
  candidate=$(git rev-parse refs/sync/candidate)
  read -r _ first second extra < <(git rev-list --parents -n 1 "$candidate")
  if [[ -n $extra || $second != "$sha" ]] ||
    ! git merge-base --is-ancestor "$first" "origin/$base"; then
    echo "$refuse" >&2
    exit 1
  fi
  merged=$(git merge-tree --write-tree --name-only --no-messages "$first" "$sha") || merge_status=$?
  if ((merge_status > 1)); then
    echo "$refuse" >&2
    exit 1
  fi
  tree=$(head -n 1 <<< "$merged")
  conflicted=$(tail -n +2 <<< "$merged" | sed '/^$/d')
  allowed=factory/UPSTREAM
  route_tree_regenerated=0
  if [[ $conflicted == "$route_tree" ]]; then
    allowed+=$'\n'$route_tree
    route_tree_regenerated=1
  elif [[ -n $conflicted ]]; then
    echo "$refuse" >&2
    exit 1
  fi
  while IFS= read -r path; do
    if ! grep -qxF "$path" <<< "$allowed"; then
      echo "$refuse: it changes $path" >&2
      exit 1
    fi
  done < <(git diff --name-only "$tree" "$candidate^{tree}")
  if [[ $(git show "$candidate:factory/UPSTREAM") != "$tag $sha" ]]; then
    echo "$refuse: factory/UPSTREAM does not name $tag $sha" >&2
    exit 1
  fi
}

publish() {
  out=$1
  local result branch pr_url step status
  scratch=$(mktemp -d)
  trap 'rm -rf "$scratch"' EXIT

  # Every gh call targets origin's repository. Without this, gh run in a fork's
  # checkout opens pull requests and issues on the parent.
  local origin_url
  origin_url=$(git config --get remote.origin.url || true)
  if [[ $origin_url =~ github\.com[:/]([^/]+/[^/]+)$ ]]; then
    export GH_REPO=${BASH_REMATCH[1]%.git}
  else
    echo "sync: origin is not a GitHub repository: $origin_url" >&2
    exit 1
  fi

  result=$(cat "$out/outcome")
  case $result in
    up-to-date)
      echo "up to date"
      exit 0
      ;;
    exists | conflicts | stopped | green | red) ;;
    *)
      echo "sync: unknown outcome: $result" >&2
      exit 1
      ;;
  esac
  tag=$(cat "$out/tag")
  if [[ ! $tag =~ $tag_pattern ]]; then
    echo "sync: unexpected tag name: $tag" >&2
    exit 1
  fi
  branch="sync/$tag"
  git fetch --quiet origin "$base"

  # A sync branch already on origin belongs to an earlier run: its open pull
  # request waits for a person, who has the issue that run filed (`fails checks`
  # or `cannot land`); without one, the run that pushed it stopped early.
  if [[ $result == exists ]]; then
    pr_url=$(gh pr list --head "$branch" --state open --json url --jq '.[0].url // empty')
    if [[ -n $pr_url ]]; then
      echo "sync: $tag waits on $pr_url"
      exit 0
    fi
    echo "sync: $branch is on origin with no open pull request; $tag is not synced" >&2
    {
      echo "\`$branch\` is on \`origin\` with no open pull request, so \`$tag\` is not synced."
      echo "An earlier run pushed it and stopped before its pull request was opened, or the"
      echo "pull request was closed. Delete the branch to sync the tag again."
    } > "$scratch/stuck.md"
    file_issue "is stuck" "$scratch/stuck.md"
    exit 1
  fi

  if [[ $result == conflicts ]]; then
    {
      echo "Merging \`$tag\` into \`$base\` conflicts in these files:"
      echo
      sed 's/^/- /' "$out/conflicts"
      echo
      echo "The installed fork stays where it is until the merge is done by hand:"
      echo "create \`$branch\` from \`$base\`, run \`git merge --no-ff $tag\`, resolve"
      echo "these paths, run \`factory/scripts/regenerate-routes.sh\` if \`$route_tree\`"
      echo "conflicts too, write \`$tag <its commit>\` to \`factory/UPSTREAM\`, and open the pull request."
    } > "$scratch/conflicts.md"
    file_issue conflicts "$scratch/conflicts.md"
    exit 1
  fi

  step=$(head -n 1 "$out/step" 2> /dev/null || true)
  status=$(head -n 1 "$out/status" 2> /dev/null || true)
  if [[ $result == stopped ]]; then
    echo "sync: $step failed with exit $status; $tag is not synced" >&2
    fails_checks "Merging \`$tag\` into \`$base\` stopped: \`$step\` failed with exit $status, so nothing was pushed."
  fi

  verify_candidate
  if ! push_origin --quiet origin "$candidate:refs/heads/$branch" 2> "$scratch/push.log"; then
    cat "$scratch/push.log" >&2
    echo "sync: push of $branch failed; $tag is not synced" >&2
    {
      echo "\`$branch\` merges \`$tag\` ($sha), but pushing it failed, so nothing reached \`$base\`."
      if [[ $push_with == GITHUB_TOKEN ]]; then
        echo "This run pushed with \`GITHUB_TOKEN\`, which cannot push changes under"
        echo "\`.github/workflows/\`. Add the \`SYNC_APP_ID\` and \`SYNC_APP_PRIVATE_KEY\` repository"
        echo "secrets (a GitHub App installed on this repository with Contents and Workflows"
        echo "read/write), or a \`SYNC_TOKEN\` secret (a fine-grained token for this repository"
        echo "with Contents and Workflows write), then run the sync again."
      elif [[ -n $push_with ]]; then
        echo "This run pushed with \`$push_with\`; check that it is current and can still write"
        echo "contents and workflows on this repository."
      else
        echo "When the tag changes \`.github/workflows/\`, the push needs a token with the"
        echo "workflows permission."
      fi
      echo
      echo '```'
      tail -n 50 "$scratch/push.log"
      echo '```'
    } > "$scratch/push.md"
    file_issue "cannot be pushed" "$scratch/push.md"
    exit 1
  fi

  if [[ $result == green ]]; then
    {
      echo "Merges upstream \`$tag\` ($sha) into \`$base\`."
      echo
      if [[ $route_tree_regenerated == 1 ]]; then
        echo "\`factory/scripts/check.sh\` passed. \`$route_tree\` was regenerated after a"
        echo "conflict, so a person reviews it and merges this."
      else
        echo "\`factory/scripts/check.sh\` passed, so this merges on its own."
      fi
    } > "$scratch/pr.md"
    pr_url=$(gh pr create --base "$base" --head "$branch" --title "sync: $tag" --body-file "$scratch/pr.md")
    # A regenerated route tree is code publish cannot check without running
    # upstream's generator, so a person reviews it and merges.
    if [[ $route_tree_regenerated == 1 ]]; then
      echo "sync: $tag regenerated $route_tree; $pr_url waits for a person" >&2
      {
        echo "\`$branch\` merges \`$tag\` ($sha) and passed the checks, but \`$route_tree\`"
        echo "conflicted, so the branch carries a route tree the unprivileged job regenerated."
        echo "Nothing checks that file without running upstream's generator, so this does not"
        echo "land on its own: review the file in the pull request, then merge it. Until then"
        echo "each run waits on it."
        echo "Pull request: $pr_url"
      } > "$scratch/route-tree.md"
      file_issue "needs a route-tree review" "$scratch/route-tree.md"
      exit 1
    fi
    # Fast-forwarding main to the checked merge commit lands exactly what the
    # checks ran on, and GitHub marks the pull request merged. When main moved
    # meanwhile, the push is refused and the pull request waits for a person.
    local before
    before=$(git rev-parse "origin/$base")
    if push_origin --quiet origin "$candidate:refs/heads/$base" 2> "$scratch/land.log"; then
      [[ -z ${GITHUB_ACTIONS:-} ]] || dispatch "$before"
      if [[ -n $dispatched ]]; then
        echo "sync: $tag merged into $base through $pr_url; dispatched $dispatched"
      else
        echo "sync: $tag merged into $base through $pr_url"
      fi
      exit 0
    fi
    cat "$scratch/land.log" >&2
    echo "sync: $base could not be fast-forwarded to $branch; $pr_url waits for a person" >&2
    {
      echo "\`$branch\` merges \`$tag\` ($sha) and passed the checks, but \`$base\` could not be"
      echo "fast-forwarded to it: \`$base\` moved while the checks ran, or it refuses the push."
      echo "The checks ran on the \`$base\` the branch was cut from, not the current one, so"
      echo "this needs a person: merge \`$base\` into the branch, run \`factory/scripts/check.sh\`,"
      echo "then merge the pull request. Until then each run waits on it."
      echo "Pull request: $pr_url"
    } > "$scratch/land.md"
    file_issue "cannot land" "$scratch/land.md"
    exit 1
  fi

  {
    echo "Merges upstream \`$tag\` ($sha) into \`$base\`."
    echo
    echo "\`$step\` failed (exit $status), so this stays a draft."
  } > "$scratch/pr.md"
  pr_url=$(gh pr create --draft --base "$base" --head "$branch" --title "sync: $tag" --body-file "$scratch/pr.md")
  fails_checks "\`$branch\` merges \`$tag\` ($sha) cleanly, but \`$step\` failed with exit $status.
Pull request: $pr_url"
}

case ${1:-} in
  prepare | publish)
    [[ $# == 2 ]] || {
      echo "usage: sync.sh [prepare <dir> | publish <dir>]" >&2
      exit 2
    }
    "$1" "$2"
    ;;
  "")
    dir=$(mktemp -d)
    (prepare "$dir")
    publish "$dir"
    ;;
  *)
    echo "usage: sync.sh [prepare <dir> | publish <dir>]" >&2
    exit 2
    ;;
esac
