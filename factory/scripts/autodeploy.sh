#!/usr/bin/env bash
# Keeps the server on origin/main. The autodeploy job (the io.github.rawphp.t3fac.autodeploy
# LaunchAgent, or the t3fac-autodeploy systemd timer on Linux) runs the copy install.sh puts in
# ~/.local/share/t3fac every 10 minutes, so it never runs from a tree that its own checkout
# changes. Each tick:
#
# - reads T3FAC_AUTODEPLOY_CLONE (a clone used for nothing else) and T3FAC_AUTODEPLOY_TOKEN (scope
#   orchestration:read) from ~/.config/t3fac/env; with no clone set it does nothing but remove
#   `deploy-pending`;
# - fetches origin and stops, printing nothing, when origin/main is the commit in `current`'s
#   `+fac.<sha>` or the commit whose deploy last failed;
# - after a deploy or rollback by hand, records origin/main as that commit, so what the person
#   installed stays until main moves;
# - writes `<epoch seconds> <sha>` to `deploy-pending` in the factory data dir while origin/main
#   has a commit it has not installed, keeping the first time across newer commits, and removes it
#   when nothing is pending; the server stops claiming issues while the file is there. The file is
#   rewritten every tick that reads the status and touched while a build runs, and the server takes
#   one older than 30 minutes as nothing pending, so an autodeploy that stopped ticking holds
#   nothing back;
# - asks GET /api/factory/status whether a factory run is in progress or an agent is at work in
#   any thread, and waits for the next tick when one is or when it cannot tell, logging how long
#   the build has waited; past `deploy_wait_minutes` (machine config, default 120) it deploys
#   whatever is in the way: factory runs resume on the new build, and a person's thread is
#   interrupted, which the person continues in T3;
# - while `deploy-snoozed` in the data dir holds a time in the future (the Factory page's snooze),
#   builds and installs nothing but keeps `deploy-pending` fresh; once that time has passed, the
#   wait counts again from it;
# - takes `deploy-now` in the data dir (the Factory page's update now) as the wait being past
#   `deploy_wait_minutes` when it names origin/main, and deletes it when main has moved on; both
#   files are deleted with `deploy-pending`;
# - checks the commit out and builds it with deploy.sh --build-only, asks again, then installs it
#   with deploy.sh, whose health check rolls back a bad version. A build that fails or runs past
#   its limit is tried on the next two ticks before the commit is given up on;
# - after a deploy that passed its health check, deletes the installed versions beyond `current`
#   and the `keep_versions` (machine config, default 3) installed before it.
#
# Prints one line per deploy, deleted version, failure or wait, which the job appends to
# autodeploy.log; the build's own output goes to autodeploy-build.log, replaced on each attempt.
set -euo pipefail

root="$HOME/.local/share/t3fac"
env_file="$HOME/.config/t3fac/env"
data_dir="$HOME/.config/t3fac/factory"
machine_config="$data_dir/config.yml"
# `<epoch seconds> <sha>`: the first time a build was left waiting, and the newest build waiting.
# The server reads it (claims.ts loadPendingDeploy) to stop claiming issues.
pending_file="$data_dir/deploy-pending"
# `<epoch seconds> <count>`: the end of a snooze and the snoozes so far (claims.ts snoozeDeploy).
# Until the end nothing is deployed.
snooze_file="$data_dir/deploy-snoozed"
# `<sha>`: install that build without waiting for the runs in progress (claims.ts requestDeployNow).
now_file="$data_dir/deploy-now"
# Minutes a build may wait for the runs in progress; config.ts DEFAULT_DEPLOY_WAIT_MINUTES is the
# same number, change both together.
deploy_wait_default=120
said_overdue=""
source "$(dirname "${BASH_SOURCE[0]}")/lib/platform.sh"
build_log="$logs/autodeploy-build.log"
failed_file="$root/autodeploy.failed"
hold_file="$root/autodeploy.hold"
# `<sha> <n>`: the commit whose build has failed n times in a row.
attempts_file="$root/autodeploy.attempts"
build_attempts=3
tick_lock="$root/autodeploy.lock"
deploy_lock="$root/deploy.lock"
job=$autodeploy_job
# T3FAC_PORT exists only so tests can point at a stub API; the server listens on 3876.
port=${T3FAC_PORT:-3876}
# How long a build may take. T3FAC_BUILD_LIMIT exists only so tests can make a build time out.
build_limit=${T3FAC_BUILD_LIMIT:-3600}
# Seconds between touches of the pending marker while a build runs. T3FAC_PENDING_REFRESH exists
# only so tests can shorten it.
pending_refresh=${T3FAC_PENDING_REFRESH:-300}
# The server's PENDING_STALE_MS in claims.ts is the same span; change both together.
pending_stale_minutes=30

say() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) autodeploy: $*"
}

# Seconds as 12s, 5m, 2h05m or 1d01h, as ledger/time.ts duration() writes them.
fmt_duration() {
  local s=$1
  if ((s < 60)); then
    printf '%ds' "$s"
  elif ((s < 3600)); then
    printf '%dm' $((s / 60))
  elif ((s < 86400)); then
    printf '%dh%02dm' $((s / 3600)) $((s % 3600 / 60))
  else
    printf '%dd%02dh' $((s / 86400)) $((s % 86400 / 3600))
  fi
}

# A snooze or an update now is for the build waiting, so it goes with it.
clear_pending() {
  rm -f "$pending_file" "$snooze_file" "$now_file"
}

# Prints the end of the snooze in deploy-snoozed, in epoch seconds, ended or not; nothing when
# there is none or its text is not whole seconds.
snooze_end() {
  local end=""
  read -r end _ 2> /dev/null < "$snooze_file" || true
  if [[ $end =~ ^[0-9]{1,12}$ ]]; then echo "$end"; fi
}

# Epoch seconds as RFC 3339 UTC to the second: 2026-10-30T04:25:15Z.
fmt_time() {
  date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2> /dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
}

if [[ -f $env_file ]]; then
  set +u
  # shellcheck disable=SC1090
  . "$env_file"
  set -u
fi
clone=${T3FAC_AUTODEPLOY_CLONE:-}
token=${T3FAC_AUTODEPLOY_TOKEN:-}
if [[ -z $clone ]]; then
  clear_pending
  exit 0
fi

mkdir -p "$root" "$logs"
source "$(dirname "${BASH_SOURCE[0]}")/lib/lock.sh"

release_locks() {
  release_lock "$tick_lock"
  release_lock "$deploy_lock"
}

# autodeploy.lock covers the whole tick, the clone and the build. deploy.lock, which install.sh
# and rollback.sh take too, is held only for the install, so a long build never locks a person
# out of rolling back.
if ! why=$(take_lock "$tick_lock" autodeploy); then
  say "$why"
  exit 0
fi
trap release_locks EXIT

# launchd starts no tick while this one runs, so a fetch that hangs would stop autodeploy for
# good: give up on a connection that stalls, and never wait on a prompt.
if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-"ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"} \
  git -C "$clone" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch -q origin 2> /dev/null; then
  say "cannot fetch origin in $clone"
  exit 1
fi
target=$(git -C "$clone" rev-parse origin/main)
short=$(git -C "$clone" rev-parse --short "$target")

installed=$(readlink "$root/current" 2> /dev/null || true)
installed=${installed##*+fac.}

# Returns 1 after a deploy or rollback by hand (lib/t3fac.sh's hold_autodeploy), first recording
# origin/main as a commit not to deploy, so the person's version is not undone before main moves.
hand_deployed() {
  [[ -f $hold_file ]] || return 0
  rm -f "$hold_file"
  clear_pending
  echo "$target" > "$failed_file"
  say "not deploying $short until main moves: a deploy or rollback was run by hand"
  return 1
}

# build.sh names the version with a short sha whose length git picks, so compare by prefix.
if [[ -n $installed && $target == "$installed"* ]]; then
  rm -f "$hold_file"
  clear_pending
  exit 0
fi
hand_deployed || exit 0
if [[ $(cat "$failed_file" 2> /dev/null || true) == "$target" ]]; then
  clear_pending
  exit 0
fi

# Records that $target is waiting to be installed. The time is that of the first build left
# waiting, so it survives main moving: the wait is measured from the oldest undeployed build. The
# file is written on every call, so its mtime shows the last tick that read the status.
mark_pending() {
  local since="" sha="" tmp end
  mkdir -p "$data_dir"
  read -r since _ 2> /dev/null < "$pending_file" || true
  [[ $since =~ ^[0-9]+$ ]] || since=$(date +%s)
  # A marker this old was ignored by the server, which may have claimed since: the wait starts
  # again. A short blip keeps the first-wait time.
  if [[ -n $(find "$pending_file" -mmin +"$pending_stale_minutes" 2> /dev/null) ]]; then
    since=$(date +%s)
  fi
  # A snooze that has ended starts the wait again from its end, as the server counts it.
  end=$(snooze_end)
  if [[ -n $end ]] && ((end <= $(date +%s) && end > since)); then since=$end; fi
  tmp="$data_dir/.deploy-pending.$$"
  echo "$since $target" > "$tmp"
  mv -f "$tmp" "$pending_file"
}

# Sets deploy_limit (minutes) from deploy_wait_minutes in the machine config, read as keep_versions
# is in prune_versions; deploy_limit_note says so when the key is there but cannot be read.
read_deploy_limit() {
  local value
  deploy_limit=$deploy_wait_default
  deploy_limit_note=""
  if grep -qE '^[^#]*deploy_wait_minutes' "$machine_config" 2> /dev/null; then
    value=$(sed -nE 's/^deploy_wait_minutes:[[:space:]]*([0-9]{1,9})[[:space:]]*(#.*)?$/\1/p' "$machine_config")
    if [[ $value =~ ^[0-9]+$ ]] && ((10#$value > 0)); then
      deploy_limit=$((10#$value))
    else
      deploy_limit_note=" (cannot read deploy_wait_minutes in $machine_config as one whole number up to 999999999; using $deploy_wait_default)"
    fi
  fi
}

# Returns 0 when nothing would be cut off by the restart. Otherwise prints why it is not deploying
# and returns 1: a run that may have a session or gate at work (any unfinished run not waiting on a
# person, including one whose file cannot be read), a pass running, a thread with an agent at
# work, or a status it cannot read. The pending marker is rewritten each tick that reads the status,
# busy or not, so the server drains through the build too. A tick that cannot ask leaves the file
# as it is: the server ignores one that is older than 30 minutes, which covers an autodeploy that
# cannot fetch, has no token, or is not running at all, and a blip does not lose the
# first-wait time. Once the build has waited past the limit this returns 0 whatever is in the way,
# a thread count T3 could not read included: the status cannot tell a person's thread from a
# factory run's, so it cannot spare one. Factory runs resume through the pass; a person's thread
# shows as interrupted in T3 and the person continues it.
factory_idle() {
  local body busy end asked=""
  # A person snoozed the build: keep the marker fresh so the status still shows it, and wait.
  end=$(snooze_end)
  if [[ -n $end ]] && ((end > $(date +%s))); then
    mark_pending
    say "not deploying $short: snoozed until $(fmt_time "$end")"
    return 1
  fi
  if [[ -z $token ]]; then
    say "not deploying $short: T3FAC_AUTODEPLOY_TOKEN is not set in $env_file"
    return 1
  fi
  # The header goes on stdin, so the token never shows in ps.
  if ! body=$(curl -fsS -m 10 -H @- "http://127.0.0.1:$port/api/factory/status" \
    <<< "Authorization: Bearer $token" 2> /dev/null); then
    say "not deploying $short: cannot read http://127.0.0.1:$port/api/factory/status"
    return 1
  fi
  # A server from before the thread count has no `threads`; it counts as none, so a rollback to
  # one does not stop autodeploy for good. A count T3 could not read is null, and waits like a
  # thread at work: until deploy_wait_minutes. The Factory page's Update now asks first by the same
  # rule (apps/web/src/factory/updateInterrupts.ts).
  if ! busy=$(jq -r 'if .passes.running == true or any(.runs[];
      .unreadable or ((.state // "") | IN("pr-open", "needs-info", "stuck") | not))
    then "a factory run is in progress"
    elif .threads != null and .threads.running != 0 then "an agent is at work in a thread"
    else "" end' <<< "$body" 2> /dev/null); then
    say "not deploying $short: cannot read the factory status"
    return 1
  fi
  mark_pending
  # Asked from the Factory page: as if the build had waited past the limit. The request names the
  # build the person saw; a newer one waits as normal.
  read -r asked _ 2> /dev/null < "$now_file" || true
  if [[ -n $asked && $asked != "$target" ]]; then
    rm -f "$now_file"
    say "not taking the update now asked for ${asked:0:9}: main has moved to $short"
    asked=""
  fi
  if [[ -n $asked ]]; then
    [[ -n $said_overdue ]] || say "deploying $short now, as asked from the Factory page${busy:+, although $busy}"
    said_overdue=1
    return 0
  fi
  if [[ -n $busy ]]; then
    local since="" now waited
    read -r since _ 2> /dev/null < "$pending_file" || true
    now=$(date +%s)
    [[ $since =~ ^[0-9]+$ ]] || since=$now
    waited=$((now - since))
    read_deploy_limit
    if ((waited >= deploy_limit * 60)); then
      # factory_idle runs again after the build; the line is said once.
      [[ -n $said_overdue ]] || say "deploying $short although $busy: the build has waited $(fmt_duration "$waited"), past deploy_wait_minutes $deploy_limit; factory runs in progress resume on the new build, a person's thread is interrupted$deploy_limit_note"
      said_overdue=1
      return 0
    fi
    say "waiting to deploy $short: $busy; waited $(fmt_duration "$waited") of deploy_wait_minutes $deploy_limit$deploy_limit_note"
    return 1
  fi
}

failed() {
  rm -f "$attempts_file"
  clear_pending
  echo "$target" > "$failed_file"
  say "deploy of $short failed; ${installed:+still on $installed; }not trying it again until main moves; see $build_log"
  exit 1
}

# A build can fail on the network as well as on the commit, so it is tried $build_attempts times,
# one a tick, before failed gives the commit up. $1 says how this attempt failed.
build_failed() {
  local sha count n=1
  read -r sha count 2> /dev/null < "$attempts_file" || true
  if [[ ${sha:-} == "$target" && ${count:-} =~ ^[0-9]+$ ]]; then n=$((count + 1)); fi
  ((n < build_attempts)) || failed
  echo "$target $n" > "$attempts_file"
  say "build of $short $1 (attempt $n of $build_attempts); trying again next tick; see $build_log"
  exit 1
}

# Checks the commit out and builds it, killing the build's process group after $build_limit
# seconds: launchd starts no tick while this one runs, so a build that hangs on the network would
# stop autodeploy for good. Returns 124 on a timeout. set -m gives each background job a process
# group of its own, so one kill reaches every process the build started.
build() {
  local pid watchdog refresher status=0 timed_out="$root/.autodeploy-timeout.$$"
  rm -f "$timed_out"
  set -m
  {
    git -C "$clone" checkout -q --detach "$target" &&
      (cd "$clone" && factory/scripts/deploy.sh --build-only)
  } &
  pid=$!
  {
    sleep "$build_limit"
    touch "$timed_out"
    kill -TERM -- "-$pid"
  } 2> /dev/null &
  watchdog=$!
  # The server takes a marker older than 30 minutes as nothing pending, and a build can run an
  # hour, so the marker is touched while it runs. Its content stays; the server reads the mtime.
  # The loop ends with this script however it ends, so a killed tick cannot keep the marker fresh.
  {
    while sleep "$pending_refresh" && kill -0 $$; do
      touch -c "$pending_file"
    done
  } 2> /dev/null &
  refresher=$!
  set +m
  wait "$pid" || status=$?
  kill -TERM -- "-$watchdog" 2> /dev/null || true
  wait "$watchdog" 2> /dev/null || true
  kill -TERM -- "-$refresher" 2> /dev/null || true
  wait "$refresher" 2> /dev/null || true
  if [[ -e $timed_out ]]; then
    rm -f "$timed_out"
    return 124
  fi
  return "$status"
}

# Deletes the version directories beyond `current` and the keep_versions others to keep, so
# versions/ does not fill the disk. `previous` is kept first, so rollback.sh still has its version
# whenever keep_versions is at least 1; the rest go by install time, the directory's mtime, which
# install.sh's unpack into a fresh directory sets. Both links are matched by the directory they
# reach (-ef), not their text, which a hand repair can make absolute and install.sh then copies
# into `previous`. Deletes nothing when no version directory is `current`. Prints a line per
# directory it deletes.
prune_versions() {
  local keep=3 previous="" name kept=0 found=0
  local -a others=() order=()
  # The server reads the file as YAML, which accepts forms this does not (a quoted or spaced key,
  # a BOM). Any uncommented mention of the key that is not one plain `keep_versions: <n>` line
  # stops the prune rather than falling back to the default. Nine digits at most keeps n inside
  # bash's integer range.
  if grep -qE '^[^#]*keep_versions' "$machine_config" 2> /dev/null; then
    keep=$(sed -nE 's/^keep_versions:[[:space:]]*([0-9]{1,9})[[:space:]]*(#.*)?$/\1/p' "$machine_config")
    if [[ ! $keep =~ ^[0-9]+$ ]]; then
      say "not pruning versions: cannot read keep_versions in $machine_config as one whole number up to 999999999"
      return 0
    fi
  fi
  while IFS= read -r name; do
    [[ -d $root/versions/$name ]] || continue
    if [[ $root/versions/$name -ef $root/current ]]; then
      found=1
    elif [[ -z $previous && $root/versions/$name -ef $root/previous ]]; then
      previous=$name
    else
      others+=("$name")
    fi
  done < <(ls -t "$root/versions" 2> /dev/null)
  ((found)) || return 0
  [[ -z $previous ]] || order+=("$previous")
  order+=(${others[@]+"${others[@]}"})
  for name in ${order[@]+"${order[@]}"}; do
    if ((kept < 10#$keep)); then
      kept=$((kept + 1))
    elif rm -rf "${root:?}/versions/$name"; then
      say "pruned versions/$name"
    else
      say "could not prune versions/$name"
    fi
  done
}

factory_idle || exit 0

# deploy.sh's install.sh reloads every timer job; T3FAC_SKIP_RELOAD keeps it from booting this
# job out, which would kill this deploy.
export T3FAC_SKIP_RELOAD=$job
: > "$build_log"
status=0
build >> "$build_log" 2>&1 || status=$?
if ((status == 124)); then build_failed "took over ${build_limit}s and was stopped"; fi
((status == 0)) || build_failed failed

# During the build a run may have started, or a person may have deployed by hand or be doing so.
factory_idle || exit 0
if ! why=$(take_lock "$deploy_lock" deploy); then
  say "$why"
  exit 0
fi
hand_deployed || exit 0
# The install.sh this runs sees it already holds the lock.
export T3FAC_DEPLOY_LOCK=$$

(cd "$clone" && factory/scripts/deploy.sh) >> "$build_log" 2>&1 || failed
rm -f "$attempts_file"
clear_pending
say "deployed $short"
prune_versions
