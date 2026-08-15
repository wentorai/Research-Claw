#!/usr/bin/env bash
#
# Start one exact local image architecture with four isolated named volumes,
# verify the real Gateway health endpoint and runtime identity, scan the
# resulting state without echoing matched values, then remove only resources
# created and labelled by this invocation.

set -euo pipefail

usage() {
  echo "Usage: $0 <image-ref> <image-id> <platform> <machine> <node-arch> <revision> <installer-sha256> <evidence-prefix> <owner>" >&2
  exit 64
}

[[ "$#" -eq 9 ]] || usage

REF="$1"
IMAGE_ID="$2"
PLATFORM="$3"
MACHINE="$4"
NODE_ARCH="$5"
REVISION="$6"
INSTALLER_SHA="$7"
EVIDENCE_PREFIX="$8"
OWNER="$9"

VERSION='0.8.3'
OPENCLAW_VERSION='2026.6.1'
ARCH="${PLATFORM#linux/}"
CONTAINER="$OWNER"
VOLUMES=(
  "$OWNER-config"
  "$OWNER-data"
  "$OWNER-workspace"
  "$OWNER-state"
)
DESTINATIONS=(
  '/app/config'
  '/app/.research-claw'
  '/app/workspace'
  '/root/.openclaw'
)
LOG="$EVIDENCE_PREFIX-smoke.log"
INSPECT="$EVIDENCE_PREFIX-inspect.json"
TOP="$EVIDENCE_PREFIX-top.txt"
CONTAINER_LOG="$EVIDENCE_PREFIX-container.log"
BODY="$EVIDENCE_PREFIX-body.json"
VOLUME_SCAN="$EVIDENCE_PREFIX-volume-scan.json"
CID_FILE="$EVIDENCE_PREFIX-container.cid"
CREATED_VOLUMES=()
CREATED_CONTAINER_ID=''
RUNNER_SHA_START="$(shasum -a 256 "$0" | awk '{print $1}')"

[[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || usage
[[ "$PLATFORM" =~ ^linux/(arm64|amd64)$ ]] || usage
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$INSTALLER_SHA" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$OWNER" =~ ^rc-[a-z0-9][a-z0-9-]{5,80}-health-smoke-gate$ ]] || usage
[[ "$EVIDENCE_PREFIX" =~ ^/private/tmp/rc-[a-zA-Z0-9._-]+$ ]] || usage

umask 077
for evidence in "$LOG" "$INSPECT" "$TOP" "$CONTAINER_LOG" "$BODY" "$VOLUME_SCAN" "$CID_FILE"; do
  if [[ -e "$evidence" || -L "$evidence" ]]; then
    echo "Refusing to overwrite evidence path: $evidence" >&2
    exit 65
  fi
done

collect_container_evidence() {
  if [[ -n "$CREATED_CONTAINER_ID" ]] \
      && docker container inspect "$CREATED_CONTAINER_ID" >/dev/null 2>&1; then
    docker container inspect "$CREATED_CONTAINER_ID" >"$INSPECT" 2>/dev/null || true
    docker top "$CREATED_CONTAINER_ID" -eo pid,ppid,user,etime,args >"$TOP" 2>/dev/null || true
    docker logs "$CREATED_CONTAINER_ID" >"$CONTAINER_LOG" 2>&1 || true
  fi
}

cleanup_owned() {
  local cleanup_rc=0 actual_id actual_label volume absent=0

  collect_container_evidence
  if [[ -n "$CREATED_CONTAINER_ID" ]] \
      && docker container inspect "$CREATED_CONTAINER_ID" >/dev/null 2>&1; then
    actual_id="$(docker container inspect --format '{{.Id}}' "$CREATED_CONTAINER_ID" 2>/dev/null || true)"
    actual_label="$(docker container inspect --format '{{index .Config.Labels "rc.audit.owner"}}' "$CREATED_CONTAINER_ID" 2>/dev/null || true)"
    if [[ "$actual_id" != "$CREATED_CONTAINER_ID" || "$actual_label" != "$OWNER" ]]; then
      echo "cleanup_refused_container_identity=true"
      cleanup_rc=1
    else
      docker stop --time 20 "$CREATED_CONTAINER_ID" >/dev/null 2>&1 \
        || docker kill "$CREATED_CONTAINER_ID" >/dev/null 2>&1 \
        || cleanup_rc=1
      docker rm "$CREATED_CONTAINER_ID" >/dev/null 2>&1 || cleanup_rc=1
    fi
  fi

  if [[ "${#CREATED_VOLUMES[@]}" -gt 0 ]]; then
    for volume in "${CREATED_VOLUMES[@]}"; do
      if docker volume inspect "$volume" >/dev/null 2>&1; then
        actual_label="$(docker volume inspect --format '{{index .Labels "rc.audit.owner"}}' "$volume" 2>/dev/null || true)"
        if [[ "$actual_label" != "$OWNER" ]]; then
          echo "cleanup_refused_volume=$volume label_mismatch=true"
          cleanup_rc=1
        else
          docker volume rm "$volume" >/dev/null 2>&1 || cleanup_rc=1
        fi
      fi
    done
  fi

  if [[ -z "$CREATED_CONTAINER_ID" ]]; then
    echo 'cleanup_created_container_absent=not-created'
  elif docker container inspect "$CREATED_CONTAINER_ID" >/dev/null 2>&1; then
    echo 'cleanup_container_absent=false'
    cleanup_rc=1
  else
    echo 'cleanup_container_absent=true'
  fi

  if [[ "${#CREATED_VOLUMES[@]}" -gt 0 ]]; then
    for volume in "${CREATED_VOLUMES[@]}"; do
      if ! docker volume inspect "$volume" >/dev/null 2>&1; then
        absent=$((absent + 1))
      fi
    done
  fi
  echo "cleanup_volumes_absent=$absent/${#CREATED_VOLUMES[@]}"
  return "$cleanup_rc"
}

validate_final_evidence() {
  local evidence

  for evidence in "$LOG" "$INSPECT" "$TOP" "$CONTAINER_LOG" "$BODY" "$VOLUME_SCAN" "$CID_FILE"; do
    test -s "$evidence" || return
  done
  rg -q '/bin/sh /entrypoint\.sh' "$TOP" || return
  rg -q '(research-claw$|/app/node_modules/openclaw/dist/entry\.js gateway run --allow-unconfigured --auth token --port 28789 --bind lan --force$)' "$TOP" || return
  rg -q '\[gateway\] http server listening' "$CONTAINER_LOG" || return
  rg -q '\[gateway\] ready' "$CONTAINER_LOG" || return

  node - "$INSPECT" "$BODY" "$VOLUME_SCAN" "$CID_FILE" \
    "$CREATED_CONTAINER_ID" "$IMAGE_ID" "$VERSION" "$REVISION" "$OWNER" \
    "${VOLUMES[0]}=${DESTINATIONS[0]}" \
    "${VOLUMES[1]}=${DESTINATIONS[1]}" \
    "${VOLUMES[2]}=${DESTINATIONS[2]}" \
    "${VOLUMES[3]}=${DESTINATIONS[3]}" <<'NODE' || return
const fs = require('fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const inspectPath = args.shift();
const bodyPath = args.shift();
const volumeScanPath = args.shift();
const cidPath = args.shift();
const containerId = args.shift();
const imageId = args.shift();
const version = args.shift();
const revision = args.shift();
const owner = args.shift();
const expectedMounts = args.sort();

assert.match(containerId, /^[0-9a-f]{64}$/);
assert.equal(fs.readFileSync(cidPath, 'utf8').trim(), containerId);

const inspected = JSON.parse(fs.readFileSync(inspectPath, 'utf8'));
assert.equal(inspected.length, 1);
const container = inspected[0];
assert.equal(container.Id, containerId);
assert.equal(container.Image, imageId);
assert.equal(container.Config.Labels['rc.audit.owner'], owner);
const env = Object.fromEntries((container.Config.Env || []).map((value) => {
  const index = value.indexOf('=');
  return [value.slice(0, index), value.slice(index + 1)];
}));
assert.equal(env.RC_BUILD_VERSION, version);
assert.equal(env.RC_BUILD_COMMIT, revision);
assert.equal('OPENCLAW_GATEWAY_TOKEN' in env, false);
assert.deepEqual(
  container.Mounts.map((mount) => mount.Name + '=' + mount.Destination).sort(),
  expectedMounts,
);

const body = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));
assert.equal(body.ok, true);
assert.equal(body.status, 'live');

const scan = JSON.parse(fs.readFileSync(volumeScanPath, 'utf8'));
assert.equal(scan.scannerSelfTests, 'PASS');
assert.deepEqual(scan.hits, []);
assert.deepEqual(scan.expectedRuntimeCredentials, [{
  path: '/root/.openclaw/identity/device.json',
  kind: 'expected-runtime-device-private-key',
  jsonKey: 'privateKeyPem',
  mode: '0600',
  privateKeyBlocks: 1,
}]);
assert.deepEqual(Object.keys(scan.volumes).sort(), [
  '/app/.research-claw',
  '/app/config',
  '/app/workspace',
  '/root/.openclaw',
]);
for (const value of Object.values(scan.volumes)) {
  assert.equal(Number.isInteger(value.files) && value.files >= 0, true);
  assert.equal(Number.isInteger(value.bytes) && value.bytes >= 0, true);
}
NODE

  for evidence in "$LOG" "$INSPECT" "$TOP" "$CONTAINER_LOG" "$BODY" "$VOLUME_SCAN" "$CID_FILE"; do
    if rg -a -q \
      -e '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' \
      -e '-----BEGIN CERTIFICATE-----' \
      -e 'rca_[A-Za-z0-9_-]{43,}' \
      -e 'RC_TEST_ONLY_FAKE_' \
      -e 'RC_FAKE_PEM' \
      -e 'sk-(proj-)?[A-Za-z0-9_-]{20,}' \
      -e 'ghp_[A-Za-z0-9]{36}' \
      -e 'AKIA[0-9A-Z]{16}' \
      "$evidence"; then
      echo "final_evidence_secret_hit=$(basename "$evidence")"
      return 42
    fi
  done
  test "$(shasum -a 256 "$0" | awk '{print $1}')" = "$RUNNER_SHA_START" || return
  echo 'final_evidence_revalidated=true'
}

on_exit() {
  local original_rc=$?
  local cleanup_rc final_evidence_rc
  trap - EXIT INT TERM
  set +e
  cleanup_owned
  cleanup_rc=$?
  if [[ "$original_rc" -eq 0 && "$cleanup_rc" -ne 0 ]]; then
    original_rc="$cleanup_rc"
  fi
  if [[ "$original_rc" -eq 0 ]]; then
    validate_final_evidence
    final_evidence_rc=$?
    if [[ "$final_evidence_rc" -ne 0 ]]; then
      original_rc="$final_evidence_rc"
    fi
  fi
  echo "exit_code=$original_rc"
  if [[ "$original_rc" -eq 0 ]]; then
    echo 'result=PASS'
  fi
  exit "$original_rc"
}

exec >"$LOG" 2>&1
trap on_exit EXIT
trap 'exit 130' INT TERM

echo "ref=$REF"
echo "image_id=$IMAGE_ID"
echo "platform=$PLATFORM"
echo "owner=$OWNER"
echo "runner_sha256=$RUNNER_SHA_START"

test "$(docker image inspect --format '{{.Id}}' "$REF")" = "$IMAGE_ID"
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$REF")" = "$PLATFORM"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$REF")" = "$VERSION"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$REF")" = "$REVISION"

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo 'preflight_existing_container=true'
  exit 70
fi
for volume in "${VOLUMES[@]}"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "preflight_existing_volume=$volume"
    exit 71
  fi
done

for volume in "${VOLUMES[@]}"; do
  docker volume create \
    --label "rc.audit.owner=$OWNER" \
    --label "rc.audit.arch=$ARCH" \
    "$volume" >/dev/null
  CREATED_VOLUMES+=("$volume")
done

if ! docker run -d \
  --cidfile "$CID_FILE" \
  --pull never \
  --platform "$PLATFORM" \
  --name "$CONTAINER" \
  --label "rc.audit.owner=$OWNER" \
  --label "rc.audit.arch=$ARCH" \
  -p '127.0.0.1::28789' \
  -v "${VOLUMES[0]}:${DESTINATIONS[0]}" \
  -v "${VOLUMES[1]}:${DESTINATIONS[1]}" \
  -v "${VOLUMES[2]}:${DESTINATIONS[2]}" \
  -v "${VOLUMES[3]}:${DESTINATIONS[3]}" \
  --restart no \
  "$IMAGE_ID" >/dev/null; then
  if [[ -s "$CID_FILE" ]]; then
    CREATED_CONTAINER_ID="$(tr -d '\r\n' <"$CID_FILE")"
    [[ "$CREATED_CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] || CREATED_CONTAINER_ID=''
  fi
  exit 72
fi

CREATED_CONTAINER_ID="$(tr -d '\r\n' <"$CID_FILE")"
[[ "$CREATED_CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]]
test "$(docker container inspect --format '{{.Id}}' "$CONTAINER")" = "$CREATED_CONTAINER_ID"

HOST_PORT="$(docker port "$CONTAINER" 28789/tcp | awk -F: '$1=="127.0.0.1"{print $NF; exit}')"
[[ "$HOST_PORT" =~ ^[0-9]+$ ]]
echo "host_port=$HOST_PORT"

ready=false
attempts=0
for attempts in $(seq 1 180); do
  internal_code="$(docker exec "$CONTAINER" \
    curl -sS --noproxy '*' -o /tmp/rc-t10-health-body.json \
      -w '%{http_code}' http://127.0.0.1:28789/healthz 2>/dev/null || true)"
  host_code="$(curl -sS --noproxy '*' -o "$BODY" \
    -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/healthz" 2>/dev/null || true)"
  if [[ "$internal_code" == 200 && "$host_code" == 200 ]]; then
    ready=true
    break
  fi
  sleep 1
done
test "$ready" = true
echo 'health_internal=200'
echo 'health_host=200'
echo "health_attempts=$attempts"

node - "$BODY" <<'NODE'
const fs = require('fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (body.ok !== true || body.status !== 'live') {
  throw new Error('unexpected health body');
}
NODE

collect_container_evidence

for evidence in "$INSPECT" "$TOP" "$CONTAINER_LOG" "$BODY" "$CID_FILE"; do
  test -s "$evidence"
done
rg -q '/bin/sh /entrypoint\.sh' "$TOP"
rg -q '(research-claw$|/app/node_modules/openclaw/dist/entry\.js gateway run --allow-unconfigured --auth token --port 28789 --bind lan --force$)' "$TOP"
rg -q '\[gateway\] http server listening' "$CONTAINER_LOG"
rg -q '\[gateway\] ready' "$CONTAINER_LOG"

node - "$INSPECT" "$IMAGE_ID" "$VERSION" "$REVISION" "$OWNER" \
  "${VOLUMES[0]}=${DESTINATIONS[0]}" \
  "${VOLUMES[1]}=${DESTINATIONS[1]}" \
  "${VOLUMES[2]}=${DESTINATIONS[2]}" \
  "${VOLUMES[3]}=${DESTINATIONS[3]}" <<'NODE'
const fs = require('fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const p = args.shift();
const imageId = args.shift();
const version = args.shift();
const revision = args.shift();
const owner = args.shift();
const expectedMounts = args.sort();
const x = JSON.parse(fs.readFileSync(p, 'utf8'))[0];
assert.equal(x.Image, imageId);
assert.equal(x.Config.Labels['rc.audit.owner'], owner);
const env = Object.fromEntries((x.Config.Env || []).map((value) => {
  const index = value.indexOf('=');
  return [value.slice(0, index), value.slice(index + 1)];
}));
assert.equal(env.RC_BUILD_VERSION, version);
assert.equal(env.RC_BUILD_COMMIT, revision);
assert.equal('OPENCLAW_GATEWAY_TOKEN' in env, false);
const actualMounts = x.Mounts
  .map((mount) => mount.Name + '=' + mount.Destination)
  .sort();
assert.deepEqual(actualMounts, expectedMounts);
NODE

test "$(docker exec "$CONTAINER" uname -m)" = "$MACHINE"
test "$(docker exec "$CONTAINER" node -p 'process.platform')" = linux
test "$(docker exec "$CONTAINER" node -p 'process.arch')" = "$NODE_ARCH"
test "$(docker exec "$CONTAINER" node -p "require('/app/package.json').version")" = "$VERSION"
test "$(docker exec "$CONTAINER" node -p "require('/app/node_modules/openclaw/package.json').version")" = "$OPENCLAW_VERSION"
test "$(docker exec "$CONTAINER" shasum -a 256 /app/scripts/install.sh | awk '{print $1}')" = "$INSTALLER_SHA"

docker exec -i "$CONTAINER" python3 - >"$VOLUME_SCAN" <<'PY'
import hashlib
import json
import os
import re
import stat

ROOTS = [
    "/app/config",
    "/app/.research-claw",
    "/app/workspace",
    "/root/.openclaw",
]
PATTERNS = [
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"-----BEGIN CERTIFICATE-----"),
    re.compile(rb"rca_[A-Za-z0-9_-]{43,}"),
    re.compile(rb"RC_TEST_ONLY_FAKE_"),
    re.compile(rb"RC_FAKE_PEM"),
    re.compile(rb"sk-(?:proj-)?[A-Za-z0-9_-]{20,}"),
    re.compile(rb"ghp_[A-Za-z0-9]{36}"),
    re.compile(rb"AKIA[0-9A-Z]{16}"),
]
KNOWN_HASHES = {
    "0ba8d544d003d8970c887b8c08e096572d79b6ae8e6217a06b13ecb43a8f1334",
    "e851858d3f99d87c74f985056ef16e77eb6f5e0f143788c3edde90f2b2ec0d57",
    "1dc933e7a31f86d74b955b5d51a59b0593e358d803dfc46f1eb9dc060816544d",
}
SENSITIVE_KEY = re.compile(
    r"(?:api[_-]?key|token|secret|password|private[_-]?key(?:pem)?)$",
    re.IGNORECASE,
)
PLACEHOLDER_VALUE = re.compile(
    r"(?:YOUR_[A-Z0-9_-]+|(?:sk-)?YOUR_[A-Z0-9_-]+|<YOUR_[A-Z0-9_-]+>)"
)
PRIVATE_KEY_PEM = re.compile(
    r"-----BEGIN PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]+\n)+"
    r"-----END PRIVATE KEY-----\n?"
)
PUBLIC_KEY_PEM = re.compile(
    r"-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]+\n)+"
    r"-----END PUBLIC KEY-----\n?"
)
EXPECTED_DEVICE_IDENTITY = "/root/.openclaw/identity/device.json"


def is_sensitive_key(path, key):
    return (
        SENSITIVE_KEY.search(str(key)) is not None
        or (
            os.path.basename(path) == "auth-profiles.json"
            and str(key).lower() == "key"
        )
    )


def safe_value(path, key_path, value):
    if value is None or not isinstance(value, str) or value == "":
        return True
    if (
        key_path[-3:] == ["gateway", "auth", "token"]
        and value == "research-claw"
        and path in {
            "/app/config/openclaw.json",
            "/root/.openclaw/openclaw.json",
        }
    ):
        return True
    if (
        path == EXPECTED_DEVICE_IDENTITY
        and key_path == ["privateKeyPem"]
    ):
        return True
    return PLACEHOLDER_VALUE.fullmatch(value) is not None


def validate_device_identity(path, file_stat, raw, parsed):
    expected_keys = {
        "version",
        "deviceId",
        "publicKeyPem",
        "privateKeyPem",
        "createdAtMs",
    }
    return (
        path == EXPECTED_DEVICE_IDENTITY
        and stat.S_IMODE(file_stat.st_mode) == 0o600
        and isinstance(parsed, dict)
        and set(parsed) == expected_keys
        and parsed.get("version") == 1
        and isinstance(parsed.get("deviceId"), str)
        and re.fullmatch(r"[0-9a-f]{64}", parsed["deviceId"]) is not None
        and isinstance(parsed.get("publicKeyPem"), str)
        and PUBLIC_KEY_PEM.fullmatch(parsed["publicKeyPem"]) is not None
        and isinstance(parsed.get("privateKeyPem"), str)
        and PRIVATE_KEY_PEM.fullmatch(parsed["privateKeyPem"]) is not None
        and raw.count(b"-----BEGIN PRIVATE KEY-----") == 1
        and raw.count(b"-----END PRIVATE KEY-----") == 1
        and isinstance(parsed.get("createdAtMs"), int)
        and not isinstance(parsed.get("createdAtMs"), bool)
        and parsed["createdAtMs"] > 0
    )


def inspect_json(value, path, key_path, hits):
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = key_path + [str(key)]
            if is_sensitive_key(path, key) and not safe_value(path, child_path, child):
                hits.append({
                    "path": path,
                    "kind": "sensitive-json-value",
                    "jsonKey": ".".join(child_path),
                    "valueLength": len(child) if isinstance(child, str) else None,
                })
            inspect_json(child, path, child_path, hits)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            inspect_json(child, path, key_path + [str(index)], hits)


def scan_link(root, path, summary, hits):
    data = os.readlink(path).encode("utf-8", "surrogateescape")
    summary[root]["files"] += 1
    summary[root]["bytes"] += len(data)
    for index, pattern in enumerate(PATTERNS):
        if pattern.search(data):
            hits.append({"path": path, "kind": "symlink-pattern-" + str(index)})


def run_scanner_self_tests():
    config_path = "/app/config/openclaw.json"
    assert is_sensitive_key("/root/.openclaw/auth-profiles.json", "key")
    assert is_sensitive_key(config_path, "modelApiKey")
    assert not safe_value(config_path, ["models", "apiKey"], "abcdefghijklmnop")
    assert not safe_value(
        config_path,
        ["models", "apiKey"],
        "real-placeholder-secret-value",
    )
    assert not safe_value(
        config_path,
        ["models", "apiKey"],
        "real<secret-value",
    )
    assert not safe_value(config_path, ["models", "apiKey"], "<ACTUAL_SECRET>")
    assert safe_value(config_path, ["models", "apiKey"], "YOUR_API_KEY")
    assert safe_value(config_path, ["models", "apiKey"], "<YOUR_API_KEY>")
    assert PATTERNS[2].search(("rca_" + "A" * 43).encode("ascii")) is not None

    parsed = {
        "version": 1,
        "deviceId": "a" * 64,
        "publicKeyPem": (
            "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n"
        ),
        "privateKeyPem": (
            "-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\n"
        ),
        "createdAtMs": 1,
    }
    regular_0600 = type(
        "FakeStat",
        (),
        {"st_mode": stat.S_IFREG | 0o600},
    )()
    raw = json.dumps(parsed).encode("utf-8")
    assert validate_device_identity(
        EXPECTED_DEVICE_IDENTITY,
        regular_0600,
        raw,
        parsed,
    )
    assert not validate_device_identity(
        EXPECTED_DEVICE_IDENTITY,
        regular_0600,
        raw + b"-----BEGIN PRIVATE KEY-----",
        parsed,
    )


run_scanner_self_tests()
summary = {root: {"files": 0, "bytes": 0} for root in ROOTS}
hits = []
expected = []
for root in ROOTS:
    for base, dirs, names in os.walk(root, topdown=True, followlinks=False):
        kept_dirs = []
        for name in dirs:
            path = os.path.join(base, name)
            if os.path.islink(path):
                scan_link(root, path, summary, hits)
            else:
                kept_dirs.append(name)
        dirs[:] = kept_dirs

        for name in names:
            path = os.path.join(base, name)
            try:
                file_stat = os.lstat(path)
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(file_stat.st_mode):
                scan_link(root, path, summary, hits)
                continue
            if not stat.S_ISREG(file_stat.st_mode):
                continue

            summary[root]["files"] += 1
            digest = hashlib.sha256()
            overlap = b""
            size = 0
            found = set()
            with open(path, "rb", buffering=0) as handle:
                while True:
                    chunk = handle.read(65536)
                    if not chunk:
                        break
                    size += len(chunk)
                    digest.update(chunk)
                    window = overlap + chunk
                    for index, pattern in enumerate(PATTERNS):
                        if pattern.search(window):
                            found.add(index)
                    overlap = window[-512:]
            summary[root]["bytes"] += size
            if digest.hexdigest() in KNOWN_HASHES:
                hits.append({"path": path, "kind": "known-fixture-hash"})
            for index in sorted(found):
                if not (index == 0 and path == EXPECTED_DEVICE_IDENTITY):
                    hits.append({"path": path, "kind": "pattern-" + str(index)})

            if path == EXPECTED_DEVICE_IDENTITY and size > 4 * 1024 * 1024:
                hits.append({
                    "path": path,
                    "kind": "oversized-runtime-device-identity",
                })

            if path.endswith(".json") and size <= 4 * 1024 * 1024:
                try:
                    with open(path, "rb") as handle:
                        raw = handle.read()
                    parsed = json.loads(raw.decode("utf-8"))
                    if path == EXPECTED_DEVICE_IDENTITY:
                        if validate_device_identity(path, file_stat, raw, parsed):
                            expected.append({
                                "path": path,
                                "kind": "expected-runtime-device-private-key",
                                "jsonKey": "privateKeyPem",
                                "mode": "0600",
                                "privateKeyBlocks": 1,
                            })
                        else:
                            hits.append({
                                "path": path,
                                "kind": "invalid-runtime-device-identity",
                            })
                    inspect_json(parsed, path, [], hits)
                except (OSError, UnicodeError, json.JSONDecodeError):
                    if path == EXPECTED_DEVICE_IDENTITY:
                        hits.append({
                            "path": path,
                            "kind": "unreadable-runtime-device-identity",
                        })

print(json.dumps({
    "volumes": summary,
    "hits": hits,
    "expectedRuntimeCredentials": expected,
    "scannerSelfTests": "PASS",
}, sort_keys=True))
if hits:
    raise SystemExit(41)
PY

node - "$VOLUME_SCAN" <<'NODE'
const fs = require('fs');
const assert = require('node:assert/strict');
const scan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(scan.scannerSelfTests, 'PASS');
if (!Array.isArray(scan.hits) || scan.hits.length !== 0) {
  throw new Error('volume secret hits');
}
const expectedCredential = {
  path: '/root/.openclaw/identity/device.json',
  kind: 'expected-runtime-device-private-key',
  jsonKey: 'privateKeyPem',
  mode: '0600',
  privateKeyBlocks: 1,
};
if (
  !Array.isArray(scan.expectedRuntimeCredentials)
  || scan.expectedRuntimeCredentials.length !== 1
) {
  throw new Error('unexpected runtime credential inventory');
}
assert.deepEqual(scan.expectedRuntimeCredentials[0], expectedCredential);
console.log('expected_runtime_credentials=' + scan.expectedRuntimeCredentials.length);
for (const [root, value] of Object.entries(scan.volumes)) {
  if (!Number.isInteger(value.files) || !Number.isInteger(value.bytes)) {
    throw new Error('invalid volume summary for ' + root);
  }
  console.log('volume=' + root + ' files=' + value.files + ' bytes=' + value.bytes);
}
NODE

for evidence in "$LOG" "$INSPECT" "$TOP" "$CONTAINER_LOG" "$BODY" "$VOLUME_SCAN" "$CID_FILE"; do
  if rg -a -q \
    -e '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' \
    -e '-----BEGIN CERTIFICATE-----' \
    -e 'rca_[A-Za-z0-9_-]{43,}' \
    -e 'RC_TEST_ONLY_FAKE_' \
    -e 'RC_FAKE_PEM' \
    -e 'sk-(proj-)?[A-Za-z0-9_-]{20,}' \
    -e 'ghp_[A-Za-z0-9]{36}' \
    -e 'AKIA[0-9A-Z]{16}' \
    "$evidence"; then
    echo "host_evidence_secret_hit=$(basename "$evidence")"
    exit 42
  fi
done

echo "container_arch=$MACHINE"
echo "node_arch=$NODE_ARCH"
echo "rc_version=$VERSION"
echo "openclaw_version=$OPENCLAW_VERSION"
echo "installer_sha256=$INSTALLER_SHA"
echo 'prohibited_secret_hits=0'
test "$(shasum -a 256 "$0" | awk '{print $1}')" = "$RUNNER_SHA_START"
