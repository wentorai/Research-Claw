@echo off
setlocal DisableDelayedExpansion
title Wentor Windows Offline FFmpeg Acceptance
set "RUNNER=%~dp0Install-Test-Wentor-Ffmpeg.ps1"
set "BOOTSTRAP=%~dp0Invoke-Wentor-Ffmpeg-Test.ps1"
set "REPORT_ROOT=%LOCALAPPDATA%\Wentor\ProbeReports"
if not exist "%REPORT_ROOT%" mkdir "%REPORT_ROOT%" >nul 2>nul
if not exist "%REPORT_ROOT%" goto REPORT_ROOT_FAILED
set "RUN_ID=%RANDOM%-%RANDOM%-%RANDOM%"
set "DESKTOP_LOG=%REPORT_ROOT%\Wentor-FFmpeg-Bootstrap-Desktop5-%RUN_ID%.log"
set "CORE_LOG=%REPORT_ROOT%\Wentor-FFmpeg-Bootstrap-Core7-%RUN_ID%.log"

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -EditionLabel Desktop5 -RunnerPath "%RUNNER%" -LogPath "%DESKTOP_LOG%"
set "DESKTOP_EXIT=%ERRORLEVEL%"

where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Native x64 PowerShell 7 was not found.
  >"%CORE_LOG%" echo Wentor FFmpeg bootstrap
  >>"%CORE_LOG%" echo edition=Core7
  >>"%CORE_LOG%" echo status=FAILED
  >>"%CORE_LOG%" echo failure=Native x64 PowerShell 7 was not found.
  set "CORE_EXIT=1"
) else (
  pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -EditionLabel Core7 -RunnerPath "%RUNNER%" -LogPath "%CORE_LOG%"
  set "CORE_EXIT=%ERRORLEVEL%"
)

start "" explorer.exe "%LOCALAPPDATA%\Wentor\ProbeReports"
if not "%DESKTOP_EXIT%"=="0" goto ACCEPTANCE_FAILED
if not "%CORE_EXIT%"=="0" goto ACCEPTANCE_FAILED
exit /b 0

:REPORT_ROOT_FAILED
echo [FAIL] Could not create the Wentor probe report directory.
echo This window will remain visible for five minutes.
timeout.exe /t 300 /nobreak
exit /b 1

:ACCEPTANCE_FAILED
echo.
echo [FAIL] FFmpeg acceptance did not complete.
echo Desktop log: %DESKTOP_LOG%
echo Core log:    %CORE_LOG%
if exist "%DESKTOP_LOG%" start "" notepad.exe "%DESKTOP_LOG%"
if exist "%CORE_LOG%" start "" notepad.exe "%CORE_LOG%"
echo This window will remain visible for five minutes; no key is required.
timeout.exe /t 300 /nobreak
exit /b 1
