@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0runtime\electron.exe" "%~dp0launcher.mjs" --root "%~dp0."
exit /b %ERRORLEVEL%
