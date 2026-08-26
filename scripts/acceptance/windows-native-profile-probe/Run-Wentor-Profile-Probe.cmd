@echo off
setlocal
title Wentor Windows Profile Phase Probe
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Run-Wentor-Profile-Probe.ps1"
set "PROBE_EXIT=%ERRORLEVEL%"
echo.
if "%PROBE_EXIT%"=="0" (
  echo Probe process completed. Send the newest TXT and JSON reports to Wentor.
) else (
  echo Probe process did not complete. Exit code: %PROBE_EXIT%
)
echo The probe process has ended. Press any key only to close this window.
pause >nul
exit /b %PROBE_EXIT%
