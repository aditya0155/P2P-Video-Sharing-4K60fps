@echo off
setlocal
title Rydius Stream Host
color 0B
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_host.ps1"
set "hostExitCode=%ERRORLEVEL%"
echo.
if not "%hostExitCode%"=="0" echo Host stopped with exit code %hostExitCode%.
pause
exit /b %hostExitCode%
