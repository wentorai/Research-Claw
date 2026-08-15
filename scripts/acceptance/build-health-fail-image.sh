#!/usr/bin/env bash
# Build and attest a local-only Windows T10 health-failure image from one exact
# linux/amd64 candidate. This helper never pushes and never invents a registry
# digest; the resulting local image is intentionally retained only on success.

set -euo pipefail

usage() {
  echo "Usage: $0 <candidate-ref> <candidate-image-id> <target-ref> <evidence-log>" >&2
  exit 64
}

[[ "$#" -eq 4 ]] || usage
CANDIDATE_REF="$1"
CANDIDATE_ID="$2"
TARGET_REF="$3"
EVIDENCE_INPUT="$4"

[[ "$CANDIDATE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || usage
[[ "$CANDIDATE_REF" =~ ^[a-z0-9./:_-]+$ && "$CANDIDATE_REF" == *:* ]] || usage
[[ "$TARGET_REF" =~ ^[a-z0-9./:_-]+$ && "$TARGET_REF" == *:* ]] || usage
[[ "$TARGET_REF" != "$CANDIDATE_REF" ]] || usage

physical_dir() {
  (cd -P -- "$1" 2>/dev/null && pwd -P)
}

stat_value() {
  local kind="$1" path="$2" value bsd_format gnu_format pattern
  case "$kind" in
    identity) bsd_format='%d:%i'; gnu_format='%d:%i'; pattern='^[0-9]+:[0-9]+$' ;;
    mode) bsd_format='%Lp'; gnu_format='%a'; pattern='^[0-7]{3,4}$' ;;
    owner) bsd_format='%u'; gnu_format='%u'; pattern='^[0-9]+$' ;;
    *) return 1 ;;
  esac
  if value="$(stat -f "$bsd_format" "$path" 2>/dev/null)" \
      && [[ "$value" =~ $pattern ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  if value="$(stat -c "$gnu_format" "$path" 2>/dev/null)" \
      && [[ "$value" =~ $pattern ]]; then
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

SOURCE_ROOT="$(cd -P -- "$(dirname -- "$0")/../.." && pwd -P)"
ACCEPTANCE_ROOT="$SOURCE_ROOT/scripts/acceptance"
DOCKERFILE="$ACCEPTANCE_ROOT/Dockerfile.health-fail"
FAILURE_ENTRYPOINT_SOURCE="$ACCEPTANCE_ROOT/entrypoint-health-fail.sh"
WINDOWS_EVIDENCE_HELPER="$ACCEPTANCE_ROOT/windows-volume-evidence.cjs"
BUILDER_SOURCE="$ACCEPTANCE_ROOT/build-health-fail-image.sh"

for path in "$DOCKERFILE" "$FAILURE_ENTRYPOINT_SOURCE" "$WINDOWS_EVIDENCE_HELPER" "$BUILDER_SOURCE"; do
  [[ -f "$path" && ! -L "$path" ]] || {
    echo "Missing or unsafe build input: $path" >&2
    exit 65
  }
done

EVIDENCE_PARENT="$(physical_dir "$(dirname -- "$EVIDENCE_INPUT")")" || usage
EVIDENCE_NAME="$(basename -- "$EVIDENCE_INPUT")"
[[ "$EVIDENCE_NAME" =~ ^rc-[a-zA-Z0-9._-]+\.log$ ]] || usage
[[ "$(stat_value mode "$EVIDENCE_PARENT")" == 700 \
    && "$(stat_value owner "$EVIDENCE_PARENT")" == "$(id -u)" ]] || {
  echo 'Evidence parent must be current-user-owned mode 0700.' >&2
  exit 66
}
EVIDENCE="$EVIDENCE_PARENT/$EVIDENCE_NAME"
[[ ! -e "$EVIDENCE" && ! -L "$EVIDENCE" ]] || {
  echo "Refusing to overwrite evidence: $EVIDENCE" >&2
  exit 67
}

umask 077
exec >"$EVIDENCE" 2>&1

EVIDENCE_ID_START="$(stat_value identity "$EVIDENCE")"
EVIDENCE_OWNER_START="$(stat_value owner "$EVIDENCE")"
EVIDENCE_MODE_START="$(stat_value mode "$EVIDENCE")"
[[ -f "$EVIDENCE" && ! -L "$EVIDENCE" \
    && "$EVIDENCE_OWNER_START" == "$(id -u)" \
    && "$EVIDENCE_MODE_START" == 600 ]] || exit 66

TASK_ROOT=''
TASK_ROOT_ID=''
RUN_ID=''
PROBE_NAME="rc-health-fail-probe-$$"
PROBE_ID=''
BUILD_ATTEMPTED=false
TARGET_WAS_FREE=false
CREATED_IMAGE_ID=''
CREATED_CONFIG_DIGEST=''
SOURCE_MANIFEST_START=''
CANDIDATE_INSPECT_START=''
TEST_REBIND_REF="${RC_HEALTH_FAIL_TEST_REBIND_REF:-}"

if [[ -n "$TEST_REBIND_REF" ]]; then
  [[ "$TEST_REBIND_REF" =~ ^[a-z0-9./:_-]+$ && "$TEST_REBIND_REF" == *:* \
      && "$TEST_REBIND_REF" != "$TARGET_REF" ]] || usage
fi

source_manifest() {
  local path digest
  for path in "$BUILDER_SOURCE" "$DOCKERFILE" "$FAILURE_ENTRYPOINT_SOURCE" "$WINDOWS_EVIDENCE_HELPER"; do
    digest="$(sha256_digest "$path")" || return
    printf '%s  %s\n' "$digest" "$path"
  done
}

cleanup_probe() {
  local cleanup_rc=0 actual_id actual_name actual_run target_id
  target_id="$PROBE_ID"
  if [[ -z "$target_id" ]] && docker container inspect "$PROBE_NAME" >/dev/null 2>&1; then
    target_id="$(docker container inspect --format '{{.Id}}' "$PROBE_NAME" 2>/dev/null || true)"
  fi
  if [[ -n "$target_id" ]] && docker container inspect "$target_id" >/dev/null 2>&1; then
    actual_id="$(docker container inspect --format '{{.Id}}' "$target_id" 2>/dev/null || true)"
    actual_name="$(docker container inspect --format '{{.Name}}' "$target_id" 2>/dev/null || true)"
    actual_run="$(docker container inspect --format '{{index .Config.Labels "ai.wentor.acceptance.build-run"}}' "$target_id" 2>/dev/null || true)"
    if [[ "$actual_id" != "$target_id" || "$actual_name" != "/$PROBE_NAME" \
        || "$actual_run" != "$RUN_ID" ]]; then
      echo 'probe_cleanup_identity_valid=false'
      cleanup_rc=1
    else
      docker container rm -f "$target_id" >/dev/null 2>&1 || cleanup_rc=1
    fi
  fi
  PROBE_ID=''
  if docker container inspect "$PROBE_NAME" >/dev/null 2>&1; then
    echo 'probe_cleanup_absent=false'
    cleanup_rc=1
  fi
  return "$cleanup_rc"
}

cleanup_failed_image() {
  local cleanup_rc=0 iid actual_id actual_label actual_entry repo_tags target_after created_after
  [[ "$BUILD_ATTEMPTED" == true && "$TARGET_WAS_FREE" == true ]] || return 0
  iid="$CREATED_IMAGE_ID"
  if [[ -z "$iid" && -n "$TASK_ROOT" && -f "$TASK_ROOT/build.metadata.json" ]]; then
    iid="$(node -e '
      const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))["containerimage.digest"];
      if (!/^sha256:[0-9a-f]{64}$/.test(value || "")) process.exit(1);
      process.stdout.write(value);
    ' "$TASK_ROOT/build.metadata.json" 2>/dev/null || true)"
  fi
  if docker image inspect "$TARGET_REF" >/dev/null 2>&1; then
    actual_id="$(docker image inspect --format '{{.Id}}' "$TARGET_REF" 2>/dev/null || true)"
    actual_label="$(docker image inspect --format '{{index .Config.Labels "ai.wentor.acceptance.failure-mode"}}' "$TARGET_REF" 2>/dev/null || true)"
    actual_entry="$(docker image inspect --format '{{json .Config.Entrypoint}}' "$TARGET_REF" 2>/dev/null || true)"
    if [[ "$iid" =~ ^sha256:[0-9a-f]{64}$ && "$actual_id" == "$iid" \
        && "$actual_label" == health-fail \
        && "$actual_entry" == '["/entrypoint-health-fail.sh"]' ]]; then
      echo "failure_cleanup_image_id=$iid"
      docker image rm "$TARGET_REF" >/dev/null 2>&1 || cleanup_rc=1
    else
      echo "failure_cleanup_target_preserved_foreign=$actual_id"
    fi
  fi

  if [[ "$iid" =~ ^sha256:[0-9a-f]{64}$ ]] && docker image inspect "$iid" >/dev/null 2>&1; then
    actual_id="$(docker image inspect --format '{{.Id}}' "$iid" 2>/dev/null || true)"
    actual_label="$(docker image inspect --format '{{index .Config.Labels "ai.wentor.acceptance.failure-mode"}}' "$iid" 2>/dev/null || true)"
    actual_entry="$(docker image inspect --format '{{json .Config.Entrypoint}}' "$iid" 2>/dev/null || true)"
    repo_tags="$(docker image inspect --format '{{json .RepoTags}}' "$iid" 2>/dev/null || true)"
    if [[ "$actual_id" == "$iid" && "$actual_label" == health-fail \
        && "$actual_entry" == '["/entrypoint-health-fail.sh"]' \
        && ( "$repo_tags" == '[]' || "$repo_tags" == 'null' ) ]]; then
      echo "failure_cleanup_dangling_image_id=$iid"
      docker image rm "$iid" >/dev/null 2>&1 || cleanup_rc=1
    elif [[ "$actual_id" == "$iid" ]]; then
      echo "failure_cleanup_created_image_preserved_tagged=$repo_tags"
      cleanup_rc=1
    fi
  fi

  target_after="$(docker image inspect --format '{{.Id}}' "$TARGET_REF" 2>/dev/null || true)"
  created_after=''
  if [[ "$iid" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    created_after="$(docker image inspect --format '{{.Id}}' "$iid" 2>/dev/null || true)"
  fi
  if [[ -z "$target_after" ]]; then
    echo 'failure_cleanup_target_residual=absent'
  else
    echo "failure_cleanup_target_residual=$target_after"
    if [[ "$target_after" == "$iid" ]]; then cleanup_rc=1; fi
  fi
  if [[ -z "$created_after" ]]; then
    echo 'failure_cleanup_created_image_residual=absent'
  else
    echo "failure_cleanup_created_image_residual=$created_after"
    cleanup_rc=1
  fi
  return "$cleanup_rc"
}

cleanup_task_root() {
  local cleanup_rc=0 sentinel
  [[ -n "$TASK_ROOT" ]] || return 0
  sentinel="$TASK_ROOT/.owner"
  if [[ "$(physical_dir "$(dirname -- "$TASK_ROOT")" 2>/dev/null || true)" != "$EVIDENCE_PARENT" \
      || "$(basename -- "$TASK_ROOT")" != rc-health-fail-build.* \
      || "$(stat_value identity "$TASK_ROOT" 2>/dev/null || true)" != "$TASK_ROOT_ID" \
      || "$(stat_value mode "$TASK_ROOT" 2>/dev/null || true)" != 700 \
      || "$(stat_value owner "$TASK_ROOT" 2>/dev/null || true)" != "$(id -u)" \
      || "$(cat "$sentinel" 2>/dev/null || true)" != "$RUN_ID" ]]; then
    echo 'task_cleanup_identity_valid=false'
    return 1
  fi
  rm -rf -- "$TASK_ROOT" || cleanup_rc=1
  if [[ -e "$TASK_ROOT" || -L "$TASK_ROOT" ]]; then
    echo 'task_cleanup_absent=false'
    cleanup_rc=1
  else
    echo 'task_cleanup_absent=true'
  fi
  return "$cleanup_rc"
}

on_exit() {
  local original_rc=$? cleanup_rc=0 post_manifest candidate_post target_post mode owner identity regular
  trap - EXIT INT TERM
  set +e
  cleanup_probe || cleanup_rc=1
  if [[ "$original_rc" -eq 0 && "$cleanup_rc" -ne 0 ]]; then original_rc="$cleanup_rc"; fi
  post_manifest="$(source_manifest)"
  if [[ "$post_manifest" != "$SOURCE_MANIFEST_START" ]]; then
    echo 'source_unchanged=false'
    original_rc=68
  else
    echo 'source_unchanged=true'
  fi
  candidate_post="$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$CANDIDATE_REF" 2>/dev/null || true)"
  if [[ "$candidate_post" != "$CANDIDATE_INSPECT_START" ]]; then
    echo 'candidate_unchanged=false'
    original_rc=69
  else
    echo 'candidate_unchanged=true'
  fi
  if [[ -n "$CREATED_IMAGE_ID" ]]; then
    target_post="$(docker image inspect --format '{{.Id}}' "$TARGET_REF" 2>/dev/null || true)"
    if [[ "$target_post" != "$CREATED_IMAGE_ID" ]]; then
      echo 'target_binding_unchanged=false'
      original_rc=69
    else
      echo 'target_binding_unchanged=true'
    fi
  fi
  regular=false
  if [[ -f "$EVIDENCE" && ! -L "$EVIDENCE" ]]; then regular=true; fi
  identity="$(stat_value identity "$EVIDENCE" 2>/dev/null || true)"
  owner="$(stat_value owner "$EVIDENCE" 2>/dev/null || true)"
  mode="$(stat_value mode "$EVIDENCE" 2>/dev/null || true)"
  echo "evidence_regular=$regular"
  echo "evidence_identity_unchanged=$([[ "$identity" == "$EVIDENCE_ID_START" ]] && echo true || echo false)"
  echo "evidence_owner=$owner"
  echo "evidence_mode=$mode"
  if [[ "$regular" != true || "$identity" != "$EVIDENCE_ID_START" \
      || "$owner" != "$EVIDENCE_OWNER_START" || "$owner" != "$(id -u)" \
      || "$mode" != "$EVIDENCE_MODE_START" || "$mode" != 600 ]]; then
    original_rc=70
  fi
  if [[ "$original_rc" -ne 0 ]]; then
    cleanup_failed_image || cleanup_rc=1
  fi
  if ! cleanup_task_root; then
    cleanup_rc=1
    if [[ "$original_rc" -eq 0 ]]; then
      original_rc=1
      cleanup_failed_image || cleanup_rc=1
    fi
  fi
  echo "exit_code=$original_rc"
  if [[ "$original_rc" -eq 0 ]]; then echo 'result=PASS'; else echo 'result=FAIL'; fi
  exit "$original_rc"
}

trap on_exit EXIT
trap 'exit 130' INT TERM

SOURCE_MANIFEST_START="$(source_manifest)"
echo 'run=build-health-fail-image'
echo "candidate_ref=$CANDIDATE_REF"
echo "candidate_id=$CANDIDATE_ID"
echo "target_ref=$TARGET_REF"
echo "evidence=$EVIDENCE"
echo 'source_manifest_begin'
printf '%s\n' "$SOURCE_MANIFEST_START"
echo 'source_manifest_end'

CANDIDATE_INSPECT_START="$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$CANDIDATE_REF")"
[[ "$CANDIDATE_INSPECT_START" == "$CANDIDATE_ID linux/amd64" ]] || {
  echo "candidate_identity_mismatch=$CANDIDATE_INSPECT_START"
  exit 71
}
[[ "$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$CANDIDATE_ID")" \
    == "$CANDIDATE_ID linux/amd64" ]] || exit 71
if docker image inspect "$TARGET_REF" >/dev/null 2>&1; then
  echo 'target_preoccupied=true'
  exit 72
fi
TARGET_WAS_FREE=true
if docker container inspect "$PROBE_NAME" >/dev/null 2>&1; then
  echo 'probe_name_preoccupied=true'
  exit 72
fi
docker buildx inspect desktop-linux >/dev/null

TASK_ROOT="$(mktemp -d "$EVIDENCE_PARENT/rc-health-fail-build.XXXXXX")"
chmod 700 "$TASK_ROOT"
TASK_ROOT_ID="$(stat_value identity "$TASK_ROOT")"
RUN_ID="$(basename -- "$TASK_ROOT")-$$"
printf '%s\n' "$RUN_ID" >"$TASK_ROOT/.owner"
mkdir -m 700 "$TASK_ROOT/context"
cp "$DOCKERFILE" "$TASK_ROOT/context/Dockerfile"
cp "$FAILURE_ENTRYPOINT_SOURCE" "$TASK_ROOT/context/entrypoint-health-fail.sh"
chmod 600 "$TASK_ROOT/context/Dockerfile" "$TASK_ROOT/context/entrypoint-health-fail.sh"
[[ "$(sha256_digest "$TASK_ROOT/context/Dockerfile")" == "$(sha256_digest "$DOCKERFILE")" \
    && "$(sha256_digest "$TASK_ROOT/context/entrypoint-health-fail.sh")" \
      == "$(sha256_digest "$FAILURE_ENTRYPOINT_SOURCE")" ]] || exit 73
[[ "$(find "$TASK_ROOT/context" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" == 2 ]] \
  || exit 73

BUILD_ATTEMPTED=true
docker buildx build \
  --builder desktop-linux \
  --platform linux/amd64 \
  --load \
  --provenance=false \
  --sbom=false \
  --build-arg "BASE_IMAGE=$CANDIDATE_REF@$CANDIDATE_ID" \
  --file "$TASK_ROOT/context/Dockerfile" \
  --tag "$TARGET_REF" \
  --iidfile "$TASK_ROOT/image.iid" \
  --metadata-file "$TASK_ROOT/build.metadata.json" \
  "$TASK_ROOT/context"
CREATED_IMAGE_ID="$(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))["containerimage.digest"];
  if (!/^sha256:[0-9a-f]{64}$/.test(value || "")) process.exit(1);
  process.stdout.write(value);
' "$TASK_ROOT/build.metadata.json")"
CREATED_CONFIG_DIGEST="$(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))["containerimage.config.digest"];
  if (!/^sha256:[0-9a-f]{64}$/.test(value || "")) process.exit(1);
  process.stdout.write(value);
' "$TASK_ROOT/build.metadata.json")"
[[ "$CREATED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 74
[[ "$(tr -d '[:space:]' <"$TASK_ROOT/image.iid")" == "$CREATED_CONFIG_DIGEST" ]] || exit 74
[[ "$(docker image inspect --format '{{.Id}}' "$TARGET_REF")" == "$CREATED_IMAGE_ID" ]] || exit 74
echo "local_image_id=$CREATED_IMAGE_ID"
echo "local_config_digest=$CREATED_CONFIG_DIGEST"

if [[ -n "$TEST_REBIND_REF" ]]; then
  TEST_REBIND_ID="$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$TEST_REBIND_REF")"
  [[ "$TEST_REBIND_ID" =~ ^sha256:[0-9a-f]{64}\ linux/amd64$ \
      && "${TEST_REBIND_ID%% *}" != "$CREATED_IMAGE_ID" ]] || exit 77
  docker image tag "$TEST_REBIND_REF" "$TARGET_REF"
  [[ "$(docker image inspect --format '{{.Id}}' "$TARGET_REF")" == "${TEST_REBIND_ID%% *}" ]] || exit 77
  echo "test_hook_target_rebound_to=${TEST_REBIND_ID%% *}"
  exit 77
fi

docker image inspect "$CANDIDATE_ID" >"$TASK_ROOT/candidate.inspect.json"
docker image inspect "$CREATED_IMAGE_ID" >"$TASK_ROOT/health.inspect.json"
node - "$TASK_ROOT/candidate.inspect.json" "$TASK_ROOT/health.inspect.json" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [candidatePath, healthPath] = process.argv.slice(2);
const [candidate] = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const [health] = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
assert.equal(candidate.Os, 'linux');
assert.equal(candidate.Architecture, 'amd64');
assert.equal(health.Os, 'linux');
assert.equal(health.Architecture, 'amd64');
assert.deepEqual(candidate.Config.Entrypoint, ['/entrypoint.sh']);
assert.deepEqual(health.Config.Entrypoint, ['/entrypoint-health-fail.sh']);
const candidateConfig = structuredClone(candidate.Config);
const healthConfig = structuredClone(health.Config);
delete candidateConfig.Entrypoint;
delete candidateConfig.Labels;
delete healthConfig.Entrypoint;
delete healthConfig.Labels;
assert.deepStrictEqual(healthConfig, candidateConfig, 'config except Entrypoint/Labels drifted');
const healthLabels = { ...(health.Config.Labels || {}) };
assert.equal(healthLabels['ai.wentor.acceptance.failure-mode'], 'health-fail');
delete healthLabels['ai.wentor.acceptance.failure-mode'];
assert.deepStrictEqual(healthLabels, candidate.Config.Labels || {}, 'labels besides failure mode drifted');
const candidateLayers = candidate.RootFS.Layers || [];
const healthLayers = health.RootFS.Layers || [];
assert.ok(candidateLayers.length > 0);
assert.equal(healthLayers.length, candidateLayers.length + 1, 'health image must add exactly one layer');
assert.deepStrictEqual(healthLayers.slice(0, candidateLayers.length), candidateLayers,
  'candidate layers are not an exact prefix');
process.stdout.write(`config_except_entrypoint_labels=PASS\nlabels_only_failure_mode=PASS\n`);
process.stdout.write(`layers=candidate:${candidateLayers.length},health:${healthLayers.length},prefix:PASS\n`);
process.stdout.write(`extra_layer=${healthLayers.at(-1)}\n`);
NODE

run_runtime_helper() {
  local image="$1" output="$2" extra_path="${3:-}" create_file="$TASK_ROOT/probe.create"
  local args=(
    container create --platform linux/amd64 --name "$PROBE_NAME"
    --label "ai.wentor.acceptance.build-run=$RUN_ID"
    --network none --entrypoint node
    --mount "type=bind,source=$WINDOWS_EVIDENCE_HELPER,target=/acceptance/windows-volume-evidence.cjs,readonly"
    "$image" /acceptance/windows-volume-evidence.cjs image-runtime
  )
  if [[ -n "$extra_path" ]]; then args+=(--extra-path "$extra_path"); fi
  docker "${args[@]}" >"$create_file"
  PROBE_ID="$(tr -d '[:space:]' <"$create_file")"
  [[ "$PROBE_ID" =~ ^[0-9a-f]{64}$ ]] || return 75
  docker container start --attach "$PROBE_ID" >"$output"
  cleanup_probe
}

run_runtime_helper "$CANDIDATE_ID" "$TASK_ROOT/candidate.runtime.json"
run_runtime_helper "$CREATED_IMAGE_ID" "$TASK_ROOT/health.runtime.json" /entrypoint-health-fail.sh
ENTRYPOINT_SHA="$(sha256_digest "$FAILURE_ENTRYPOINT_SOURCE")"
node - "$TASK_ROOT/candidate.runtime.json" "$TASK_ROOT/health.runtime.json" "$ENTRYPOINT_SHA" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [candidatePath, healthPath, entrypointSha] = process.argv.slice(2);
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
assert.equal(candidate.length, 18);
assert.equal(health.length, 19);
const failure = health.filter((value) => value.path === '/entrypoint-health-fail.sh');
assert.equal(failure.length, 1);
assert.equal(failure[0].sha256, entrypointSha);
assert.equal(failure[0].mode, 0o755);
assert.deepStrictEqual(health.filter((value) => value.path !== '/entrypoint-health-fail.sh'), candidate);
process.stdout.write('critical_runtime=18/18 exact\n');
process.stdout.write(`failure_entrypoint_sha256=${failure[0].sha256}\n`);
process.stdout.write(`failure_entrypoint_mode=${failure[0].mode}\n`);
process.stdout.write(`failure_entrypoint_size=${failure[0].size}\n`);
NODE

docker container create \
  --platform linux/amd64 \
  --name "$PROBE_NAME" \
  --label "ai.wentor.acceptance.build-run=$RUN_ID" \
  --network none \
  "$CREATED_IMAGE_ID" >"$TASK_ROOT/probe.create"
PROBE_ID="$(tr -d '[:space:]' <"$TASK_ROOT/probe.create")"
[[ "$PROBE_ID" =~ ^[0-9a-f]{64}$ ]] || exit 75
docker container start "$PROBE_ID" >/dev/null
sleep 1
[[ "$(docker container inspect --format '{{.State.Running}}' "$PROBE_ID")" == true ]] || exit 76
if docker container exec "$PROBE_ID" /bin/sh -c \
    "curl -sf --noproxy '*' http://127.0.0.1:28789/healthz >/dev/null 2>&1"; then
  echo 'health_endpoint_unexpectedly_available=true'
  exit 76
fi
[[ "$(docker container inspect --format '{{.State.Running}}' "$PROBE_ID")" == true ]] || exit 76
docker container stop --time 5 "$PROBE_ID" >/dev/null
[[ "$(docker container inspect --format '{{.State.Running}} {{.State.ExitCode}}' "$PROBE_ID")" \
    == 'false 0' ]] || exit 76
docker container start "$PROBE_ID" >/dev/null
sleep 1
[[ "$(docker container inspect --format '{{.State.Running}}' "$PROBE_ID")" == true ]] || exit 76
docker container kill --signal INT "$PROBE_ID" >/dev/null
for _attempt in $(seq 1 20); do
  [[ "$(docker container inspect --format '{{.State.Running}}' "$PROBE_ID")" == false ]] && break
  sleep 0.1
done
[[ "$(docker container inspect --format '{{.State.Running}} {{.State.ExitCode}}' "$PROBE_ID")" \
    == 'false 0' ]] || exit 76
echo 'health_fail_runtime=running_without_health_TERM_exit0_INT_exit0_PASS'
cleanup_probe

echo "local_reference=$TARGET_REF"
echo "local_image_id=$CREATED_IMAGE_ID"
echo 'local_platform=linux/amd64'
echo 'failure_entrypoint=/entrypoint-health-fail.sh'
echo "failure_entrypoint_sha256=$ENTRYPOINT_SHA"
echo 'label.ai.wentor.acceptance.failure-mode=health-fail'
echo "label.org.opencontainers.image.version=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$CREATED_IMAGE_ID")"
echo "label.org.opencontainers.image.revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CREATED_IMAGE_ID")"
echo 'registry_digest=EXTERNAL_REQUIRED_AFTER_PUSH_NOT_GENERATED'
echo 'local_health_fail_image_retained=true'
