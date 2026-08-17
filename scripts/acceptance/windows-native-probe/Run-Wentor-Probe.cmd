@echo off
setlocal
chcp 65001 >nul 2>&1
title Wentor Windows Native Full-Chain Probe
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Run-Wentor-Probe.ps1"
set "PROBE_EXIT=%ERRORLEVEL%"
echo.
if "%PROBE_EXIT%"=="0" (
  echo Probe completed. Please send the newest TXT and JSON reports to Wentor.
) else (
  echo Probe did not complete. Exit code: %PROBE_EXIT%
)
echo.
pause
exit /b %PROBE_EXIT%
