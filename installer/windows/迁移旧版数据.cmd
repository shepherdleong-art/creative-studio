@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\migrate-portable-data.ps1" -NewRoot "%~dp0." %*
set EXITCODE=%ERRORLEVEL%
echo.
echo 按任意键关闭此窗口...
pause >nul
exit /b %EXITCODE%
