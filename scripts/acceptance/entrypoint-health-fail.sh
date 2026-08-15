#!/bin/sh
# Windows T10 rollback fixture: stay alive while deliberately never starting
# the Gateway or any other health endpoint. Docker stop reaches PID 1 here;
# TERM/INT terminate cleanly without reading or writing credentials.

set -eu
trap 'exit 0' TERM INT

while :; do
  sleep 3600 &
  wait "$!" || true
done
