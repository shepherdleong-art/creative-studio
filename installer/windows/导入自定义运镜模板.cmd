@echo off
chcp 65001 >nul
setlocal
if not exist "%~dp0node-runtime\node.exe" (
  echo 请把补充包全部内容解压到 0.6.2 工作台目录，与 start-windows.cmd 放在同一层。
  pause
  exit /b 1
)
"%~dp0node-runtime\node.exe" "%~dp0scripts\import-motion-template-presets.mjs" --root "%~dp0."
set "importResult=%errorlevel%"
echo.
pause
exit /b %importResult%
