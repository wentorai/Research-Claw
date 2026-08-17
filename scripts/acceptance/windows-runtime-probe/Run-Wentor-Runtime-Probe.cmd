@echo off
setlocal
title Wentor Windows Post-Install Runtime Probe
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Run-Wentor-Runtime-Probe.ps1"
exit /b %ERRORLEVEL%
