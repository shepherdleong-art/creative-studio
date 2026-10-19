@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-desktop-shortcut.ps1"
echo.
echo 按任意键关闭此窗口...
pause >nul
