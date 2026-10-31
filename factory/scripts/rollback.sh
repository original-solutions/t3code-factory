#!/usr/bin/env bash
# Points `current` at the version installed before it, restarts the server's job and
# checks it comes up. Also reinstalls the log rotation and autodeploy jobs. Exits 1 when there
# is no earlier version or the restored one is unhealthy.
set -euo pipefail

source "$(dirname "$0")/lib/t3fac.sh"

take_deploy_lock || exit 1
trap release_deploy_lock EXIT

if [[ ! -L $root/previous || ! -e $root/previous ]]; then
  echo "no earlier version to roll back to" >&2
  exit 1
fi

target=$(readlink "$root/previous")
# `current` can be missing after a hand repair; the rollback still restores `previous`.
from=$(readlink "$root/current" || true)
hold_autodeploy
ln -sfn "$target" "$root/current"

restart_timer_jobs_or_warn
restart_job

# Only now is the rollback done; a failed restart above leaves `previous` for a rerun.
rm -f "$root/previous"

if ! wait_healthy "${target#versions/}"; then
  echo "rollback to ${target#versions/}${from:+ from ${from#versions/}} failed its health check" >&2
  exit 1
fi

echo "rolled back to ${target#versions/}"
