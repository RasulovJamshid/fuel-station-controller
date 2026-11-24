#Requires -Version 5.1
#Requires -RunAsAdministrator
# Run ONLY on a disposable Windows CI machine. Never uses physical pump protocols.
param(
    [Parameter(Mandatory = $true)][string] $ServiceExe,
    [Parameter(Mandatory = $true)][string] $NssmExe,
    [Parameter(Mandatory = $true)][string] $InstallerExe
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\StationSetup.ps1')
if (Get-Service -Name AzsService -ErrorAction SilentlyContinue) { throw 'AzsService already exists. This test must run on a disposable machine.' }
$temporaryRoot = $env:TEMP
if ($env:RUNNER_TEMP) { $temporaryRoot = $env:RUNNER_TEMP }
$root = Join-Path $temporaryRoot ('azs-integration-' + [guid]::NewGuid().ToString('N'))
$payload = Join-Path $root 'payload'
$install = Join-Path $root 'station with spaces'
$null = New-Item -ItemType Directory -Path $payload -Force
$null = New-Item -ItemType Directory -Path $install
$sourceConfig = Join-Path $root 'incoming config.json'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$config = Get-Content (Join-Path $repo 'services\dispenser-service\site.mock.json') -Raw | ConvertFrom-Json
$portProbe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$config.service.port = $portProbe.LocalEndpoint.Port
$portProbe.Stop()
$config.service.db_path = 'data\station.db'
$config.service.serial_log_file = $null
$config.sync.enabled = $false
$config | Add-Member -NotePropertyName atg -NotePropertyValue $null -Force
# serde_json expects UTF-8 without the Windows PowerShell Set-Content BOM.
[IO.File]::WriteAllText($sourceConfig, ($config | ConvertTo-Json -Depth 40), (New-Object Text.UTF8Encoding($false)))
Copy-Item -LiteralPath $ServiceExe -Destination (Join-Path $payload 'dispenser-service.exe')
Copy-Item -LiteralPath $NssmExe -Destination (Join-Path $payload 'nssm.exe')
# The desktop is never launched by this service lifecycle test.
Copy-Item -LiteralPath $NssmExe -Destination (Join-Path $payload 'azs-desktop.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\Launch-Desktop.ps1') -Destination $payload
$files = @(Get-ChildItem $payload -File | ForEach-Object { @{ name = $_.Name; sha256 = (Get-FileHash $_.FullName).Hash } })
@{ files = $files } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $payload 'payload.json') -Encoding UTF8
function New-StationShortcut($Plan) { }

try {
    Invoke-StationInstall $payload $install $sourceConfig -MaintenanceConfirmed
    $health = Invoke-RestMethod "http://127.0.0.1:$($config.service.port)/health"
    if ($health.status -ne 'ok') { throw 'Fresh install health failed.' }
    $serviceSettings = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\AzsService\Parameters'
    if ($serviceSettings.AppParameters -ne ('run --config "' + (Join-Path $install 'site.config.json') + '"')) {
        throw 'NSSM arguments lost quoted configuration path.'
    }
# Add a marker to the database; it must survive another install.
    Stop-StationService
    $database = Join-Path $install 'data\station.db'
    $null = Invoke-SetupProcess (Get-Command python).Source @('-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE installer_preservation_test (value TEXT)"); c.execute("INSERT INTO installer_preservation_test VALUES (?)", ("keep-me",)); c.commit()', $database)
    Start-StationService
    $originalConfig = [IO.File]::ReadAllBytes((Join-Path $install 'site.config.json'))
    Invoke-StationInstall $payload $install '' -MaintenanceConfirmed
    $updatedSettings = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\AzsService\Parameters'
    if ($updatedSettings.AppParameters -ne $serviceSettings.AppParameters -or $updatedSettings.AppDirectory -ne $serviceSettings.AppDirectory) {
        throw 'Upgrade changed existing service settings.'
    }
    Stop-StationService
    $null = Invoke-SetupProcess (Get-Command python).Source @('-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute("SELECT value FROM installer_preservation_test").fetchone()[0]=="keep-me"', $database)
    if ([Convert]::ToBase64String($originalConfig) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $install 'site.config.json')))) {
        throw 'Upgrade changed station configuration.'
    }
    # Exercise the compiled installer, including extraction, argument passing,
    # maintenance consent and failure propagation.
    $null = Invoke-SetupProcess $InstallerExe @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/SP-', '/NORESTART',
        "/DIR=$install", '/MAINTENANCE=1', "/LOG=$(Join-Path $root 'installer-upgrade.log')") 900
    if ((Invoke-RestMethod "http://127.0.0.1:$($config.service.port)/health").status -ne 'ok') { throw 'Compiled installer upgrade failed.' }
    Stop-StationService
    $null = Invoke-SetupProcess $NssmExe @('remove', 'AzsService', 'confirm')
    # Allow the Service Control Manager to finish deleting the old registration.
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (Get-Service -Name AzsService -ErrorAction SilentlyContinue) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Old test service is still marked for deletion.' }
        Start-Sleep -Milliseconds 250
    }
    $fresh = Join-Path $root 'fresh station'
    $null = Invoke-SetupProcess $InstallerExe @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/SP-', '/NORESTART',
        "/DIR=$fresh", "/CONFIG=$sourceConfig", '/MAINTENANCE=1', "/LOG=$(Join-Path $root 'installer-fresh.log')") 900
    $health = Invoke-RestMethod "http://127.0.0.1:$($config.service.port)/health"
    if ($health.config_path -ine (Join-Path $fresh 'site.config.json')) { throw 'Compiled installer used the wrong configuration.' }
    Write-Host 'PASS real NSSM lifecycle, compiled installer fresh/upgrade, quoted paths, health and database preservation.'
} finally {
    $service = Get-Service -Name AzsService -ErrorAction SilentlyContinue
    if ($service) {
        Stop-StationService
        $null = Invoke-SetupProcess $NssmExe @('remove', 'AzsService', 'confirm')
    }
    $shortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'AZS Manager.lnk'
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
    # Leave logs and backups available for CI failure artifacts.
    Write-Host "Windows installation test files: $root"
}
