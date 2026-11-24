# No Pester/module downloads needed. Real temporary files; Windows service and
# process boundaries are substituted so this suite cannot touch a real station.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\StationSetup.ps1')
$script:nativeProcessInvoker = ${function:Invoke-SetupProcess}
$script:passed = 0
$script:root = Join-Path ([IO.Path]::GetTempPath()) ('azs-setup-tests-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $script:root

function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected [$Expected], got [$Actual]" }
}
function Assert-Throws([scriptblock] $Action, [string] $Pattern) {
    try { & $Action } catch {
        if ($_.ToString() -notmatch $Pattern) { throw "Wrong error: $_ (expected $Pattern)" }
        return
    }
    throw "Expected failure matching $Pattern"
}
function Test-Case([string] $Name, [scriptblock] $Action) {
    & $Action
    $script:passed++
    Write-Host "PASS $Name"
}
function Set-TestFile([string] $Path, [string] $Value) {
    $null = New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force
    [IO.File]::WriteAllText($Path, $Value)
}
function New-Fixture([switch] $Existing) {
    $script:caseDir = Join-Path $script:root ([guid]::NewGuid().ToString('N'))
    $script:install = Join-Path $script:caseDir 'station with spaces'
    $script:payload = Join-Path $script:caseDir 'payload'
    $script:config = Join-Path $script:caseDir 'incoming config.json'
    $script:database = Join-Path $script:install 'data\transactions.db'
    $script:existing = $null
    $script:events = New-Object 'Collections.Generic.List[string]'
    $script:failHealth = $false
    $script:failValidation = $false
    $script:failRegistration = $false
    $script:failShortcut = $false
    $script:registered = $false
    $script:metadata = [pscustomobject]@{
        site = 'station-123'; port = 3025; db_path = 'data/transactions.db'
        protocol = 'mock'; serial_port = 'MOCK'; serial_log_file = $null
    }
    $files = @()
    foreach ($name in @('dispenser-service.exe', 'azs-desktop.exe', 'nssm.exe', 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe', 'Launch-Desktop.ps1')) {
        Set-TestFile (Join-Path $script:payload $name) "new-$name"
        $files += @{ name = $name; sha256 = (Get-FileHash -LiteralPath (Join-Path $script:payload $name)).Hash }
    }
    @{ files = $files } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $script:payload 'payload.json') -Encoding UTF8
    Set-TestFile $script:config '{"original":"configuration with unknown fields"}'
    if ($Existing) {
        $script:config = Join-Path $script:install 'custom station.json'
        Set-TestFile $script:config '{"preserve":"products, tanks, ATG, PINs and custom settings"}'
        Set-TestFile (Join-Path $script:install 'dispenser-service.exe') 'old-service'
        Set-TestFile (Join-Path $script:install 'azs-desktop.exe') 'old-desktop'
        Set-TestFile $script:database 'existing-sales'
        Set-TestFile "$script:database-wal" 'uncheckpointed-sales'
        Set-TestFile "$script:database-shm" 'shared-memory'
        $script:existing = [pscustomobject]@{
            Application = Join-Path $script:install 'dispenser-service.exe'
            WorkingDirectory = $script:install
            Arguments = 'run --config ' + (Quote-NativeArgument $script:config)
            Status = 'Running'; Wrapper = 'existing-nssm'
        }
    }
}

# System boundaries only: actual plan, payload hashes, file copies, backups and
# failure handling below are the production implementations.
function Read-StationService { return $script:existing }
function Protect-StationBackup($Directory) { }
function Assert-DesktopClosed($InstallDir) { $script:events.Add('desktop-check') }
function Install-StationWebView($PayloadDir) { $script:events.Add('webview') }
function Stop-StationService { $script:events.Add('stop') }
function Start-StationService {
    $script:events.Add('start')
    if ($script:failHealth) { Set-TestFile $script:database 'database-after-startup-migration' }
}
function Assert-StationOffline($Plan, $DatabasePath) { $script:events.Add('offline-check') }
function Assert-PortFree($Port) { $script:events.Add('port-check') }
function Register-StationService($Plan) {
    $script:registered = $true
    $script:events.Add('register')
    if ($script:failRegistration) { throw 'registration failed' }
}
function Wait-StationHealth($Plan, $Metadata) {
    $script:events.Add('health')
    if ($script:failHealth) { throw 'health failed' }
}
function New-StationShortcut($Plan) {
    $script:events.Add('shortcut')
    if ($script:failShortcut) { throw 'shortcut denied' }
}
function Get-Service { if ($script:registered) { return @{ Status = 'Stopped' } } }
function Invoke-SetupProcess($File, $Arguments, $TimeoutSeconds) {
    if ($Arguments[0] -eq 'validate-config') {
        $script:events.Add('validate')
        if ($script:failValidation) { throw 'invalid configuration' }
        return $script:metadata | ConvertTo-Json
    }
    if ($Arguments[0] -eq 'export') { Set-TestFile $Arguments[2] 'service-settings'; return '' }
    if ($Arguments[0] -eq 'remove') { $script:events.Add('remove'); return '' }
    throw "Unexpected subprocess: $File $Arguments"
}

try {
    Test-Case 'fresh installation copies config, registers service and checks health' {
        New-Fixture
        Invoke-StationInstall $script:payload $script:install $script:config -MaintenanceConfirmed
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $script:install 'site.config.json'))) ([IO.File]::ReadAllText($script:config))
        Assert-Equal ($script:events -join ',') 'validate,desktop-check,webview,offline-check,port-check,register,start,health,shortcut'
    }
    Test-Case 'existing installation preserves config, database, WAL and service settings' {
        New-Fixture -Existing
        $configHash = (Get-FileHash $script:config).Hash
        Invoke-StationInstall $script:payload $script:install '' -MaintenanceConfirmed
        Assert-Equal ((Get-FileHash $script:config).Hash) $configHash
        Assert-Equal ([IO.File]::ReadAllText($script:database)) 'existing-sales'
        Assert-Equal ([IO.File]::ReadAllText("$script:database-wal")) 'uncheckpointed-sales'
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $script:install 'dispenser-service.exe'))) 'new-dispenser-service.exe'
        Assert-Equal ($script:events -contains 'register') $false
        $record = Get-Content (Join-Path $script:install 'station-install.json') -Raw | ConvertFrom-Json
        $files = Get-Content (Join-Path $record.backup 'files.json') -Raw | ConvertFrom-Json
        $wal = @($files | Where-Object { $_.original -eq "$script:database-wal" })
        Assert-Equal $wal.Count 1
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $record.backup $wal[0].backup))) 'uncheckpointed-sales'
    }
    Test-Case 're-running setup upgrades without registering a second service' {
        New-Fixture -Existing
        Invoke-StationInstall $script:payload $script:install '' -MaintenanceConfirmed
        Invoke-StationInstall $script:payload $script:install '' -MaintenanceConfirmed
        Assert-Equal (@($script:events | Where-Object { $_ -eq 'register' }).Count) 0
        Assert-Equal (@(Get-ChildItem (Join-Path $script:install 'backups') -Directory).Count) 2
    }
    Test-Case 'config validation fails before stopping the existing service' {
        New-Fixture -Existing
        $script:failValidation = $true
        Assert-Throws { Invoke-StationInstall $script:payload $script:install '' -MaintenanceConfirmed } 'invalid configuration'
        Assert-Equal ($script:events -contains 'stop') $false
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $script:install 'dispenser-service.exe'))) 'old-service'
    }
    Test-Case 'damaged payload is rejected before touching the station' {
        New-Fixture -Existing
        Set-TestFile (Join-Path $script:payload 'azs-desktop.exe') 'damaged'
        Assert-Throws { Invoke-StationInstall $script:payload $script:install '' -MaintenanceConfirmed } 'damaged'
        Assert-Equal $script:events.Count 0
    }
    Test-Case 'upgrade refuses a different folder or replacement site config' {
        New-Fixture -Existing
        Assert-Throws { Invoke-StationInstall $script:payload (Join-Path $script:caseDir 'wrong') '' -MaintenanceConfirmed } 'Select that folder'
        Assert-Throws { Invoke-StationInstall $script:payload $script:install (Join-Path $script:caseDir 'replacement.json') -MaintenanceConfirmed } 'preserves it'
        Assert-Equal ($script:events -contains 'stop') $false
    }
    Test-Case 'missing existing database cannot silently create a new station' {
        New-Fixture -Existing
        Remove-Item -LiteralPath $script:database
        Assert-Throws { Invoke-StationInstall $script:payload $script:install '' -MaintenanceConfirmed } 'database is missing'
        Assert-Equal ($script:events -contains 'stop') $false
    }
    Test-Case 'service registration failure restores files before any startup' {
        New-Fixture
        Set-TestFile (Join-Path $script:install 'azs-desktop.exe') 'old-desktop'
        $script:failRegistration = $true
        Assert-Throws { Invoke-StationInstall $script:payload $script:install $script:config -MaintenanceConfirmed } 'registration failed'
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $script:install 'azs-desktop.exe'))) 'old-desktop'
        Assert-Equal (Test-Path (Join-Path $script:install 'dispenser-service.exe')) $false
        Assert-Equal ($script:events -contains 'remove') $true
        Assert-Equal ($script:events -contains 'start') $false
    }
    Test-Case 'failed health after startup never restores the database or older binaries' {
        New-Fixture -Existing
        $script:failHealth = $true
        Assert-Throws { Invoke-StationInstall $script:payload $script:install '' -MaintenanceConfirmed } 'data was NOT rolled back'
        Assert-Equal ([IO.File]::ReadAllText($script:database)) 'database-after-startup-migration'
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $script:install 'dispenser-service.exe'))) 'new-dispenser-service.exe'
        Assert-Equal $script:events[$script:events.Count - 1] 'stop'
    }
    Test-Case 'a failed shortcut does not roll back a healthy running service' {
        New-Fixture -Existing
        $script:failShortcut = $true
        Invoke-StationInstall $script:payload $script:install '' -MaintenanceConfirmed
        Assert-Equal (@($script:events | Where-Object { $_ -eq 'stop' }).Count) 1
    }
    Test-Case 'maintenance must be explicitly confirmed' {
        New-Fixture
        Assert-Throws { Invoke-StationInstall $script:payload $script:install $script:config } 'Confirm that dispensing'
        Assert-Equal $script:events.Count 0
    }
    Test-Case 'existing global config arguments and relative paths are preserved' {
        New-Fixture
        Assert-Equal (Get-ExistingConfig '--config "configs/my station.json" run' $script:install) (Join-Path $script:install 'configs/my station.json')
        Assert-Equal (Get-ExistingConfig 'run --config=station.json' $script:install) (Join-Path $script:install 'station.json')
        Assert-Throws { Get-ExistingConfig 'run --unknown something' $script:install } 'custom arguments'
    }
    Test-Case 'database path cannot overwrite application configuration' {
        New-Fixture
        $script:metadata.db_path = 'site.config.json'
        Assert-Throws { Invoke-StationInstall $script:payload $script:install $script:config -MaintenanceConfirmed } 'overlaps'
        Assert-Equal ($script:events -contains 'stop') $false
    }
    Test-Case 'Windows argument quoting preserves spaces, quotes and final backslash' {
        Assert-Equal (Quote-NativeArgument 'C:\station one\') '"C:\station one\\"'
        Assert-Equal (Quote-NativeArgument 'run --config "C:\station one\site.json"') '"run --config \"C:\station one\site.json\""'
    }
    Test-Case 'subprocess arguments survive native quoting without shell expansion' {
        $python = @(Get-Command python, python3 -ErrorAction SilentlyContinue)[0].Source
        $value = 'spaces "quotes" & literal $data C:\ends-with-slash\'
        $result = & $script:nativeProcessInvoker $python @('-c', 'import sys,json; print(json.dumps(sys.argv[1]))', $value)
        Assert-Equal ($result | ConvertFrom-Json) $value
        Assert-Throws { & $script:nativeProcessInvoker $python @('-c', 'import sys; sys.exit(7)') } 'failed \(7\)'
    }
    Write-Host "$script:passed installer safety tests passed."
} finally { Remove-Item -LiteralPath $script:root -Recurse -Force }
