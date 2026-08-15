#!/usr/bin/env bash
# Run the public POSIX Docker installer through deterministic WSL2 compatibility
# fixtures, then run the current Native Linux ABI sample with WSL environment
# markers. The latter is not evidence from a real WSL kernel.
# The candidate image is addressed by exact image ID; the human-readable ref is
# accepted only to prove that it still resolves to that ID.

set -euo pipefail

usage() {
  echo "Usage: $0 <image-ref> <image-id> <linux/arm64|linux/amd64> <evidence-prefix> <owner>" >&2
  exit 64
}

[[ "$#" -eq 5 ]] || usage

IMAGE_REF="$1"
IMAGE_ID="$2"
PLATFORM="$3"
EVIDENCE_PREFIX_INPUT="$4"
OWNER="$5"

[[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || usage
[[ "$PLATFORM" =~ ^linux/(arm64|amd64)$ ]] || usage
[[ "$OWNER" =~ ^rc-[a-z0-9][a-z0-9-]{5,80}-wsl2-compat-gate$ ]] || usage

physical_dir() {
  (cd -P -- "$1" 2>/dev/null && pwd -P)
}

stat_identity() {
  local path="$1" value
  if value="$(stat -f '%d:%i' "$path" 2>/dev/null)" \
      && [[ "$value" =~ ^[0-9]+:[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  if value="$(stat -c '%d:%i' "$path" 2>/dev/null)" \
      && [[ "$value" =~ ^[0-9]+:[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  return 1
}

stat_mode() {
  local path="$1" value
  if value="$(stat -f '%Lp' "$path" 2>/dev/null)" \
      && [[ "$value" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  if value="$(stat -c '%a' "$path" 2>/dev/null)" \
      && [[ "$value" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  return 1
}

stat_owner() {
  local path="$1" value
  if value="$(stat -f '%u' "$path" 2>/dev/null)" \
      && [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  if value="$(stat -c '%u' "$path" 2>/dev/null)" \
      && [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  return 1
}

sha256_digest() {
  local path="$1" value
  if command -v shasum >/dev/null 2>&1; then
    value="$(shasum -a 256 "$path" | awk '{print $1}')" || return
  elif command -v sha256sum >/dev/null 2>&1; then
    value="$(sha256sum "$path" | awk '{print $1}')" || return
  else
    return 1
  fi
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$value"
}

TEMP_PARENT="$(physical_dir "${TMPDIR:-/tmp}")" || usage
TEMP_PARENT_ID="$(stat_identity "$TEMP_PARENT")" || usage
TEMP_PARENT_MODE="$(stat_mode "$TEMP_PARENT")" || usage
TEMP_PARENT_OWNER="$(stat_owner "$TEMP_PARENT")" || usage
CURRENT_UID="$(id -u)"
[[ "$TEMP_PARENT_MODE" == 700 && "$TEMP_PARENT_OWNER" == "$CURRENT_UID" ]] || {
  echo "TMPDIR must resolve to a current-user-owned mode-0700 directory: $TEMP_PARENT" >&2
  exit 65
}
EVIDENCE_PARENT="$(physical_dir "$(dirname -- "$EVIDENCE_PREFIX_INPUT")")" || usage
EVIDENCE_BASENAME="$(basename -- "$EVIDENCE_PREFIX_INPUT")"
[[ "$EVIDENCE_PARENT" == "$TEMP_PARENT" ]] || usage
[[ "$EVIDENCE_BASENAME" =~ ^rc-[a-zA-Z0-9._-]+$ ]] || usage
EVIDENCE_PREFIX="$EVIDENCE_PARENT/$EVIDENCE_BASENAME"
umask 077

SOURCE_ROOT="$(cd -P -- "$(dirname -- "$0")/../.." && pwd -P)"
ACCEPTANCE_ROOT="$SOURCE_ROOT/scripts/acceptance"
DOCKER_INSTALLER="$SOURCE_ROOT/scripts/install-docker.sh"
NATIVE_INSTALLER="$SOURCE_ROOT/scripts/install.sh"
NATIVE_TEST="$SOURCE_ROOT/test/bootstrap-profile-installer-native-runtime.test.ts"
INNER="$ACCEPTANCE_ROOT/linux-wsl2-installer-compat-inner.sh"
LOG="$EVIDENCE_PREFIX.log"
INSPECT="$EVIDENCE_PREFIX.inspect.json"
CID_FILE="$EVIDENCE_PREFIX.cid"
TASK_ROOT=''
TASK_ROOT_ID=''
CONTAINER_ID=''
SOURCE_MANIFEST_START=''
CREATE_ATTEMPTED=false
OWNER_WAS_FREE=false
RUN_ID=''

for path in "$LOG" "$INSPECT" "$CID_FILE"; do
  if [[ -e "$path" || -L "$path" ]]; then
    echo "Refusing to overwrite evidence path: $path" >&2
    exit 65
  fi
done

for path in "$DOCKER_INSTALLER" "$NATIVE_INSTALLER" "$NATIVE_TEST" "$INNER"; do
  [[ -f "$path" && ! -L "$path" ]] || {
    echo "Missing or unsafe acceptance input: $path" >&2
    exit 66
  }
done

source_manifest() {
  local path digest
  for path in \
    "$DOCKER_INSTALLER" \
    "$NATIVE_INSTALLER" \
    "$NATIVE_TEST" \
    "$ACCEPTANCE_ROOT/linux-wsl2-installer-compat.sh" \
    "$INNER" \
    "$ACCEPTANCE_ROOT/wsl2-fake-bin/docker" \
    "$ACCEPTANCE_ROOT/wsl2-fake-bin/curl" \
    "$ACCEPTANCE_ROOT/wsl2-fake-bin/grep" \
    "$ACCEPTANCE_ROOT/wsl2-fake-bin/sleep" \
    "$ACCEPTANCE_ROOT/wsl2-fixtures/proc-version-linux.txt" \
    "$ACCEPTANCE_ROOT/wsl2-fixtures/proc-version-wsl2.txt"
  do
    digest="$(sha256_digest "$path")" || return
    printf '%s  %s\n' "$digest" "$path"
  done
}

SOURCE_MANIFEST_START="$(source_manifest)"

cleanup_owned() {
  local cleanup_rc=0 target_id actual_id actual_name actual_owner actual_run sentinel
  local parent_now

  target_id="$CONTAINER_ID"
  if [[ -z "$target_id" && "$CREATE_ATTEMPTED" == true && "$OWNER_WAS_FREE" == true ]] \
      && docker container inspect "$OWNER" >/dev/null 2>&1; then
    target_id="$(docker container inspect --format '{{.Id}}' "$OWNER" 2>/dev/null || true)"
    echo 'cleanup_resolved_container_after_unassigned_create=true'
  fi

  if [[ -n "$target_id" ]] && docker container inspect "$target_id" >/dev/null 2>&1; then
    actual_id="$(docker container inspect --format '{{.Id}}' "$target_id" 2>/dev/null || true)"
    actual_name="$(docker container inspect --format '{{.Name}}' "$target_id" 2>/dev/null || true)"
    actual_owner="$(docker container inspect --format '{{index .Config.Labels "rc.audit.owner"}}' "$target_id" 2>/dev/null || true)"
    actual_run="$(docker container inspect --format '{{index .Config.Labels "rc.audit.run"}}' "$target_id" 2>/dev/null || true)"
    if [[ "$actual_id" != "$target_id" || "$actual_name" != "/$OWNER" \
        || "$actual_owner" != "$OWNER" || "$actual_run" != "$RUN_ID" ]]; then
      echo 'cleanup_container_identity_valid=false'
      cleanup_rc=1
    else
      echo 'cleanup_container_identity_valid=true'
      docker container rm -f "$target_id" >/dev/null 2>&1 || cleanup_rc=1
    fi
  fi

  if [[ "$CREATE_ATTEMPTED" == true ]] && docker container inspect "$OWNER" >/dev/null 2>&1; then
    echo 'cleanup_container_absent=false'
    cleanup_rc=1
  elif [[ "$CREATE_ATTEMPTED" == true ]]; then
    echo 'cleanup_container_absent=true'
  else
    echo 'cleanup_container_absent=not-created'
  fi

  parent_now="$(physical_dir "$TEMP_PARENT" 2>/dev/null || true)"
  if [[ "$parent_now" != "$TEMP_PARENT" \
      || "$(stat_identity "$TEMP_PARENT" 2>/dev/null || true)" != "$TEMP_PARENT_ID" \
      || "$(stat_mode "$TEMP_PARENT" 2>/dev/null || true)" != "$TEMP_PARENT_MODE" \
      || "$(stat_owner "$TEMP_PARENT" 2>/dev/null || true)" != "$TEMP_PARENT_OWNER" ]]; then
    echo 'cleanup_temp_parent_identity_valid=false'
    cleanup_rc=1
  else
    echo 'cleanup_temp_parent_identity_valid=true'
  fi

  if [[ -n "$TASK_ROOT" && "$(physical_dir "$(dirname -- "$TASK_ROOT")" 2>/dev/null || true)" == "$TEMP_PARENT" \
      && "$(basename -- "$TASK_ROOT")" == rc-wsl2-compat.* \
      && -d "$TASK_ROOT" && ! -L "$TASK_ROOT" ]]; then
    sentinel="$TASK_ROOT/.rc-acceptance-owner"
    if [[ "$(stat_identity "$TASK_ROOT" 2>/dev/null || true)" != "$TASK_ROOT_ID" \
        || "$(stat_mode "$TASK_ROOT" 2>/dev/null || true)" != 700 \
        || "$(stat_owner "$TASK_ROOT" 2>/dev/null || true)" != "$CURRENT_UID" \
        || "$(cat "$sentinel" 2>/dev/null || true)" != "$OWNER:$RUN_ID" ]]; then
      echo 'cleanup_task_root_identity_valid=false'
      cleanup_rc=1
    else
      echo 'cleanup_task_root_identity_valid=true'
      rm -rf -- "$TASK_ROOT" || cleanup_rc=1
    fi
  fi
  if [[ -n "$TASK_ROOT" && ( -e "$TASK_ROOT" || -L "$TASK_ROOT" ) ]]; then
    echo 'cleanup_task_root_absent=false'
    cleanup_rc=1
  else
    echo 'cleanup_task_root_absent=true'
  fi
  return "$cleanup_rc"
}

on_exit() {
  local original_rc=$? cleanup_rc=0 post_manifest
  trap - EXIT INT TERM
  set +e
  post_manifest="$(source_manifest)"
  if [[ "$post_manifest" != "$SOURCE_MANIFEST_START" ]]; then
    echo 'source_unchanged=false'
    original_rc=67
  else
    echo 'source_unchanged=true'
  fi
  cleanup_owned
  cleanup_rc=$?
  if [[ "$original_rc" -eq 0 && "$cleanup_rc" -ne 0 ]]; then
    original_rc="$cleanup_rc"
  fi
  echo "exit_code=$original_rc"
  if [[ "$original_rc" -eq 0 ]]; then
    echo 'result=PASS'
  else
    echo 'result=FAIL'
  fi
  exit "$original_rc"
}

exec >"$LOG" 2>&1
trap on_exit EXIT
trap 'exit 130' INT TERM

echo 'run=linux-wsl2-installer-compat'
echo "image_ref=$IMAGE_REF"
echo "image_id=$IMAGE_ID"
echo "platform=$PLATFORM"
echo "owner=$OWNER"
echo "temp_parent=$TEMP_PARENT"
echo "temp_parent_identity=$TEMP_PARENT_ID"
echo "temp_parent_mode=$TEMP_PARENT_MODE"
echo "temp_parent_owner=$TEMP_PARENT_OWNER"
echo 'source_manifest_begin'
printf '%s\n' "$SOURCE_MANIFEST_START"
echo 'source_manifest_end'

ref_identity="$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$IMAGE_REF")"
id_identity="$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$IMAGE_ID")"
[[ "$ref_identity" == "$IMAGE_ID $PLATFORM" ]] || {
  echo "image_ref_identity_mismatch=$ref_identity"
  exit 68
}
[[ "$id_identity" == "$IMAGE_ID $PLATFORM" ]] || {
  echo "image_id_identity_mismatch=$id_identity"
  exit 68
}
echo "image_identity=$id_identity"

if docker container inspect "$OWNER" >/dev/null 2>&1; then
  echo 'owner_preoccupied=true'
  exit 69
fi
OWNER_WAS_FREE=true

TASK_ROOT="$(mktemp -d "$TEMP_PARENT/rc-wsl2-compat.XXXXXX")"
chmod 700 "$TASK_ROOT"
[[ "$(physical_dir "$(dirname -- "$TASK_ROOT")")" == "$TEMP_PARENT" ]] || exit 70
[[ "$(stat_mode "$TASK_ROOT")" == 700 ]] || exit 70
[[ "$(stat_owner "$TASK_ROOT")" == "$CURRENT_UID" ]] || exit 70
TASK_ROOT_ID="$(stat_identity "$TASK_ROOT")"
RUN_ID="$(basename -- "$TASK_ROOT")-$$"
printf '%s:%s\n' "$OWNER" "$RUN_ID" >"$TASK_ROOT/.rc-acceptance-owner"
mkdir -m 700 "$TASK_ROOT/work" "$TASK_ROOT/wsl-users" "$TASK_ROOT/test"
cp "$NATIVE_TEST" "$TASK_ROOT/test/bootstrap-profile-installer-native-runtime.test.ts"
chmod 600 "$TASK_ROOT/test/bootstrap-profile-installer-native-runtime.test.ts"
[[ "$(sha256_digest "$TASK_ROOT/test/bootstrap-profile-installer-native-runtime.test.ts")" \
    == "$(sha256_digest "$NATIVE_TEST")" ]] || exit 70

CREATE_ATTEMPTED=true
docker create \
  --platform "$PLATFORM" \
  --name "$OWNER" \
  --label "rc.audit.owner=$OWNER" \
  --label "rc.audit.run=$RUN_ID" \
  --network none \
  --mount "type=bind,source=$ACCEPTANCE_ROOT,target=/acceptance,readonly" \
  --mount "type=bind,source=$DOCKER_INSTALLER,target=/candidate/install-docker.sh,readonly" \
  --mount "type=bind,source=$NATIVE_INSTALLER,target=/app/scripts/install.sh,readonly" \
  --mount "type=bind,source=$TASK_ROOT/test,target=/app/test,readonly" \
  --mount "type=bind,source=$TASK_ROOT/work,target=/work" \
  --mount "type=bind,source=$TASK_ROOT/wsl-users,target=/mnt/c/Users" \
  --env "RC_EXPECTED_DOCKER_INSTALLER_SHA=$(sha256_digest "$DOCKER_INSTALLER")" \
  --env "RC_EXPECTED_NATIVE_INSTALLER_SHA=$(sha256_digest "$NATIVE_INSTALLER")" \
  --env "RC_EXPECTED_NATIVE_TEST_SHA=$(sha256_digest "$NATIVE_TEST")" \
  --entrypoint /bin/bash \
  "$IMAGE_ID" \
  /acceptance/linux-wsl2-installer-compat-inner.sh \
  >"$TASK_ROOT/docker-create.out"
if [[ "${RC_ACCEPTANCE_STOP_AFTER_CREATE:-0}" == 1 ]]; then
  echo 'acceptance_stop_after_create=true'
  exit 72
fi
CONTAINER_ID="$(tr -d '[:space:]' <"$TASK_ROOT/docker-create.out")"
[[ "$CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] || exit 71
printf '%s\n' "$CONTAINER_ID" >"$CID_FILE"
docker container inspect "$CONTAINER_ID" >"$INSPECT"

node - "$INSPECT" "$CONTAINER_ID" "$IMAGE_ID" "$OWNER" "$RUN_ID" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [file, id, image, owner, runId] = process.argv.slice(2);
const [container] = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(container.Id, id);
assert.equal(container.Image, image);
assert.equal(container.Config.Labels['rc.audit.owner'], owner);
assert.equal(container.Config.Labels['rc.audit.run'], runId);
assert.equal(container.HostConfig.NetworkMode, 'none');
const mounts = Object.fromEntries(container.Mounts.map((mount) => [mount.Destination, mount]));
for (const target of ['/acceptance', '/candidate/install-docker.sh', '/app/scripts/install.sh', '/app/test']) {
  assert.equal(mounts[target]?.RW, false, `${target} must be read-only`);
}
for (const target of ['/work', '/mnt/c/Users']) {
  assert.equal(mounts[target]?.RW, true, `${target} must be acceptance-owned writable state`);
}
NODE
echo 'mount_contract=PASS'

set +e
docker start -a "$CONTAINER_ID"
container_rc=$?
set -e
echo "container_exit_code=$container_rc"
[[ "$container_rc" -eq 0 ]] || exit "$container_rc"
