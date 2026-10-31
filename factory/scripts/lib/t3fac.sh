# Sourced by install.sh and rollback.sh: where versions live, the jobs (the server, the log rotator
# and the autodeploy timer; LaunchAgents on macOS, systemd user units on Linux), how to restart
# them and how to tell the server came up.

source "$(dirname "${BASH_SOURCE[0]}")/platform.sh"

root="$HOME/.local/share/t3fac"
label=$server_job
# launchd/ holds the plists, systemd/ the units.
templates="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/systemd"
[[ $host_os != Darwin ]] || templates="$(dirname "$templates")/launchd"
units="$HOME/.config/systemd/user"
# The second job rotates $log on a timer, so a crash-looping server cannot outgrow the disk.
logrotate_label=$logrotate_job
# The third runs autodeploy.sh on a timer, which installs origin/main when it moves.
autodeploy_label=$autodeploy_job
log="$logs/t3fac.log"
# The log and port the server's template writes to and serves on; change them together.
# T3FAC_PORT exists only so tests can point the health check at a stub listener; the template still
# says 3876.
port=${T3FAC_PORT:-3876}

source "$(dirname "${BASH_SOURCE[0]}")/lock.sh"

# One deploy at a time.
deploy_lock="$root/deploy.lock"

# Takes $deploy_lock for this script and the scripts it runs; release_deploy_lock, run on exit,
# gives it back. Returns 1 naming the holder when another live process has it. A script whose
# caller holds it (T3FAC_DEPLOY_LOCK is the pid the lock points at, which the taker exports) runs
# under the caller's lock and leaves it alone, so install.sh can run rollback.sh and
# autodeploy.sh can run install.sh.
take_deploy_lock() {
  local holder
  holder=$(readlink "$deploy_lock" 2> /dev/null || true)
  if [[ -n $holder && $holder == "${T3FAC_DEPLOY_LOCK:-}" ]]; then return 0; fi
  mkdir -p "$root"
  take_lock "$deploy_lock" deploy >&2 || return 1
  export T3FAC_DEPLOY_LOCK=$$
}

release_deploy_lock() {
  release_lock "$deploy_lock"
}

# A deploy or rollback run by hand leaves autodeploy.hold, so autodeploy.sh does not undo it on its
# next tick: that tick holds off until main moves. autodeploy.sh sets T3FAC_SKIP_RELOAD to its own
# job, which is how its own deploys, and the rollback of one, are told apart.
hold_autodeploy() {
  [[ ${T3FAC_SKIP_RELOAD:-} == "$autodeploy_label" ]] || : > "$root/autodeploy.hold"
}

# Waits for launchd to report job $2 unloaded, up to T3FAC_UNLOAD_WAIT seconds (10).
wait_unloaded() {
  local uid=$1 job=$2 wait=${T3FAC_UNLOAD_WAIT:-10} i
  for ((i = 0; i < wait * 5; i++)); do
    launchctl print "gui/$uid/$job" > /dev/null 2>&1 || return 0
    sleep 0.2
  done
  echo "job $job is still loaded ${wait}s after bootout" >&2
  return 1
}

# Writes job file $2 from template $1, filling in @HOME@.
render_template() {
  mkdir -p "$(dirname "$2")" && sed "s|@HOME@|$HOME|g" "$1" > "$2"
}

# Boots job $1 out when it is loaded, waits for it to unload and bootstraps it from plist $2.
# Returns 1 without bootstrapping when it does not unload, even where set -e is off.
reload_job() {
  local job=$1 file=$2 uid
  uid=$(id -u)
  if launchctl print "gui/$uid/$job" > /dev/null 2>&1; then
    launchctl bootout "gui/$uid/$job"
    wait_unloaded "$uid" "$job" || return 1
  fi
  launchctl bootstrap "gui/$uid" "$file"
}

# Writes job $1's files from their templates and (re)starts it. A LaunchAgent is booted out and
# back in. A systemd job's units are rewritten and reread, then its timer, or the server's service
# when it has none, is enabled and restarted. Returns non-zero on any failure, even where set -e
# is off.
load_job() {
  local job=$1 unit
  if [[ $host_os == Darwin ]]; then
    render_template "$templates/$job.plist" "$HOME/Library/LaunchAgents/$job.plist" &&
      reload_job "$job" "$HOME/Library/LaunchAgents/$job.plist"
    return
  fi
  unit=$job.service
  render_template "$templates/$job.service" "$units/$job.service" || return 1
  if [[ -f $templates/$job.timer ]]; then
    render_template "$templates/$job.timer" "$units/$job.timer" || return 1
    unit=$job.timer
  fi
  systemctl --user daemon-reload &&
    systemctl --user enable --quiet "$unit" &&
    systemctl --user restart "$unit"
}

# The inode of file $1, or nothing when it is missing. rotate-log.sh moves a fresh copy onto
# $log.1, so a different inode there means a rotation has happened since it was noted.
file_id() {
  { ls -di "$1" 2> /dev/null || true; } | awk '{print $1}'
}

# Restarts the server's job with load_job. Notes the log size and $log.1's inode first
# (log_before, rotated_before) so wait_healthy reads only what the restarted job writes. Leaves the
# timer jobs alone.
restart_job() {
  log_before=$(($(wc -c 2> /dev/null < "$log" || echo 0)))
  rotated_before=$(file_id "$log.1")
  mkdir -p "$logs" "$HOME/.config/t3fac"
  load_job "$label"
}

# Copies file $1, relative to this script directory, to the same path under $root, which outlives
# any checkout or release archive the plists could otherwise point at. The file is replaced by
# rename, never overwritten in place, because bash reads a script incrementally and a copy running
# now would see a mix of old and new text. Returns non-zero on any failure, even where set -e is
# off, and leaves no temporary file behind.
install_script() {
  local file=$1 dir tmp_file
  dir=$(dirname "$root/$file")
  mkdir -p "$dir" || return 1
  tmp_file=$(mktemp "$dir/.$(basename "${file%.sh}").XXXXXX") || return 1
  if ! {
    cp "$(dirname "${BASH_SOURCE[0]}")/../$file" "$tmp_file" &&
      chmod 755 "$tmp_file" &&
      mv -f "$tmp_file" "$root/$file"
  }; then
    rm -f "$tmp_file"
    return 1
  fi
}

# Installs script $1 with install_script and loads job $2 with load_job. Call it before restart_job
# so the server's restart stays the last job action before wait_healthy. A timer job is best effort: callers run it
# through restart_timer_jobs_or_warn, so a failure must never stop the server restart. set -e is
# off for the whole body in that context, hence the && chain: any failing step makes the function
# return non-zero.
# T3FAC_SKIP_RELOAD=<label> copies the script but leaves that job loaded as it is: autodeploy.sh
# sets it for its own job, since booting it out would kill the deploy that called install.sh. The
# new script takes effect on the job's next tick; a changed template waits for the next install run
# by hand.
restart_timer_job() {
  local script=$1 job=$2
  mkdir -p "$logs" || return 1
  install_script "$script" || return 1
  [[ ${T3FAC_SKIP_RELOAD:-} != "$job" ]] || return 0
  load_job "$job"
}

# The best-effort wrapper install.sh and rollback.sh call: the log rotator, then autodeploy, which
# sources lib/lock.sh and lib/platform.sh from beside it.
restart_timer_jobs_or_warn() {
  restart_timer_job rotate-log.sh "$logrotate_label" ||
    echo "warning: could not reload $logrotate_label; log rotation is not running" >&2
  { install_script lib/lock.sh && install_script lib/platform.sh &&
    restart_timer_job autodeploy.sh "$autodeploy_label"; } ||
    echo "warning: could not reload $autodeploy_label; autodeploy is not running" >&2
}

# Whether stdin holds the line the server writes once it is up. No -q: grep must read all of
# its input, or pipefail sees the writer die of SIGPIPE.
has_start_line() {
  grep -e 'factory started' -e 'no factory config' > /dev/null
}

# Waits up to T3FAC_HEALTH_WAIT seconds (90) after restart_job for the server to accept
# connections on $port and for a "factory started" or "no factory config" line to appear in
# the bytes appended to the log since the restart. A log smaller than it was before the
# restart was truncated, and the log is then read from the start. When rotate-log.sh did that,
# $log.1 is a new file holding the log as it was, so the bytes since the restart are looked for
# there once; a $log.1 left from before the restart is never read. On timeout prints what is
# missing and the last 50 log lines to stderr and returns 1.
wait_healthy() {
  local version=$1 wait=${T3FAC_HEALTH_WAIT:-90} offset=${log_before:-0}
  local i size port_ok log_ok rotated_ok=0 missing
  for ((i = 0; i <= wait * 2; i++)); do
    port_ok=0
    log_ok=0
    if (exec 3<> "/dev/tcp/127.0.0.1/$port") 2> /dev/null; then port_ok=1; fi
    size=$(($(wc -c 2> /dev/null < "$log" || echo 0)))
    if ((size < offset)); then
      if [[ $(file_id "$log.1") != "${rotated_before:-}" ]] &&
        tail -c +$((offset + 1)) "$log.1" 2> /dev/null | has_start_line; then
        rotated_ok=1
      fi
      offset=0
    fi
    if ((rotated_ok)) || tail -c +$((offset + 1)) "$log" 2> /dev/null | has_start_line; then
      log_ok=1
    fi
    if ((port_ok && log_ok)); then return 0; fi
    if ((i < wait * 2)); then sleep 0.5; fi
  done
  missing=""
  if ((!port_ok)); then missing="port $port does not accept connections"; fi
  if ((!log_ok)); then
    missing="${missing:+$missing, }no 'factory started' or 'no factory config' line in the log since the restart"
  fi
  echo "version $version failed its health check within ${wait}s: $missing" >&2
  echo "last 50 lines of $log:" >&2
  tail -n 50 "$log" >&2 2> /dev/null || true
  return 1
}
