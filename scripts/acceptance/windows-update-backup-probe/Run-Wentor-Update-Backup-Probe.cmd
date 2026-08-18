@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Wentor Update Backup Probe
echo Wentor Windows update-backup phase probe
echo This diagnostic does not update Research-Claw or read credentials.
echo No keyboard input is required.
echo.

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0Run-Wentor-Update-Backup-Probe.ps1" -ShellLabel Desktop5
set "RC_DESKTOP=%ERRORLEVEL%"

where pwsh.exe >nul 2>&1
if errorlevel 1 (
  echo [FAIL] PowerShell 7 was not found on PATH.
  set "RC_CORE=1"
) else (
  pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0Run-Wentor-Update-Backup-Probe.ps1" -ShellLabel Core7
  set "RC_CORE=%ERRORLEVEL%"
)

start "" "%LOCALAPPDATA%\Wentor\ProbeReports" >nul 2>&1
if not "%RC_DESKTOP%"=="0" exit /b 1
if not "%RC_CORE%"=="0" exit /b 1
exit /b 0
