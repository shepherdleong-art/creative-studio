@echo off
setlocal
cd /d "%~dp0"
start "" "%~dp0launcher.html"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo 启动失败，退出码: %EXITCODE%
) else (
  echo 服务已停止。
)
echo 按任意键关闭此窗口...
pause >nul
exit /b %EXITCODE%
