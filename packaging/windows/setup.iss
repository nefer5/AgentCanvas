#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef StageDir
  #error StageDir is required
#endif
#ifndef OutputPath
  #error OutputPath is required
#endif

[Setup]
AppId={{9F210BB6-9988-4532-AB4A-90673682B1B9}
AppName=AgentCanvas
AppVersion={#AppVersion}
AppPublisher=AgentCanvas contributors
DefaultDirName={localappdata}\Programs\AgentCanvas
DefaultGroupName=AgentCanvas
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
DisableProgramGroupPage=yes
LicenseFile={#StageDir}\LICENSE
OutputDir={#OutputPath}
OutputBaseFilename=AgentCanvas-{#AppVersion}-win-x64-setup
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
ChangesEnvironment=yes
UninstallDisplayName=AgentCanvas
SetupLogging=yes

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked
Name: skills; Description: "Install Agent Canvas skills for detected agent tools"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "integration.ps1"; Flags: dontcopy

[Icons]
Name: "{group}\AgentCanvas"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\app\scripts\start-excalidraw.ps1"""; WorkingDir: "{app}"
Name: "{userdesktop}\AgentCanvas"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\app\scripts\start-excalidraw.ps1"""; WorkingDir: "{app}"; Tasks: desktopicon

[UninstallDelete]
Type: files; Name: "{app}\.path-added"
Type: files; Name: "{app}\app\.excalidraw-server*.pid"

[Code]
function RunIntegration(ScriptPath, Action, Extra: String): Boolean;
var ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ScriptPath +
    '" -Action ' + Action + ' -InstallRoot "' + ExpandConstant('{app}') +
    '" -Version "{#AppVersion}" ' + Extra, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := Result and (ResultCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  ExtractTemporaryFile('integration.ps1');
  if not RunIntegration(ExpandConstant('{tmp}\integration.ps1'), 'Preflight', '') then
    Result := 'Preflight failed. Node.js 20+ must be available on PATH. Downgrades are not supported. Close the installed AgentCanvas server and retry.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var Extra: String;
begin
  if CurStep = ssPostInstall then begin
    Extra := '';
    if WizardIsTaskSelected('skills') then Extra := '-WithSkills';
    if not RunIntegration(ExpandConstant('{app}\integration.ps1'), 'Install', Extra) then
      RaiseException('AgentCanvas files installed, but CLI/skill integration failed. Run Setup again to repair.');
  end;
end;

function InitializeUninstall(): Boolean;
begin
  Result := RunIntegration(ExpandConstant('{app}\integration.ps1'), 'Uninstall', '');
  if not Result then MsgBox('Could not stop AgentCanvas or remove its integration. Close the installed server and retry.', mbError, MB_OK);
end;
