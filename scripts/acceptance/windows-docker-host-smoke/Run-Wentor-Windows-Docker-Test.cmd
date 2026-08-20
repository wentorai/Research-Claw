@echo off
setlocal DisableDelayedExpansion
title Wentor Windows Docker Desktop Host Smoke
set "RUNNER=%~dp0Test-Wentor-Windows-Docker.ps1"

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%RUNNER%"
set "DESKTOP_EXIT=%ERRORLEVEL%"

where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Native x64 PowerShell 7 was not found.
  set "CORE_EXIT=1"
) else (
  pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%RUNNER%"
  set "CORE_EXIT=%ERRORLEVEL%"
)

start "" explorer.exe "%LOCALAPPDATA%\Wentor\ProbeReports"
if not "%DESKTOP_EXIT%"=="0" exit /b 1
if not "%CORE_EXIT%"=="0" exit /b 1
exit /b 0
