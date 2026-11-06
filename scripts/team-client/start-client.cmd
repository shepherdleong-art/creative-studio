@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0runtime\electron.exe" "%~dp0launcher.mjs" --root "%~dp0."
set "LAUNCH_EXIT=%ERRORLEVEL%"
if not "%LAUNCH_EXIT%"=="0" (
  echo Client startup failed. Please keep the error message above.
  pause
)
exit /b %LAUNCH_EXIT%
