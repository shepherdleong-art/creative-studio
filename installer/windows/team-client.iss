#ifndef PayloadRoot
  #error PayloadRoot required
#endif
#ifndef ExtraRoot
  #error ExtraRoot required
#endif
#ifndef ReleaseId
  #error ReleaseId required
#endif
#ifndef OutputRoot
  #error OutputRoot required
#endif

[Setup]
AppId={{1B1F3967-6241-49EA-95FC-B2E5421C4A3C}
AppName=林视团队客户端 Beta
AppVersion={#AppVersion}
AppVerName=林视团队客户端 Beta ({#ReleaseId})
DefaultDirName={localappdata}\Programs\LinsVisionBeta
DefaultGroupName=林视团队客户端 Beta
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputRoot}
OutputBaseFilename=LinsVision-Beta-Setup-{#ReleaseId}
SetupIconFile={#ExtraRoot}\app.ico
UninstallDisplayIcon={app}\Creative Studio.exe
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=yes
RestartApplications=no
LicenseFile={#ExtraRoot}\LICENSE.txt

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："
Name: "trustcertificate"; Description: "首次使用：信任公司内网公开证书（仅当前 Windows 账号）"; GroupDescription: "内网连接："

[Files]
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Excludes: "client-state\*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\client-state\state.json"; DestDir: "{app}\client-state"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#PayloadRoot}\client-state\run\transfer-gate.json"; DestDir: "{app}\client-state\run"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#ExtraRoot}\Creative Studio.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ExtraRoot}\studio-root.cer"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ExtraRoot}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\client-state\accounts"; Flags: uninsneveruninstall
Name: "{app}\client-state\downloads"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\林视客户端 Beta"; Filename: "{app}\Creative Studio.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\林视客户端 Beta"; Filename: "{app}\Creative Studio.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{sys}\certutil.exe"; Parameters: "-user -addstore Root ""{app}\studio-root.cer"""; Tasks: trustcertificate; Flags: waituntilterminated; StatusMsg: "请核对 Windows 显示的公司根证书名称后确认…"
Filename: "{app}\Creative Studio.exe"; Description: "启动林视客户端"; Flags: nowait postinstall skipifsilent
