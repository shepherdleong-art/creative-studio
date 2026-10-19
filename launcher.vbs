' 批量图片编辑工作台 - 静默启动器
' 双击后：后台启动服务 + 打开启动页，全程无命令行窗口

Dim Root, Launcher, Ps1, WshShell

' Get script directory
Set fso = CreateObject("Scripting.FileSystemObject")
Root = fso.GetParentFolderName(WScript.ScriptFullName)
Launcher = Root & "\launcher.html"
Ps1 = Root & "\scripts\start-windows.ps1"

Set WshShell = CreateObject("WScript.Shell")

' Launch PowerShell in hidden window to start the server
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & Ps1 & """", 0, False

' Open launcher page in default browser
WshShell.Run """" & Launcher & """", 1, False
