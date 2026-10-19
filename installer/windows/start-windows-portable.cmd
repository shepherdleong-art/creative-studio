cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-desktop-windows.ps1" -Portable %*
exit /b %ERRORLEVEL%
