#!/usr/bin/env bash

# Atomic single-owner lock for scripts/run.sh.
#
# A second launcher must never terminate the active owner. The lock directory
# is created atomically; only a confirmed stale lock may be reclaimed.

RC_RUN_LOCK_DIR="${RC_RUN_LOCK_DIR:-${TMPDIR:-/tmp}/research-claw-gateway.lock}"
RC_RUN_LOCK_OWNER_PID=""

acquire_run_lock() {
  local attempts=0 owner_pid=""

  while [ "$attempts" -lt 2 ]; do
    if mkdir "$RC_RUN_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" >"$RC_RUN_LOCK_DIR/pid"
      RC_RUN_LOCK_OWNER_PID="$$"
      return 0
    fi

    owner_pid=$(cat "$RC_RUN_LOCK_DIR/pid" 2>/dev/null || true)
    if [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; then
      printf '[run] Research-Claw is already running (PID %s). Use the existing Dashboard or stop that process first.\n' "$owner_pid" >&2
      return 73
    fi

    # The owner is gone (or the lock is malformed). Remove only the known lock
    # file and empty lock directory, then retry the atomic mkdir once.
    rm -f "$RC_RUN_LOCK_DIR/pid" 2>/dev/null || true
    if ! rmdir "$RC_RUN_LOCK_DIR" 2>/dev/null; then
      printf '[run] Cannot reclaim stale run lock: %s\n' "$RC_RUN_LOCK_DIR" >&2
      return 74
    fi
    attempts=$((attempts + 1))
  done

  return 74
}

release_run_lock() {
  local owner_pid=""
  [ "$RC_RUN_LOCK_OWNER_PID" = "$$" ] || return 0

  owner_pid=$(cat "$RC_RUN_LOCK_DIR/pid" 2>/dev/null || true)
  if [ "$owner_pid" = "$$" ]; then
    rm -f "$RC_RUN_LOCK_DIR/pid" 2>/dev/null || true
    rmdir "$RC_RUN_LOCK_DIR" 2>/dev/null || true
  fi
  RC_RUN_LOCK_OWNER_PID=""
}
