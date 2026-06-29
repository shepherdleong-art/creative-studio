#define MyAppName "产品素材工作台"
#define MyAppVersion "0.3.0"
#define MyAppPublisher "Creative Studio"
#define MyAppExeName "产品素材工作台"

[Setup]
AppId={{4A3B653E-58ED-4B4E-9489-2772C8B3E3C8}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Creative Studio
DefaultGroupName=产品素材工作台
DisableProgramGroupPage=yes
OutputDir=..\..\dist\windows
OutputBaseFilename=CreativeStudioSetup
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#MyAppName}

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Default.isl"

[Messages]
SetupAppTitle=安装程序
SetupWindowTitle=安装 - %1
UninstallAppTitle=卸载程序
UninstallAppFullTitle=卸载 %1
InformationTitle=信息
ConfirmTitle=确认
ErrorTitle=错误
SetupLdrStartupMessage=即将安装 %1。是否继续？
LdrCannotCreateTemp=无法创建临时文件，安装已中止
LdrCannotExecTemp=无法执行临时目录中的文件，安装已中止
SetupAlreadyRunning=安装程序已经在运行。
WindowsVersionNotSupported=此程序不支持当前 Windows 版本。
OnlyOnTheseArchitectures=此程序只能安装在以下处理器架构的 Windows 上：%n%n%1
AdminPrivilegesRequired=安装此程序需要管理员权限。
SetupAppRunningError=安装程序检测到 %1 正在运行。%n%n请先关闭所有实例，然后单击“确定”继续，或单击“取消”退出。
UninstallAppRunningError=卸载程序检测到 %1 正在运行。%n%n请先关闭所有实例，然后单击“确定”继续，或单击“取消”退出。
ExitSetupTitle=退出安装
ExitSetupMessage=安装尚未完成。如果现在退出，程序将不会被安装。%n%n你可以稍后再次运行安装程序完成安装。%n%n确定要退出安装吗？
ButtonBack=< 上一步(&B)
ButtonNext=下一步(&N) >
ButtonInstall=安装(&I)
ButtonOK=确定
ButtonCancel=取消
ButtonYes=是(&Y)
ButtonNo=否(&N)
ButtonFinish=完成(&F)
ButtonBrowse=浏览(&B)...
ButtonWizardBrowse=浏览(&B)...
ButtonNewFolder=新建文件夹(&M)
ClickNext=单击“下一步”继续，或单击“取消”退出安装程序。
BrowseDialogTitle=浏览文件夹
BrowseDialogLabel=在下面的列表中选择一个文件夹，然后单击“确定”。
NewFolderName=新建文件夹
WelcomeLabel1=欢迎使用 [name] 安装向导
WelcomeLabel2=此向导将在你的电脑上安装 [name/ver]。%n%n建议继续之前关闭其他应用程序。
WizardSelectDir=选择安装位置
SelectDirDesc=[name] 应安装到哪里？
SelectDirLabel3=安装程序会将 [name] 安装到以下文件夹。
SelectDirBrowseLabel=单击“下一步”继续。如需选择其他文件夹，请单击“浏览”。
DiskSpaceGBLabel=至少需要 [gb] GB 可用磁盘空间。
DiskSpaceMBLabel=至少需要 [mb] MB 可用磁盘空间。
DirExistsTitle=文件夹已存在
DirExists=文件夹：%n%n%1%n%n已经存在。是否仍然安装到此文件夹？
DirDoesntExistTitle=文件夹不存在
DirDoesntExist=文件夹：%n%n%1%n%n不存在。是否创建此文件夹？
WizardSelectTasks=选择附加任务
SelectTasksDesc=需要执行哪些附加任务？
SelectTasksLabel2=请选择安装 [name] 时要执行的附加任务，然后单击“下一步”。
WizardReady=准备安装
ReadyLabel1=安装程序已准备好在你的电脑上安装 [name]。
ReadyLabel2a=单击“安装”继续；如需查看或更改设置，请单击“上一步”。
ReadyLabel2b=单击“安装”继续。
ReadyMemoDir=安装位置：
ReadyMemoGroup=开始菜单文件夹：
ReadyMemoTasks=附加任务：
WizardInstalling=正在安装
InstallingLabel=请稍候，安装程序正在将 [name] 安装到你的电脑。
FinishedHeadingLabel=正在完成 [name] 安装向导
FinishedLabelNoIcons=安装程序已在你的电脑上完成 [name] 的安装。
FinishedLabel=安装程序已在你的电脑上完成 [name] 的安装。你可以从已创建的快捷方式启动应用。
ClickFinish=单击“完成”退出安装程序。
ConfirmUninstall=确定要完全移除 %1 及其所有组件吗？
UninstallStatusLabel=请稍候，正在从你的电脑中移除 %1。
UninstalledAll=%1 已成功从你的电脑中移除。
UninstalledMost=%1 卸载完成。%n%n有些项目无法移除，你可以手动删除它们。

[Files]
Source: "..\..\dist\windows\CreativeStudio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\产品素材工作台\产品素材工作台"; Filename: "{app}\CreativeStudio.exe"
Name: "{autoprograms}\产品素材工作台\停止产品素材工作台"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\stop-installed.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\CreativeStudio.exe"
Name: "{autoprograms}\产品素材工作台\彻底删除用户数据"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\clear-user-data.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\CreativeStudio.exe"
Name: "{autoprograms}\产品素材工作台\卸载产品素材工作台"; Filename: "{uninstallexe}"
Name: "{autodesktop}\产品素材工作台"; Filename: "{app}\CreativeStudio.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: checkedonce

[Run]
Filename: "{app}\CreativeStudio.exe"; Description: "安装完成后启动产品素材工作台"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\stop-installed.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "StopCreativeStudio"

[UninstallDelete]
Type: files; Name: "{app}\storage\run\server.pid"
