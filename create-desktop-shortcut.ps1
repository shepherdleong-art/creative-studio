﻿﻿$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path $ScriptDir).Path
$launcherPath = Join-Path $Root 'launcher.vbs'

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop '批量图片编辑工作台.lnk'

Write-Host '========================================'
Write-Host '  创建桌面快捷方式'
Write-Host '========================================'
Write-Host ''
Write-Host "项目路径: $Root"
Write-Host "启动器: $launcherPath"
Write-Host ''

# Create .lnk shortcut using COM
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = 'wscript.exe'
$Shortcut.Arguments = "`"$launcherPath`""
$Shortcut.WorkingDirectory = $Root
$Shortcut.WindowStyle = 7  # Minimized
$Shortcut.IconLocation = "$env:SystemRoot\System32\imageres.dll,15"
$Shortcut.Description = '批量图片编辑工作台 - 一键启动'
$Shortcut.Save()

Write-Host '已创建桌面快捷方式: 批量图片编辑工作台' -ForegroundColor Green
Write-Host ''
Write-Host '以后只需双击桌面上的「批量图片编辑工作台」即可一键启动！'
Write-Host ''
Write-Host '按任意键关闭...'
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
