@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-windows.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
echo 按任意键关闭此窗口...
pause >nul
exit /b %EXITCODE%
