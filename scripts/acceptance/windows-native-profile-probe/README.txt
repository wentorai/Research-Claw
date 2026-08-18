Wentor Windows Profile phase probe v3
=====================================

Purpose
-------
This package verifies the candidate fix for the Windows fsync EPERM returned
after Research-plugins installation. It does not reinstall Research-Claw and
does not repair or patch the live Profile.

Run
---
1. Extract the complete folder to a new directory.
2. Double-click Run-Wentor-Profile-Probe.cmd.
3. Wait until Explorer opens. Keyboard input is never required while probing.
4. Send Wentor the newest matching TXT and JSON reports only.

Safety
------
- No setup token or real model API key is read.
- The live installation is accessed only through the read-only Profile status API.
- The packaged maintenance candidate is loaded only inside probe worker memory.
  No installed Research-Claw source file is overwritten.
- initialize-locks, recover, stage, apply, verify and rollback run only in a
  private isolated root with the repository's RC_TEST_ONLY fixture.
- User-owned surfaces must return byte-for-byte to their pre-stage state.
  Reserved transaction-control roots may remain only when they are empty;
  any file, link, unreadable root or other residue is a hard failure.
- Every child stdin is closed, so Enter cannot advance a phase.
- Reports contain phase, stable error code, syscall class and relative path
  class. They never contain error messages, Capsule bytes or secret values.
