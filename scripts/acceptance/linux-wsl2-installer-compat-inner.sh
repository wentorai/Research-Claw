#!/usr/bin/env bash
set -euo pipefail

: "${RC_EXPECTED_DOCKER_INSTALLER_SHA:?}"
: "${RC_EXPECTED_NATIVE_INSTALLER_SHA:?}"
: "${RC_EXPECTED_NATIVE_TEST_SHA:?}"

readonly INSTALL_DOCKER=/candidate/install-docker.sh
readonly INSTALL_NATIVE=/app/scripts/install.sh
readonly NATIVE_TEST=/app/test/bootstrap-profile-installer-native-runtime.test.ts
readonly FIXTURES=/acceptance/wsl2-fixtures
readonly SOURCE_FAKE_BIN=/acceptance/wsl2-fake-bin
readonly FAKE_BIN=/work/fake-bin

fail() {
  printf 'WSL2 compatibility acceptance: %s\n' "$1" >&2
  exit 80
}

sha256sum "$INSTALL_DOCKER" | grep -q "^${RC_EXPECTED_DOCKER_INSTALLER_SHA}  " \
  || fail 'Docker installer SHA mismatch'
sha256sum "$INSTALL_NATIVE" | grep -q "^${RC_EXPECTED_NATIVE_INSTALLER_SHA}  " \
  || fail 'Native installer SHA mismatch'
sha256sum "$NATIVE_TEST" | grep -q "^${RC_EXPECTED_NATIVE_TEST_SHA}  " \
  || fail 'Native test SHA mismatch'

rm -rf -- "$FAKE_BIN"
mkdir -m 700 "$FAKE_BIN"
for command in docker curl grep sleep; do
  cp "$SOURCE_FAKE_BIN/$command" "$FAKE_BIN/$command"
  chmod 700 "$FAKE_BIN/$command"
done

reset_windows_users() {
  rm -rf -- /mnt/c/Users/fixture-user
  mkdir -m 700 /mnt/c/Users/fixture-user
}

mkdir -m 700 /work/grep-selftest
RC_ACCEPTANCE_LOG_DIR=/work/grep-selftest \
RC_PROC_VERSION_FIXTURE="$FIXTURES/proc-version-wsl2.txt" \
  "$FAKE_BIN/grep" -qi microsoft /proc/version \
  || fail 'grep shim did not redirect the exact proc-version operand'
RC_ACCEPTANCE_LOG_DIR=/work/grep-selftest \
RC_PROC_VERSION_FIXTURE="$FIXTURES/proc-version-wsl2.txt" \
  "$FAKE_BIN/grep" -q linuxkit "$FIXTURES/proc-version-linux.txt" \
  || fail 'grep shim did not delegate an unrelated path'
reset_windows_users
printf '[wsl2]\nnetworkingMode=mirrored\n' \
  >/mnt/c/Users/fixture-user/.wslconfig
RC_ACCEPTANCE_LOG_DIR=/work/grep-selftest \
RC_PROC_VERSION_FIXTURE="$FIXTURES/proc-version-wsl2.txt" \
  "$FAKE_BIN/grep" -qi 'networkingMode.*=.*mirrored' \
  /mnt/c/Users/fixture-user/.wslconfig \
  || fail 'grep shim did not record a matching exact wslconfig read'
printf '[wsl2]\nnetworkingMode=nat\n' \
  >/mnt/c/Users/fixture-user/.wslconfig
set +e
RC_ACCEPTANCE_LOG_DIR=/work/grep-selftest \
RC_PROC_VERSION_FIXTURE="$FIXTURES/proc-version-wsl2.txt" \
  "$FAKE_BIN/grep" -qi 'networkingMode.*=.*mirrored' \
  /mnt/c/Users/fixture-user/.wslconfig
wslconfig_nomatch_rc=$?
set -e
[[ "$wslconfig_nomatch_rc" -eq 1 ]] \
  || fail 'grep shim changed the real grep no-match result'
/usr/bin/grep -Fxq 'redirect:/proc/version:fixture=wsl2' /work/grep-selftest/grep.calls \
  || fail 'grep shim redirect self-test was not recorded'
/usr/bin/grep -Fxq 'delegate:other' /work/grep-selftest/grep.calls \
  || fail 'grep shim delegation self-test was not recorded'
/usr/bin/grep -Fxq \
  'delegate:wslconfig:path=fixture-user/.wslconfig:matched=true' \
  /work/grep-selftest/grep.calls \
  || fail 'grep shim matching wslconfig self-test was not recorded'
/usr/bin/grep -Fxq \
  'delegate:wslconfig:path=fixture-user/.wslconfig:matched=false' \
  /work/grep-selftest/grep.calls \
  || fail 'grep shim non-matching wslconfig self-test was not recorded'
echo 'grep_shim_selftest=redirect_exact_delegate_other_wslconfig_match_and_nomatch_PASS'

assert_no_secret() {
  local directory="$1"
  if /usr/bin/grep -R -a -E -q \
      -e 'rca_[A-Za-z0-9_-]{43,}' \
      -e 'Authorization:[[:space:]]*Bearer' \
      -e 'sk-(proj-)?[A-Za-z0-9_-]{20,}' \
      "$directory"; then
    fail "secret-like value found in ${directory}"
  fi
}

run_installer_scenario() {
  local name="$1" proc_fixture="$2" config_mode="$3" expect_wsl="$4"
  local proc_kind="$5" expected_config_read="$6"
  local root output rc
  root="/work/$name"
  output="$root/installer.out"

  rm -rf -- "$root"
  mkdir -m 700 "$root" "$root/home" "$root/tmp" "$root/logs"
  reset_windows_users
  if [[ "$config_mode" == mirrored ]]; then
    cat >/mnt/c/Users/fixture-user/.wslconfig <<'EOF'
[wsl2]
networkingMode=mirrored
EOF
    chmod 600 /mnt/c/Users/fixture-user/.wslconfig
  elif [[ "$config_mode" == nat ]]; then
    cat >/mnt/c/Users/fixture-user/.wslconfig <<'EOF'
[wsl2]
networkingMode=nat
EOF
    chmod 600 /mnt/c/Users/fixture-user/.wslconfig
  fi

  set +e
  env -i \
    PATH="$FAKE_BIN:/usr/bin:/bin" \
    HOME="$root/home" \
    TMPDIR="$root/tmp" \
    HTTPS_PROXY='http://127.0.0.1:7890' \
    RC_ACCEPTANCE_LOG_DIR="$root/logs" \
    RC_PROC_VERSION_FIXTURE="$proc_fixture" \
    /bin/bash "$INSTALL_DOCKER" >"$output" 2>&1
  rc=$?
  set -e

  [[ "$rc" -ne 0 ]] || fail "$name unexpectedly completed despite forced pull failure"
  /usr/bin/grep -q '^pull ' "$root/logs/docker.calls" \
    || fail "$name did not reach docker pull"
  [[ "$(/usr/bin/grep -c '^pull ' "$root/logs/docker.calls")" -eq 2 ]] \
    || fail "$name did not exercise exactly one primary and one fallback pull failure"
  [[ ! -e "$root/logs/unexpected-docker-call" ]] \
    || fail "$name invoked Docker beyond the approved failure fixture"
  ! /usr/bin/grep -Fq 'bootstrap/redeem' "$root/logs/curl.calls" \
    || fail "$name made a no-Token redemption request"
  [[ -z "$(find "$root/tmp" -maxdepth 1 -name 'rc-bootstrap-installer.*' -print -quit)" ]] \
    || fail "$name left a Bootstrap secret directory"
  assert_no_secret "$root"

  /usr/bin/grep -Fxq "redirect:/proc/version:fixture=$proc_kind" \
    "$root/logs/grep.calls" \
    || fail "$name did not use the expected proc-version fixture"
  case "$expected_config_read" in
    matched)
      /usr/bin/grep -Fxq \
        'delegate:wslconfig:path=fixture-user/.wslconfig:matched=true' \
        "$root/logs/grep.calls" \
        || fail "$name did not read and match the exact wslconfig"
      ;;
    unmatched)
      /usr/bin/grep -Fxq \
        'delegate:wslconfig:path=fixture-user/.wslconfig:matched=false' \
        "$root/logs/grep.calls" \
        || fail "$name did not read and reject the exact non-mirrored wslconfig"
      ;;
    absent)
      ! /usr/bin/grep -Fq 'delegate:wslconfig:' "$root/logs/grep.calls" \
        || fail "$name unexpectedly read a wslconfig"
      ;;
    *) fail "$name has an invalid config-read expectation" ;;
  esac

  if [[ "$expect_wsl" == true ]]; then
    /usr/bin/grep -Fq 'Detected localhost proxy + WSL2 NAT mode' "$output" \
      || fail "$name missed the WSL2 NAT preflight warning"
    /usr/bin/grep -Fq 'DIAGNOSIS: WSL2 localhost proxy issue detected' "$output" \
      || fail "$name missed the WSL2 pull-failure diagnosis"
  else
    ! /usr/bin/grep -Fq 'Detected localhost proxy + WSL2 NAT mode' "$output" \
      || fail "$name emitted an unexpected WSL2 NAT warning"
    ! /usr/bin/grep -Fq 'DIAGNOSIS: WSL2 localhost proxy issue detected' "$output" \
      || fail "$name emitted an unexpected WSL2 pull-failure diagnosis"
  fi

  echo "scenario=$name exit=$rc pulls=$(/usr/bin/grep -c '^pull ' "$root/logs/docker.calls") proc_fixture=$proc_kind wslconfig_read=$expected_config_read wsl_warning_and_diagnosis=$expect_wsl secret_hits=0 result=PASS"
  echo "scenario_output_begin=$name"
  cat "$output"
  echo "scenario_output_end=$name"
}

echo 'container_os_arch_begin'
uname -a
node -p 'process.platform + "/" + process.arch'
echo 'container_os_arch_end'

run_installer_scenario \
  wsl2-nat-localhost "$FIXTURES/proc-version-wsl2.txt" absent true wsl2 absent
run_installer_scenario \
  wsl2-mirrored-localhost "$FIXTURES/proc-version-wsl2.txt" mirrored false wsl2 matched
run_installer_scenario \
  wsl2-config-without-mirrored-localhost \
  "$FIXTURES/proc-version-wsl2.txt" nat true wsl2 unmatched
run_installer_scenario \
  linux-localhost "$FIXTURES/proc-version-linux.txt" mirrored false linux absent

readonly NATIVE_LOG=/work/native-linux-as-wsl.out
set +e
(
  cd /app
  export NODE_ENV=test
  export WSL_DISTRO_NAME=Ubuntu-22.04
  export WSL_INTEROP=/run/WSL/acceptance_interop
  echo "native_wsl_markers=WSL_DISTRO_NAME:${WSL_DISTRO_NAME},WSL_INTEROP:set"
  echo 'native_wsl_kernel_emulated=false'
  /app/node_modules/.bin/vitest run \
      test/bootstrap-profile-installer-native-runtime.test.ts \
      --pool=forks \
      --maxWorkers=1 \
      --minWorkers=1 \
      --no-file-parallelism \
      --maxConcurrency=1
) >"$NATIVE_LOG" 2>&1
native_rc=$?
set -e
cat "$NATIVE_LOG"
[[ "$native_rc" -eq 0 ]] || fail "Native Linux-as-WSL runtime sample exited $native_rc"
/usr/bin/grep -Eq 'Test Files[[:space:]]+1 passed \(1\)' "$NATIVE_LOG" \
  || fail 'Native Linux-as-WSL file-count gate failed'
/usr/bin/grep -Eq 'Tests[[:space:]]+4 passed \(4\)' "$NATIVE_LOG" \
  || fail 'Native Linux-as-WSL test-count gate failed'
assert_no_secret /work
echo 'native_linux_abi_with_wsl_markers=4/4 exit=0 single_worker=true result=PASS'

sha256sum "$INSTALL_DOCKER" | grep -q "^${RC_EXPECTED_DOCKER_INSTALLER_SHA}  " \
  || fail 'Docker installer changed during acceptance'
sha256sum "$INSTALL_NATIVE" | grep -q "^${RC_EXPECTED_NATIVE_INSTALLER_SHA}  " \
  || fail 'Native installer changed during acceptance'
sha256sum "$NATIVE_TEST" | grep -q "^${RC_EXPECTED_NATIVE_TEST_SHA}  " \
  || fail 'Native test changed during acceptance'
echo 'mounted_source_unchanged=true'
echo 'inner_result=PASS'
