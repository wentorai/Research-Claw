#!/usr/bin/env bash
set -u

install_root="$1"
failed=0
backup_root=""

path_identity() {
  local value
  if value="$(stat -f '%d:%i' "$1" 2>/dev/null)"; then
    printf '%s\n' "$value"
    return 0
  fi
  stat -c '%d:%i' "$1" 2>/dev/null
}

path_owner() {
  local value
  if value="$(stat -f '%u' "$1" 2>/dev/null)"; then
    printf '%s\n' "$value"
    return 0
  fi
  stat -c '%u' "$1" 2>/dev/null
}

path_mode() {
  local value
  if value="$(stat -f '%Lp' "$1" 2>/dev/null)"; then
    printf '%s\n' "$value"
    return 0
  fi
  stat -c '%a' "$1" 2>/dev/null
}

classify_error() {
  local file="$1"
  if [ ! -s "$file" ]; then printf 'none';
  elif grep -Eqi 'permission denied|operation not permitted|access is denied' "$file"; then printf 'permission';
  elif grep -Eqi 'resource busy|being used|sharing violation|device or resource busy' "$file"; then printf 'busy';
  elif grep -Eqi 'no such file|cannot stat' "$file"; then printf 'missing';
  else printf 'other'; fi
}

printf 'bash_uid=%s\n' "$(id -u)"
printf 'bash_umask=%s\n' "$(umask)"

backup_root="$(mktemp -d "$TMPDIR/rc-install-user-backup-probe.XXXXXX" 2>/dev/null)"
mktemp_exit=$?
printf 'mktemp_exit=%s\n' "$mktemp_exit"
if [ "$mktemp_exit" -ne 0 ] || [ -z "$backup_root" ]; then exit 1; fi

chmod 700 "$backup_root" 2>"$TMPDIR/root-chmod.stderr"
root_chmod_exit=$?
root_owner="$(path_owner "$backup_root" 2>/dev/null || printf unavailable)"
root_mode="$(path_mode "$backup_root" 2>/dev/null || printf unavailable)"
root_identity_first="$(path_identity "$backup_root" 2>/dev/null || printf unavailable)"
root_identity_second="$(path_identity "$backup_root" 2>/dev/null || printf unavailable)"
printf 'root_chmod_exit=%s\n' "$root_chmod_exit"
printf 'root_owner=%s\n' "$root_owner"
printf 'root_mode=%s\n' "$root_mode"
printf 'root_identity_stable=%s\n' "$([ "$root_identity_first" = "$root_identity_second" ] && printf true || printf false)"
if [ "$root_chmod_exit" -ne 0 ] || [ "$root_owner" != "$(id -u)" ] \
    || [ "$root_mode" != 700 ] || [ "$root_identity_first" != "$root_identity_second" ]; then
  failed=1
fi

probe_item() {
  local key="$1" relative="$2" source
  source="$install_root/$relative"
  local copy="$backup_root/$key.value" type_file="$backup_root/$key.type"
  local stderr_file="$backup_root/$key.stderr" source_type=other type_write_exit=0
  local copy_exit=0 result_type=none type_chmod_exit=0 error_class=none

  if [ -L "$source" ]; then source_type=symlink
  elif [ -f "$source" ]; then source_type=regular
  elif [ ! -e "$source" ]; then source_type=absent
  elif [ -d "$source" ]; then source_type=directory
  fi

  printf '%s\n' "$source_type" >"$type_file" 2>"$stderr_file"
  type_write_exit=$?
  if [ "$type_write_exit" -eq 0 ]; then
    case "$source_type" in
      regular)
        cp -p -- "$source" "$copy" 2>"$stderr_file"; copy_exit=$?
        [ -f "$copy" ] && [ ! -L "$copy" ] && result_type=regular
        ;;
      symlink)
        cp -P -- "$source" "$copy" 2>"$stderr_file"; copy_exit=$?
        [ -L "$copy" ] && result_type=symlink
        ;;
      absent) result_type=absent ;;
      *) copy_exit=97 ;;
    esac
  else
    copy_exit=98
  fi
  chmod 600 "$type_file" 2>>"$stderr_file"; type_chmod_exit=$?
  error_class="$(classify_error "$stderr_file")"
  printf 'item=%s source_type=%s type_write_exit=%s copy_exit=%s result_type=%s type_chmod_exit=%s error_class=%s\n' \
    "$key" "$source_type" "$type_write_exit" "$copy_exit" "$result_type" "$type_chmod_exit" "$error_class"
  if [ "$type_write_exit" -ne 0 ] || [ "$copy_exit" -ne 0 ] \
      || [ "$type_chmod_exit" -ne 0 ] || [ "$result_type" != "$source_type" ]; then
    failed=1
  fi
}

probe_item soul workspace/.ResearchClaw/SOUL.md
probe_item identity workspace/.ResearchClaw/IDENTITY.md
probe_item tools workspace/.ResearchClaw/TOOLS.md
probe_item rc-user workspace/.ResearchClaw/USER.md
probe_item memory workspace/MEMORY.md
probe_item workspace-user workspace/USER.md
probe_item bootstrap-done workspace/.ResearchClaw/BOOTSTRAP.md.done

rm -rf -- "$backup_root" 2>"$TMPDIR/root-remove.stderr"
discard_exit=$?
if [ -e "$backup_root" ] || [ -L "$backup_root" ]; then discard_absent=false; else discard_absent=true; fi
printf 'discard_exit=%s\n' "$discard_exit"
printf 'discard_absent=%s\n' "$discard_absent"
if [ "$discard_exit" -ne 0 ] || [ "$discard_absent" != true ]; then failed=1; fi

exit "$failed"
