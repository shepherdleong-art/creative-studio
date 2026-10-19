@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-desktop-windows.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo 启动失败，退出码: %EXITCODE%
) else (
  echo 桌面版已退出。
)
echo 按任意键关闭此窗口...
pause >nul
exit /b %EXITCODE%
