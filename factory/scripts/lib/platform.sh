# Sourced by build.sh, deploy.sh, lib/t3fac.sh and autodeploy.sh: which host this is and what that
# decides, the archive a build makes, the names of the jobs and where they log. macOS runs the jobs
# under launchd, Linux under the systemd user manager. T3FAC_PLATFORM (Darwin or Linux) exists only
# so tests can pick one; otherwise it is `uname -s`.

host_os=${T3FAC_PLATFORM:-$(uname -s)}
case $host_os in
  Darwin)
    archive_platform=mac
    archive_arch=arm64
    archive_suffix=darwin-arm64
    logs="$HOME/Library/Logs/t3fac"
    # LaunchAgent labels; deployKick.ts names the autodeploy one too.
    server_job=io.github.rawphp.t3fac
    logrotate_job=io.github.rawphp.t3fac.logrotate
    autodeploy_job=io.github.rawphp.t3fac.autodeploy
    ;;
  Linux)
    archive_platform=linux
    case $(uname -m) in
      aarch64 | arm64) archive_arch=arm64 ;;
      *) archive_arch=x64 ;;
    esac
    archive_suffix=linux-$archive_arch
    # The unit templates in factory/systemd name the same directory.
    logs="$HOME/.local/state/t3fac"
    # systemd user units, without the .service or .timer; deployKick.ts names the autodeploy one
    # too. Not t3code.service, which is upstream's own server unit.
    server_job=t3fac
    logrotate_job=t3fac-logrotate
    autodeploy_job=t3fac-autodeploy
    ;;
  *)
    echo "unsupported host: $host_os (want Darwin or Linux)" >&2
    return 1
    ;;
esac
