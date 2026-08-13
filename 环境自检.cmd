@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist node-runtime\node.exe (set NODE=node-runtime\node.exe) else (set NODE=node)
"%NODE%" scripts\diagnose-local-env.mjs
echo.
pause
