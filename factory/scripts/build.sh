#!/usr/bin/env bash
# Builds the fork with upstream's own build scripts, smoke-tests the archive and only then
# moves it to release/t3fac-<version>-<os>-<arch>.tar.gz, the host's (lib/platform.sh). Refuses
# a tree with uncommitted changes, so the version always names exactly what was built.
# `build.sh --print-version` only prints the version and `build.sh --print-node-version` only the
# Node version the SEA build uses. T3FAC_SMOKE_TIMEOUT sets the smoke test's deadline in seconds
# (60).
set -euo pipefail

root=${T3FAC_REPO_ROOT:-$(git rev-parse --show-toplevel)}
source "$(dirname "${BASH_SOURCE[0]}")/lib/platform.sh"
cd "$root"

read -r tag _sha < factory/UPSTREAM
if [[ $tag =~ ^v[^\ ]*-nightly\. ]]; then
  upstream=${tag#v}
else
  upstream=$(node -p 'require("./apps/server/package.json").version')
fi
version="${upstream}+fac.$(git rev-parse --short HEAD)"

if [[ ${1:-} == --print-version ]]; then
  echo "$version"
  exit 0
fi

# The SEA build needs the Node version upstream pins: root package.json engines.node, which
# the server's vite config reads, or the SEA_NODE_VERSION constant older upstreams kept there.
sea_node=$(node -p 'String((require("./package.json").engines || {}).node || "")' || true)
if [[ -z $sea_node ]]; then
  sea_node=$(sed -n 's/^const SEA_NODE_VERSION = "\([^"]*\)";.*/\1/p' apps/server/vite.config.ts 2>/dev/null || true)
fi
if [[ -z $sea_node ]]; then
  echo "could not read the SEA Node version: no engines.node in package.json and no SEA_NODE_VERSION in apps/server/vite.config.ts" >&2
  exit 1
fi

if [[ ${1:-} == --print-node-version ]]; then
  echo "$sea_node"
  exit 0
fi

# Changed tracked files and untracked files that are not ignored both end up in the build.
dirty=$(git status --porcelain)
if [[ -n $dirty ]]; then
  echo "build: refusing to build $version with uncommitted changes; commit or remove them:" >&2
  head -n 10 <<< "$dirty" >&2
  count=$(wc -l <<< "$dirty")
  (( count <= 10 )) || echo "... and $((count - 10)) more" >&2
  exit 1
fi

stage=""
smoke=""
server_pid=""

# The smoke server leads its own process group, so stopping it also stops what it spawned
# (vp's node shim can still be downloading a runtime into the smoke HOME).
cleanup() {
  if [[ -n $server_pid ]] && kill -0 -- "-$server_pid" 2>/dev/null; then
    kill -- "-$server_pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 -- "-$server_pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 -- "-$server_pid" 2>/dev/null || true
  fi
  [[ -z $smoke ]] || rm -rf "$smoke"
  [[ -z $stage ]] || rm -rf "$stage"
}
trap cleanup EXIT

echo "build: version $version (SEA node $sea_node)"

vp i
vp run --filter t3 build
# Cargo reads .cargo/config.toml from every parent of the cwd and from CARGO_HOME, so a
# build under $HOME would inherit a host-level crates.io replacement. The lockfile pins
# crates.io, so build from / with a CARGO_HOME of its own under the gitignored target/.
cargo_home="$root/native/resource-monitor/target/cargo-home"
mkdir -p "$cargo_home"
(cd / && CARGO_HOME="$cargo_home" cargo build --locked --release --manifest-path "$root/native/resource-monitor/Cargo.toml")
VP_NODE_VERSION="$sea_node" vp node apps/server/scripts/cli.ts build-exe

stage=$(mktemp -d)
mkdir -p "$stage/monitor/$archive_suffix" "$stage/out"
cp native/resource-monitor/target/release/t3-resource-monitor "$stage/monitor/$archive_suffix/t3-resource-monitor"
VP_NODE_VERSION="$sea_node" vp node scripts/build-cli-archive.ts \
  --platform "$archive_platform" --arch "$archive_arch" --version "$version" \
  --resource-monitor-dir "$stage/monitor" --output-dir "$stage/out"

built="$stage/out/t3-${version}-${archive_suffix}.tar.gz"

# Smoke test: start the built server on a free port with a throwaway HOME and base dir.
smoke_timeout=${T3FAC_SMOKE_TIMEOUT:-60}
smoke=$(mktemp -d)
mkdir -p "$smoke/pkg" "$smoke/home"
tar -xzf "$built" -C "$smoke/pkg"
pkg=$(find "$smoke/pkg" -mindepth 1 -maxdepth 1 -type d | head -n 1)
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')

fail() {
  echo "smoke: FAILED: $1" >&2
  tail -n 40 "$smoke/server.log" >&2 || true
  exit 1
}

echo "smoke: serve on 127.0.0.1:$port"
# Job control puts the background server in a process group of its own, led by its pid.
set -m
HOME="$smoke/home" "$pkg/t3" serve --base-dir "$smoke/base" --host 127.0.0.1 --port "$port" \
  > "$smoke/server.log" 2>&1 &
server_pid=$!
set +m

ok=""
start=$SECONDS
while :; do
  kill -0 "$server_pid" 2>/dev/null || fail "server exited early"
  code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/.well-known/t3/environment" || true)
  if [[ $code == 200 ]]; then
    ok=1
    break
  fi
  (( SECONDS - start >= smoke_timeout )) && break
  sleep 0.5
done
[[ -n $ok ]] || fail "/.well-known/t3/environment did not answer 200 within ${smoke_timeout}s"
echo "smoke: /.well-known/t3/environment -> 200 after $((SECONDS - start))s"

grep -q 'no factory config' "$smoke/server.log" || fail 'server log does not hold "no factory config"'
echo 'smoke: log holds "no factory config"'

mkdir -p release
archive="release/t3fac-${version}-${archive_suffix}.tar.gz"
mv "$built" "$archive"

cleanup
smoke=""
server_pid=""
echo "smoke: server stopped, temp dir removed"

echo "$root/$archive"
