#!/usr/bin/env bash
set -euo pipefail

: "${RC_T10_REAL_GIT:?RC_T10_REAL_GIT is required}"
: "${RC_T10_REPO:?RC_T10_REPO is required}"
: "${RC_T10_TASK_ROOT:?RC_T10_TASK_ROOT is required}"
: "${RC_T10_TASK_ROOT_ID:?RC_T10_TASK_ROOT_ID is required}"
: "${RC_T10_SOURCE:?RC_T10_SOURCE is required}"
: "${RC_T10_INSTALL_ROOT:?RC_T10_INSTALL_ROOT is required}"
: "${RC_T10_EVENT_DIR:?RC_T10_EVENT_DIR is required}"
: "${RC_T10_EVENT_DIR_ID:?RC_T10_EVENT_DIR_ID is required}"
: "${RC_T10_INSTALLER_SHA:?RC_T10_INSTALLER_SHA is required}"
: "${RC_T10_PPT_SOURCE:?RC_T10_PPT_SOURCE is required}"
: "${RC_T10_PPT_COMMIT:?RC_T10_PPT_COMMIT is required}"

readonly RC_T10_APPROVED_PPT_COMMIT=8ac18bb381a7c62802316354266f558b3ccae1f7

fail() {
  printf 'macOS Native acceptance git wrapper: %s\n' "$1" >&2
  exit 70
}

canonical_dir() {
  (cd -P -- "$1" && pwd -P)
}

assert_owned_dir() {
  local path="$1" expected="$2" canonical owner
  [ -d "$path" ] || fail "expected directory is missing"
  [ ! -L "$path" ] || fail "refusing a symlink directory"
  canonical="$(canonical_dir "$path")" || fail "could not resolve directory"
  [ "$canonical" = "$expected" ] || fail "directory identity mismatch"
  owner="$(stat -f '%u' "$canonical")" || fail "could not read directory owner"
  [ "$owner" = "$(id -u)" ] || fail "directory owner mismatch"
}

task_root="$(canonical_dir "$RC_T10_TASK_ROOT")" \
  || fail "could not resolve task root"
[ "$task_root" = "$RC_T10_TASK_ROOT" ] || fail "task root must be canonical"
assert_owned_dir "$task_root" "$task_root"
[ "$(stat -f '%Lp' "$task_root")" = 700 ] || fail "task root must be mode 0700"
[ "$(stat -f '%d:%i' "$task_root")" = "$RC_T10_TASK_ROOT_ID" ] \
  || fail "task root identity mismatch"

source_root="$(canonical_dir "$RC_T10_SOURCE")" \
  || fail "could not resolve frozen source"
event_root="$(canonical_dir "$RC_T10_EVENT_DIR")" \
  || fail "could not resolve event directory"
install_root="$task_root/install"
[ "$RC_T10_INSTALL_ROOT" = "$install_root" ] || fail "install root is outside task root"
assert_owned_dir "$source_root" "$task_root/candidate-source"
assert_owned_dir "$event_root" "$event_root"
[ "$(canonical_dir "$(dirname "$event_root")")" = "$task_root" ] \
  || fail "event directory is outside task root"
case "$(basename "$event_root")" in
  events-[a-z0-9-]*) ;;
  *) fail "event directory name is invalid" ;;
esac
[ "$(stat -f '%Lp' "$event_root")" = 700 ] || fail "event directory must be mode 0700"
[ "$(stat -f '%d:%i' "$event_root")" = "$RC_T10_EVENT_DIR_ID" ] \
  || fail "event directory identity mismatch"
[ ! -e "$source_root/config/openclaw.json" ] || fail "frozen source contains live config"
[ ! -e "$source_root/workspace/AGENTS.md" ] || fail "frozen source contains live workspace data"
[ ! -e "$source_root/workspace/IDENTITY.md" ] || fail "frozen source contains live workspace data"
[ ! -e "$source_root/test/fixtures/bootstrap-profile-e2e-provider.key.pem" ] \
  || fail "frozen source contains a private-key fixture"
[ ! -e "$source_root/scripts/acceptance" ] || fail "frozen source contains acceptance helpers"
[ "$(shasum -a 256 "$source_root/scripts/install.sh" | awk '{print $1}')" = "$RC_T10_INSTALLER_SHA" ] \
  || fail "frozen installer SHA mismatch"
ppt_source="$(canonical_dir "$RC_T10_PPT_SOURCE")" \
  || fail "could not resolve ppt-master source"
assert_owned_dir "$ppt_source" "$ppt_source"
[ "$RC_T10_PPT_COMMIT" = "$RC_T10_APPROVED_PPT_COMMIT" ] \
  || fail "ppt-master commit is not the approved gitlink"
read -r ppt_mode ppt_type ppt_gitlink ppt_path <<EOF
$("$RC_T10_REAL_GIT" -C "$RC_T10_REPO" ls-tree HEAD -- ppt-master)
EOF
[ "$ppt_mode" = 160000 ] && [ "$ppt_type" = commit ] \
  && [ "$ppt_gitlink" = "$RC_T10_APPROVED_PPT_COMMIT" ] \
  && [ "$ppt_path" = ppt-master ] \
  || fail "main tree ppt-master gitlink mismatch"
[ "$("$RC_T10_REAL_GIT" -C "$ppt_source" rev-parse "$RC_T10_APPROVED_PPT_COMMIT^{commit}")" = "$RC_T10_APPROVED_PPT_COMMIT" ] \
  || fail "approved ppt-master commit is unavailable"

assert_install_identity() {
  assert_owned_dir "$RC_T10_INSTALL_ROOT" "$install_root"
  [ -d "$install_root/.git" ] || fail "install root is not a Git worktree"
  [ -f "$install_root/.git/rc-t10-acceptance-owner" ] \
    || fail "install root lacks the gate-owned sentinel"
}

overlay_candidate() {
  local event="$1" remaining
  assert_install_identity
  /usr/bin/rsync -a --checksum --omit-dir-times \
    --exclude '.git/' \
    --exclude '.tools/' \
    --exclude 'node_modules/' \
    --exclude 'dist/' \
    --exclude 'dashboard/dist/' \
    --exclude 'extensions/*/dist/' \
    --exclude 'ppt-master/' \
    --exclude '.research-claw/' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude 'config/openclaw.json' \
    --exclude 'workspace/AGENTS.md' \
    --exclude 'workspace/IDENTITY.md' \
    --exclude 'workspace/MEMORY.md' \
    --exclude 'workspace/USER.md' \
    --exclude 'workspace/.ResearchClaw/SOUL.md' \
    --exclude 'workspace/.ResearchClaw/TOOLS.md' \
    --exclude 'workspace/.ResearchClaw/USER.md' \
    --exclude 'workspace/.ResearchClaw/BOOTSTRAP.md.done' \
    "$source_root/" "$install_root/"
  remaining="$(/usr/bin/rsync -aicn --checksum --omit-dir-times \
    --exclude '.git/' \
    --exclude '.tools/' \
    --exclude 'node_modules/' \
    --exclude 'dist/' \
    --exclude 'dashboard/dist/' \
    --exclude 'extensions/*/dist/' \
    --exclude 'ppt-master/' \
    --exclude '.research-claw/' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude 'config/openclaw.json' \
    --exclude 'workspace/AGENTS.md' \
    --exclude 'workspace/IDENTITY.md' \
    --exclude 'workspace/MEMORY.md' \
    --exclude 'workspace/USER.md' \
    --exclude 'workspace/.ResearchClaw/SOUL.md' \
    --exclude 'workspace/.ResearchClaw/TOOLS.md' \
    --exclude 'workspace/.ResearchClaw/USER.md' \
    --exclude 'workspace/.ResearchClaw/BOOTSTRAP.md.done' \
    "$source_root/" "$install_root/")" || fail "overlay verification failed"
  [ -z "$remaining" ] || fail "overlay is not byte-exact"
  [ "$(shasum -a 256 "$install_root/scripts/install.sh" | awk '{print $1}')" = "$RC_T10_INSTALLER_SHA" ] \
    || fail "installed overlay SHA mismatch"
  touch "$event_root/$event"
}

seed_ppt_runtime() {
  local archive_root="$event_root/ppt-runtime-archive"
  local archive_source="$archive_root/skills/ppt-master"
  local target="$install_root/ppt-master/skills/ppt-master" remaining
  assert_install_identity
  [ ! -e "$archive_root" ] || fail "ppt-master archive root already exists"
  mkdir -m 700 "$archive_root"
  "$RC_T10_REAL_GIT" -C "$ppt_source" archive --format=tar \
    "$RC_T10_APPROVED_PPT_COMMIT" -- skills/ppt-master \
    | /usr/bin/tar -xf - -C "$archive_root" \
    || fail "could not materialize the approved ppt-master runtime"
  [ -f "$archive_source/scripts/project_manager.py" ] \
    || fail "materialized ppt-master runtime is incomplete"
  [ -f "$archive_source/scripts/svg_to_pptx.py" ] \
    || fail "materialized ppt-master runtime is incomplete"
  mkdir -p "$target"
  /usr/bin/rsync -a --checksum --omit-dir-times \
    "$archive_source/" "$target/"
  remaining="$(/usr/bin/rsync -aicn --checksum --omit-dir-times \
    "$archive_source/" "$target/")" \
    || fail "ppt-master runtime verification failed"
  [ -z "$remaining" ] || fail "ppt-master runtime is not byte-exact"
  touch "$event_root/ppt-runtime-seeded"
}

effective_cwd="$(pwd -P)"
args=("$@")
subcommand=""
subcommand_index=-1
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  arg="${args[$i]}"
  case "$arg" in
    -C)
      i=$((i + 1))
      [ "$i" -lt "${#args[@]}" ] || fail "git -C is missing its directory"
      effective_cwd="$(canonical_dir "${args[$i]}")" || fail "git -C directory is invalid"
      ;;
    -c)
      i=$((i + 1))
      [ "$i" -lt "${#args[@]}" ] || fail "git -c is missing its value"
      ;;
    --*) ;;
    -*) ;;
    *)
      subcommand="$arg"
      subcommand_index="$i"
      break
      ;;
  esac
  i=$((i + 1))
done

managed=false
if [ "$subcommand" = clone ]; then
  positional=()
  i=$((subcommand_index + 1))
  while [ "$i" -lt "${#args[@]}" ]; do
    arg="${args[$i]}"
    case "$arg" in
      --depth|-b|--branch)
        i=$((i + 1))
        [ "$i" -lt "${#args[@]}" ] || fail "clone option is missing its value"
        ;;
      --*) ;;
      -*) ;;
      *) positional+=("$arg") ;;
    esac
    i=$((i + 1))
  done
  if [ "${#positional[@]}" -eq 2 ] \
      && [ "${positional[0]}" = "$RC_T10_REPO" ] \
      && [ "${positional[1]}" = "$install_root" ]; then
    [ ! -e "$install_root" ] || fail "fresh install root already exists"
    managed=true
  fi
elif [ "$subcommand" = reset ] || [ "$subcommand" = clean ] || [ "$subcommand" = pull ]; then
  if [ "$effective_cwd" = "$install_root" ]; then
    assert_install_identity
    managed=true
  fi
fi

if [ "$managed" != true ]; then
  exec "$RC_T10_REAL_GIT" "$@"
fi

if [ "$subcommand" = pull ] && [ "${RC_T10_BLOCK_BEFORE_PULL:-0}" = 1 ]; then
  [ -f "$event_root/reset-overlay-complete" ] \
    || fail "pull block reached before reset overlay"
  [ -f "$event_root/clean-overlay-complete" ] \
    || fail "pull block reached before clean overlay"
  trap 'exit 130' INT TERM HUP
  touch "$event_root/pull-ready"
  deadline=$((SECONDS + ${RC_T10_BLOCK_DEADLINE_SECONDS:-45}))
  while [ "$SECONDS" -lt "$deadline" ] && [ ! -f "$event_root/pull-release" ]; do
    sleep 1
  done
  [ -f "$event_root/pull-release" ] || fail "pull block reached its deadline"
  trap - INT TERM HUP
fi

"$RC_T10_REAL_GIT" "$@"

case "$subcommand" in
  clone)
    touch "$install_root/.git/rc-t10-acceptance-owner"
    overlay_candidate clone-overlay-complete
    seed_ppt_runtime
    ;;
  reset) overlay_candidate reset-overlay-complete ;;
  clean) overlay_candidate clean-overlay-complete ;;
  pull) overlay_candidate pull-overlay-complete ;;
esac
