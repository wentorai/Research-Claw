Wentor Windows post-install runtime probe v2

This directory is the release template. The delivered ZIP replaces the
EXPECTED_HEAD placeholder with the exact candidate commit and regenerates its
SHA256SUMS file. Do not send this source-template directory directly.

Purpose
- Diagnose a Research-Claw installation that printed Ready but whose Dashboard
  remains at Connecting to gateway.
- Separate HTTP health, WebSocket authentication, config.get response time,
  gateway ticks, process liveness, the gateway process console QuickEdit state,
  Git descendants, and installer timing.

Safety
- This package contains no Setup Token and no model API key.
- It reads the installed gateway token only in memory to perform the same local
  authenticated handshake as the Dashboard. The token and returned config are
  never written to a report.
- It does not change the installed Profile, config, database, Skills, or gateway.
- The process helper reads only process ID, parent process ID, and executable
  name. It never reads any process command line or environment value.
- It never reads keyboard input. Closing the report folder is the only operator
  action after the probe has ended.

Run
1. Keep the Research-Claw gateway window open in its stuck state.
2. Double-click Run-Wentor-Runtime-Probe.cmd.
3. Wait about two minutes without pressing Enter or clicking inside the gateway
   console window.
4. Send the newest Wentor-Runtime-Probe TXT and JSON files from the folder that
   opens automatically.

The probe may report FAIL. That means diagnostic capture succeeded and found a
runtime failure; it does not mean that the probe damaged the installation.
