@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 林视 - 本地预览
set "PREVIEW_NODE=node"
if exist "%~dp0node-runtime\node.exe" set "PREVIEW_NODE=%~dp0node-runtime\node.exe"
"%PREVIEW_NODE%" "%~dp0scripts\local-preview.mjs" %*
if errorlevel 1 pause
endlocal
