Wentor Windows offline FFmpeg acceptance
=========================================

Purpose
-------
This package installs the exact FFmpeg 9.0.1 Windows x64 runtime planned for
the final Wentor offline installer, then verifies ffmpeg.exe, ffprobe.exe and
an isolated WAV encode/probe round-trip. It does not read a Setup Token or model API key.
It does not install or start Research-Claw.

Safety
------
- No WSL2, Docker Desktop, administrator elevation, restart or network is used.
- No keyboard input is requested.
- Only a Wentor-owned user runtime under LOCALAPPDATA is published.
- An existing exact runtime is reused. An existing mismatched runtime makes the
  test fail closed and is never removed automatically.

Run
---
1. Extract the entire folder.
2. Double-click Run-Wentor-Ffmpeg-Test.cmd.
3. Do not press Enter. The runner executes once in Windows PowerShell 5.1 and
   once in native x64 PowerShell 7.
4. Send the newest Wentor-FFmpeg-Test-Desktop5 and Core7 TXT+JSON reports from
   the Explorer window that opens.
5. If either shell fails before the normal report pair is created, the package
   opens the corresponding Wentor-FFmpeg-Bootstrap log in Notepad and keeps the
   CMD window visible for five minutes. No key is required to advance the test.

Pass contract
-------------
Both reports must say status=PASSED. The first run may report
installed-new-exact-runtime; the second must report reused-exact-runtime.
