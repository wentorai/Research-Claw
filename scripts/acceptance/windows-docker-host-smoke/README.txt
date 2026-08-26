Wentor Windows Docker Desktop host smoke
========================================

Purpose
-------
This package validates native Windows x64, Administrator rights, Windows
PowerShell 5.1, PowerShell 7, a running Docker Desktop Linux/amd64 engine, and
the exact public Research-Claw 0.8.3 registry digest. It checks real container
health, all four volume mounts, cross-container volume persistence, logs, top
and exact task-owned cleanup.

Safety and scope
----------------
- It does not read a Setup Token or model API key.
- It does not remove an existing container or volume.
- It uses random names and removes only resources bearing its exact owner label.
- It leaves the exact public image in Docker's cache after the test.
- It does not publish a host port and cannot collide with native RC on 28789.
- It does not replace the destructive 11-scenario T10 gate; no Profile is
  redeemed or applied in this smoke.

Prerequisites
-------------
- Native Windows x64 administrator account
- Docker Desktop installed and already running in Linux container mode
- Windows PowerShell 5.1 and native x64 PowerShell 7
- Internet access to ACR or GHCR for the first exact image pull

Run
---
1. Extract the complete folder.
2. Start Docker Desktop and wait until its engine says Running.
3. Right-click Run-Wentor-Windows-Docker-Test.cmd and choose Run as administrator.
4. Do not press Enter. The first image pull may take several minutes.
5. Send the newest Wentor-Docker-Test-Desktop5 and Core7 TXT+JSON reports from
   the Explorer window that opens.

Pass contract
-------------
Both reports must say status=PASSED and cleanupPassed=true.
