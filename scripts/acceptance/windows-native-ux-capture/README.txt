Wentor Windows native UX read-only capture
==========================================

Purpose
-------
This small package closes the WUX-T01 evidence gap for an already running
Research-Claw 0.8.3 native Windows installation. It is not an installer.

Run
---
1. Make sure Research-Claw is already running.
2. Extract the complete folder.
3. Double-click Run-Wentor-UX-Capture.cmd.
4. Do not click the console or press Enter. No input is required.
5. The default browser should be dispatched once when the IPv4 Dashboard is
   healthy. The report says only whether Windows accepted that dispatch; it does
   not claim that a visible browser page was proven.
6. Send the newest Wentor-UX-Capture TXT and JSON files from the Explorer window.

Coverage
--------
- Native Windows x64 and Wentor Node 22 ABI 127
- Windows PowerShell 5.1 and PowerShell 7 availability and architecture
- Exact port-28789 listener PID, parent PID, creation time and executable name
- In-memory path relationship checks without publishing a raw command line
- HTTP 200 through 127.0.0.1, localhost and the ASCII IDNA brand alias
- Windows-native Start-Process browser dispatch acceptance
- Installed source commit, dirty-entry count and shared-script SHA-256 values

Safety
------
- The capture does not install, update, start, stop, kill or reconfigure RC/OC.
- It does not read live configuration, a setup token or a model API key.
- It never publishes a raw process command line or absolute user path.
- Reports are refused if a high-confidence private-value shape is detected.
- Listener identity is observation only and never authorizes process shutdown.
