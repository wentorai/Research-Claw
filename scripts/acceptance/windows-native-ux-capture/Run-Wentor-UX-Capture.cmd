@echo off
setlocal DisableDelayedExpansion
title Wentor Windows Native UX Read-Only Capture
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0Run-Wentor-UX-Capture.ps1"
set "CAPTURE_EXIT=%ERRORLEVEL%"
echo.
if "%CAPTURE_EXIT%"=="0" (
  echo UX capture completed. Send the newest TXT and JSON reports to Wentor.
) else (
  echo UX capture did not pass. Exit code: %CAPTURE_EXIT%
  echo Send the newest sanitized TXT and JSON reports to Wentor.
)
exit /b %CAPTURE_EXIT%
