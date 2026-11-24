#ifndef PayloadDir
  #error PayloadDir is required; use Build-Installer.ps1
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef BuildVersion
  #define BuildVersion "0.1.0"
#endif

[Setup]
AppId=AZSStationSetup
AppName=AZS Station
AppVersion={#BuildVersion}
AppPublisher=UNG
DefaultDirName=C:\azs
DisableProgramGroupPage=yes
DisableDirPage=no
UsePreviousAppDir=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=AZS-Station-Setup-{#BuildVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
; The PowerShell transaction owns all installed files. Inno must never roll back
; or uninstall a station database after a service has started and migrated it.
CreateAppDir=yes
Uninstallable=no
CloseApplications=no
RestartApplications=no

[Files]
Source: "Install-Station.ps1"; DestDir: "{tmp}\setup"; Flags: dontcopy
Source: "StationSetup.ps1"; DestDir: "{tmp}\setup"; Flags: dontcopy
Source: "{#PayloadDir}\*"; DestDir: "{tmp}\payload"; Flags: dontcopy

[Code]
var
  ConfigPage: TInputFileWizardPage;
  MaintenancePage: TInputOptionWizardPage;
  ExistingService: Boolean;
  Installed: Boolean;

function Quoted(Value: String): String;
begin
  Result := '"' + Value + '"';
end;

procedure InitializeWizard;
var
  ApplicationPath: String;
begin
  ExistingService := RegKeyExists(HKLM64, 'SYSTEM\CurrentControlSet\Services\AzsService');
  if RegQueryStringValue(HKLM64, 'SYSTEM\CurrentControlSet\Services\AzsService\Parameters',
      'Application', ApplicationPath) then
  begin
    WizardForm.DirEdit.Text := ExtractFileDir(ApplicationPath);
    WizardForm.DirEdit.Enabled := False;
    WizardForm.DirBrowseButton.Enabled := False;
  end;
  ConfigPage := CreateInputFilePage(wpSelectDir, 'Station configuration',
    'Select the configuration downloaded from the web.',
    'For a new station, select its JSON configuration. Existing station configurations are preserved.');
  ConfigPage.Add('Configuration file:', 'JSON files|*.json', '.json');
  ConfigPage.Values[0] := ExpandConstant('{param:CONFIG|}');
  MaintenancePage := CreateInputOptionPage(ConfigPage.ID, 'Ready for maintenance',
    'Finish dispensing and close AZS Manager before continuing.',
    'Setup backs up the current station, updates the applications, then starts and checks the service. ' +
    'Existing products, nozzles, tank settings, PINs and transaction data are preserved.', False, False);
  MaintenancePage.Add('Dispensing has finished and this station can be stopped for maintenance.');
  MaintenancePage.Values[0] := ExpandConstant('{param:MAINTENANCE|0}') = '1';
  WizardForm.FinishedLabel.Caption :=
    'The station service is running and its local health check passed. Open AZS Manager using the desktop shortcut.';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = ConfigPage.ID) and
    (ExistingService or FileExists(AddBackslash(WizardDirValue) + 'site.config.json'));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = ConfigPage.ID) and not ShouldSkipPage(ConfigPage.ID) and
      not FileExists(ConfigPage.Values[0]) then
  begin
    MsgBox('Select an existing station configuration JSON file.', mbError, MB_OK);
    Result := False;
  end;
  if (CurPageID = MaintenancePage.ID) and not MaintenancePage.Values[0] then
  begin
    MsgBox('Confirm the station is ready for maintenance before installing.', mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Arguments, ResultPath: String;
  ResultCode: Integer;
  Detail: AnsiString;
begin
  Result := '';
  if Installed then Exit;
  ExtractTemporaryFiles('{tmp}\setup\*');
  ExtractTemporaryFiles('{tmp}\payload\*');
  ResultPath := ExpandConstant('{tmp}\station-setup-result.txt');
  Arguments := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
    Quoted(ExpandConstant('{tmp}\setup\Install-Station.ps1')) +
    ' -PayloadDir ' + Quoted(ExpandConstant('{tmp}\payload')) +
    ' -InstallDir ' + Quoted(RemoveBackslashUnlessRoot(WizardDirValue)) +
    ' -ResultFile ' + Quoted(ResultPath) + ' -MaintenanceConfirmed';
  if not ShouldSkipPage(ConfigPage.ID) then
    Arguments := Arguments + ' -ConfigPath ' + Quoted(ConfigPage.Values[0]);
  WizardForm.PreparingLabel.Caption := 'Validating, backing up, installing and checking the station. This may take several minutes.';
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      Arguments, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := 'Could not start Windows PowerShell. No station update was completed.'
  else if ResultCode <> 0 then
  begin
    if LoadStringFromFile(ResultPath, Detail) then Result := UTF8Decode(Detail)
    else Result := 'Station setup failed. Review the installer log.';
    Log(Result);
  end
  else Installed := True;
end;
