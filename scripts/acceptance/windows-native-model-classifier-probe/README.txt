Wentor v20 model classifier probe
=================================

Purpose
-------
This diagnostic classifies the final model-access failure reported by the v20
Windows installer. It does not install, update, repair, or commit a Profile.

Run
---
1. Extract the complete folder.
2. Double-click Run-Wentor-Model-Classifier-Probe.cmd.
3. Wait for the report folder to open. No keyboard input is required.
4. Send Wentor the newest matching TXT and JSON reports only.

Safety
------
- No Setup Token is read.
- The existing managed model credential is read only by the production helper
  and copied only into its private, short-lived scratch directory.
- Reports contain only stable status constants, timings, runtime versions, and
  cleanup results. Raw provider errors, credentials, and model responses are
  never written to reports or the console.
- The installed Research-Claw source and live Profile files are not modified.
