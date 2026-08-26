Wentor Windows native UX read-only capture
==========================================

Purpose
-------
This small package closes the WUX-T01 evidence gap for an already running
Research-Claw 0.8.3 native Windows installation at the frozen production
baseline commit 5015be7a72387098f122cb3e7cc4aae32714d4fa. It is not an
installer. A different commit or shared-script tuple is reported as FAIL.

Run
---
1. Make sure Research-Claw is already running.
2. Make sure both Windows PowerShell 5.1 and native x64 PowerShell 7 are
   installed. The capture is read-only and will not install PowerShell 7.
3. Extract the complete folder.
4. Double-click Run-Wentor-UX-Capture.cmd.
5. Do not click the console or press Enter. No input is required.
6. The default browser should be dispatched once when the IPv4 Dashboard is
   healthy. The report says only whether Windows accepted that dispatch; it does
   not claim that a visible browser page was proven.
7. Send the newest Wentor-UX-Capture TXT and JSON files from the Explorer window.

Coverage
--------
- Native Windows x64 and Wentor Node 22 ABI 127
- Windows PowerShell 5.1 and PowerShell 7 availability and architecture
- Exact port-28789 listener PID, parent PID, creation time and executable name
- In-memory path relationship checks without publishing a raw command line
- HTTP 200 through 127.0.0.1 and localhost
- The ASCII IDNA brand alias loaded by a real Edge/Chrome headless process with
  an isolated, task-owned browser profile (Node/Windows DNS is not treated as
  browser authority)
- Windows-native Start-Process browser dispatch acceptance
- Installed source commit, dirty-entry count and shared-script SHA-256 values

Safety
------
- The capture does not install, update, start, stop, kill or reconfigure RC/OC.
- It does not read live configuration, a setup token or a model API key.
- It never publishes a raw process command line or absolute user path.
- It removes only the exact isolated browser profile directory it creates.
- Reports are refused if a high-confidence private-value shape is detected.
- Listener identity is observation only and never authorizes process shutdown.
