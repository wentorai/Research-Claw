@echo off
setlocal
title Wentor v20 Model Classifier Probe
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Run-Wentor-Model-Classifier-Probe.ps1"
set "PROBE_EXIT=%ERRORLEVEL%"
echo.
if "%PROBE_EXIT%"=="0" (
  echo Diagnostic capture completed. The report folder has been opened.
) else (
  echo Diagnostic capture did not complete. Exit code: %PROBE_EXIT%
)
exit /b %PROBE_EXIT%
