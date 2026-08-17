Wentor Windows Native full-chain probe
=======================================

Purpose
-------
This package diagnoses the complete native Windows installation chain before
another Research-Claw installer is issued. It does not reinstall Research-Claw.

Run
---
1. Extract the whole folder.
2. Double-click Run-Wentor-Probe.cmd.
3. Keep the window open. The real package and isolated test stages may take
   10-20 minutes.
4. When Explorer opens, send the newest matching TXT and JSON report files to
   Wentor. Do not send other files from the machine.

Coverage
--------
- Native Windows/x64, Node/npm/pnpm, Git Bash and tar
- Disk capacity, task-root ACL, optional WinGet and ffmpeg availability
- GitHub, Gitee and npm registry reachability
- Installed Research-Claw HEAD and build/runtime readiness
- Windows paths containing spaces and Unicode
- fsync, atomic replacement, hardlink publication and Profile storage helpers
- The exact drive-letter tar command that failed in v12
- A drive-safe tar command, followed by real package dependency installation
- Real research-plugins validation and atomic swap in an isolated fake home
- Isolated plugin/Profile lifecycle, publication, recovery and storage tests
- Gateway port and process command-line secret-shape observations

Safety boundary
---------------
- No setup token is requested or read.
- No model API key is requested or read.
- The live Profile and live research-plugins directory are not modified.
- Child processes do not receive secret-shaped values inherited from the
  launching environment.
- Published reports are scanned and refused if they contain a high-confidence
  setup-token, model-key, Bearer-header or private-key shape.
