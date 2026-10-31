#!/usr/bin/env bash
# Installs a t3fac archive under ~/.local/share/t3fac/versions, points `current` at it,
# writes the server's job (a LaunchAgent on macOS, a systemd user unit on Linux) and restarts it,
# then waits for it to come up and runs rollback.sh when it does not. It also installs rotate-log.sh
# and autodeploy.sh with their timer jobs, which keep the log from growing without bound and follow
# origin/main.
# Usage: install.sh <archive>
set -euo pipefail

source "$(dirname "$0")/lib/t3fac.sh"

archive=${1:-}
if [[ -z $archive || ! -f $archive ]]; then
  echo "usage: install.sh <t3fac-<version>-$archive_suffix.tar.gz>" >&2
  exit 1
fi

name=$(basename "$archive")
if [[ $name != t3fac-*-"$archive_suffix".tar.gz ]]; then
  echo "unexpected archive name: $name (want t3fac-<version>-$archive_suffix.tar.gz)" >&2
  exit 1
fi
version=${name#t3fac-}
version=${version%-"$archive_suffix".tar.gz}
if [[ -z $version || $version == */* || $version == . || $version == .. ]]; then
  echo "invalid version in archive name: $name" >&2
  exit 1
fi

dest="$root/versions/$version"

take_deploy_lock || exit 1
trap release_deploy_lock EXIT

mkdir -p "$root/versions"
# Unpack beside the destination and swap in only a good archive, so a bad one never
# damages the version that `current` may already point at.
tmp=$(mktemp -d "$root/versions/.t3fac-install.XXXXXX")
trap 'rm -rf "$tmp"; release_deploy_lock' EXIT
chmod 755 "$tmp"
tar -xzf "$archive" -C "$tmp" --strip-components=1
if [[ ! -e $tmp/t3 ]]; then
  echo "archive has no t3 binary: $name" >&2
  exit 1
fi
rm -rf "$dest"
mv "$tmp" "$dest"

# Keep the version that was current as `previous`, unless it is the one being reinstalled.
if [[ -L $root/current ]]; then
  old=$(readlink "$root/current")
  if [[ $old != "versions/$version" ]]; then
    ln -sfn "$old" "$root/previous"
  fi
fi
hold_autodeploy
ln -sfn "versions/$version" "$root/current"

restart_timer_jobs_or_warn
restart_job

if ! wait_healthy "$version"; then
  if [[ -L $root/previous && -e $root/previous ]]; then
    prev=$(readlink "$root/previous")
    prev=${prev#versions/}
    if bash "$(dirname "$0")/rollback.sh"; then
      echo "install of $version failed its health check; rolled back to $prev" >&2
    else
      echo "install of $version failed its health check; rollback to $prev failed too" >&2
    fi
  else
    echo "install of $version failed its health check; no earlier version to roll back to" >&2
  fi
  exit 1
fi

echo "installed $version"
echo "current -> versions/$version"
echo "job $label restarted"
