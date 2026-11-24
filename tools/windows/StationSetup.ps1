# Windows PowerShell 5.1 compatible. Dot-source this file; no work runs on import.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ServiceName = 'AzsService'

function Resolve-StationPath([string] $Path, [string] $Base) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'An empty file path is not allowed.' }
    # Root-relative / drive-relative paths depend on the caller's working drive.
    if ([IO.Path]::DirectorySeparatorChar -eq '\' -and
        ($Path -match '^[A-Za-z]:[^\\/]' -or $Path -match '^[/\\](?![/\\])')) {
        throw "Use an absolute drive path or a relative file name: $Path"
    }
    if (![IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $Base $Path }
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Quote-NativeArgument([string] $Value) {
    # Windows CommandLineToArgvW/CRT quoting, including embedded quotes and trailing slashes.
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-SetupProcess([string] $File, [string[]] $Arguments, [int] $TimeoutSeconds = 120) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $File
    $start.Arguments = ($Arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (!$process.Start()) { throw "Could not start $File" }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            throw "Timed out running $([IO.Path]::GetFileName($File))."
        }
        $output = $stdout.GetAwaiter().GetResult()
        $errorText = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            throw "$([IO.Path]::GetFileName($File)) failed ($($process.ExitCode)): $errorText $output"
        }
        return $output.Trim()
    } finally { $process.Dispose() }
}

function Read-StationService {
    $service = Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue
    if (!$service) { return $null }
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$script:ServiceName"
    $parameters = Get-ItemProperty -LiteralPath "$key\Parameters" -ErrorAction SilentlyContinue
    if (!$parameters -or !$parameters.PSObject.Properties['Application'] -or
        !$parameters.PSObject.Properties['AppDirectory'] -or !$parameters.PSObject.Properties['AppParameters']) {
        throw 'AzsService exists but is not a supported NSSM installation. It has not been changed.'
    }
    $image = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $key).ImagePath).Trim('"')
    if ([IO.Path]::GetFileName($image) -ine 'nssm.exe' -or !(Test-Path -LiteralPath $image -PathType Leaf)) {
        throw 'The existing AzsService wrapper cannot be identified. It has not been changed.'
    }
    return [pscustomobject]@{
        Application = [Environment]::ExpandEnvironmentVariables($parameters.Application)
        WorkingDirectory = [Environment]::ExpandEnvironmentVariables($parameters.AppDirectory)
        Arguments = [Environment]::ExpandEnvironmentVariables($parameters.AppParameters)
        Status = [string]$service.Status
        Wrapper = $image
    }
}

function Get-ExistingConfig([string] $Arguments, [string] $WorkingDirectory) {
    # Accept the documented command, including global --config before run. Fail closed
    # for custom flags instead of guessing a path and starting a second database.
    $path = '(?:"(?<quoted>[^"\r\n]+)"|(?<plain>[^\s"]+))'
    if ($Arguments.Trim() -eq 'run') { return Join-Path $WorkingDirectory 'site.config.json' }
    if ($Arguments -match ('^\s*run\s+--config(?:\s+|=)' + $path + '\s*$') -or
        $Arguments -match ('^\s*--config(?:\s+|=)' + $path + '\s+run\s*$')) {
        $value = $Matches['quoted']
        if (!$value) { $value = $Matches['plain'] }
        return Resolve-StationPath $value $WorkingDirectory
    }
    throw 'The existing service uses custom arguments. Setup will not replace or guess them.'
}

function Get-StationPlan([string] $InstallDir, [string] $ConfigPath, $Existing) {
    $dir = Resolve-StationPath $InstallDir (Get-Location).Path
    if ($dir -match '^[A-Za-z]:$' -or $dir -match '^\\\\') {
        throw 'Select a dedicated folder on a local drive, for example C:\azs.'
    }
    $workDir = $dir
    $targetConfig = Join-Path $dir 'site.config.json'
    if ($Existing) {
        if ([IO.Path]::GetFileName($Existing.Application) -ine 'dispenser-service.exe') {
            throw 'AzsService points to another application. Setup will not change it.'
        }
        $existingDir = Resolve-StationPath ([IO.Path]::GetDirectoryName($Existing.Application)) $dir
        if ($existingDir -ine $dir) { throw "This station is installed in $existingDir. Select that folder to upgrade it." }
        $workDir = Resolve-StationPath $Existing.WorkingDirectory $dir
        $targetConfig = Get-ExistingConfig $Existing.Arguments $workDir
        if (!(Test-Path -LiteralPath $targetConfig -PathType Leaf)) { throw "Existing configuration is missing: $targetConfig" }
    }
    $copyConfig = !(Test-Path -LiteralPath $targetConfig -PathType Leaf)
    if (!$copyConfig) {
        if ($ConfigPath -and (Resolve-StationPath $ConfigPath $dir) -ine $targetConfig) {
            throw 'A station configuration already exists. Setup preserves it; import changes separately after installation.'
        }
        $sourceConfig = $targetConfig
    } else {
        if (!$ConfigPath) { throw 'Select the site.config.json downloaded for this station.' }
        $sourceConfig = Resolve-StationPath $ConfigPath (Get-Location).Path
        if (!(Test-Path -LiteralPath $sourceConfig -PathType Leaf)) { throw "Configuration not found: $sourceConfig" }
    }
    return [pscustomobject]@{
        InstallDir = $dir; WorkingDirectory = $workDir; ConfigPath = $targetConfig
        SourceConfig = $sourceConfig; CopyConfig = $copyConfig; Existing = $Existing
    }
}

function Assert-SetupPayload([string] $PayloadDir) {
    $manifest = Get-Content -LiteralPath (Join-Path $PayloadDir 'payload.json') -Raw | ConvertFrom-Json
    $required = @('dispenser-service.exe', 'azs-desktop.exe', 'nssm.exe', 'Launch-Desktop.ps1')
    if (@($manifest.files).Count -ne $required.Count) { throw 'Incomplete installer payload manifest.' }
    foreach ($name in $required) {
        $entry = @($manifest.files | Where-Object { $_.name -ceq $name })
        if ($entry.Count -ne 1 -or $entry[0].sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Missing manifest entry: $name" }
        $file = Join-Path $PayloadDir $name
        if (!(Test-Path -LiteralPath $file -PathType Leaf) -or
            (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $entry[0].sha256) {
            throw "Installer payload is missing or damaged: $name"
        }
    }
}

function Test-MachineWebView {
    $key = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $value = Get-ItemProperty -LiteralPath "HKLM:\$key" -ErrorAction SilentlyContinue
    $version = $null
    return ($value -and $value.PSObject.Properties['pv'] -and
        [version]::TryParse([string]$value.pv, [ref]$version) -and $version -gt [version]'0.0.0.0')
}

function Assert-DesktopClosed([string] $InstallDir) {
    $path = Join-Path $InstallDir 'azs-desktop.exe'
    foreach ($process in @(Get-Process -Name azs-desktop -ErrorAction SilentlyContinue)) {
        if (!$process.Path -or $process.Path -ieq $path) { throw 'Close AZS Manager before installing an update.' }
    }
}

function Stop-StationService {
    $service = Get-Service -Name $script:ServiceName
    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name $script:ServiceName -ErrorAction Stop
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
    }
}

function Start-StationService {
    Start-Service -Name $script:ServiceName
    (Get-Service -Name $script:ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
}

function Assert-StationOffline($Plan, [string] $DatabasePath) {
    # A manually started service can outlive NSSM. Never kill it or copy a live WAL.
    foreach ($process in @(Get-Process -Name dispenser-service -ErrorAction SilentlyContinue)) {
        if (!$process.Path -or $process.Path -ieq (Join-Path $Plan.InstallDir 'dispenser-service.exe')) {
            throw 'A dispenser-service process is still running. Stop the manual instance before updating.'
        }
    }
    foreach ($path in @($DatabasePath, "$DatabasePath-wal", "$DatabasePath-shm", "$DatabasePath-journal")) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $handle = [IO.File]::Open($path, 'Open', 'Read', 'None')
            $handle.Dispose()
        }
    }
}

function Assert-PortFree([int] $Port) {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() } finally { $listener.Stop() }
}

function Protect-StationBackup([string] $Directory) {
    # Backups can contain station credentials. Only Administrators and SYSTEM may read them.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl',
            'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Directory -AclObject $acl
}

function New-StationBackup($Plan, [string] $DatabasePath) {
    $directory = Join-Path $Plan.InstallDir ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $directory -Force
    Protect-StationBackup $directory
    $paths = @($Plan.ConfigPath, $DatabasePath, "$DatabasePath-wal", "$DatabasePath-shm", "$DatabasePath-journal")
    foreach ($name in @('dispenser-service.exe', 'azs-desktop.exe', 'Launch-Desktop.ps1', 'station-install.json')) {
        $paths += Join-Path $Plan.InstallDir $name
    }
    $files = @()
    foreach ($path in @($paths | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $name = "$($files.Count)-$([IO.Path]::GetFileName($path))"
            Copy-Item -LiteralPath $path -Destination (Join-Path $directory $name)
            $files += [pscustomobject]@{ original = $path; backup = $name }
        }
    }
    if ($Plan.Existing) {
        $null = Invoke-SetupProcess reg.exe @('export', "HKLM\SYSTEM\CurrentControlSet\Services\$script:ServiceName", (Join-Path $directory 'service.reg'), '/y')
    }
    ConvertTo-Json -InputObject @($files) -Depth 4 | Set-Content -LiteralPath (Join-Path $directory 'files.json') -Encoding UTF8
    return [pscustomobject]@{ Directory = $directory; Files = $files }
}

function Register-StationService($Plan) {
    $nssm = Join-Path $Plan.InstallDir 'tools\nssm.exe'
    $null = Invoke-SetupProcess $nssm @('install', $script:ServiceName, (Join-Path $Plan.InstallDir 'dispenser-service.exe'))
    # Write the literal command string directly; PowerShell 5.1's native argument
    # marshaller otherwise removes the nested quotes around paths containing spaces.
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$script:ServiceName\Parameters"
    Set-ItemProperty -LiteralPath $key -Name AppParameters -Value ('run --config ' + (Quote-NativeArgument $Plan.ConfigPath))
    $settings = @(
        @('AppDirectory', $Plan.WorkingDirectory), @('DisplayName', 'AZS Dispenser Service'),
        @('Description', 'AZS dispenser service and local API'), @('Start', 'SERVICE_AUTO_START'),
        @('AppStdout', (Join-Path $Plan.InstallDir 'logs\service.log')),
        @('AppStderr', (Join-Path $Plan.InstallDir 'logs\service.err')),
        @('AppRotateFiles', '1'), @('AppRotateBytes', '10485760'), @('AppRotateOnline', '1'),
        @('AppExit', 'Default', 'Restart'), @('AppRestartDelay', '5000')
    )
    foreach ($setting in $settings) { $null = Invoke-SetupProcess $nssm (@('set', $script:ServiceName) + $setting) }
}

function Wait-StationHealth($Plan, $Metadata, [int] $TimeoutSeconds = 60) {
    $end = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($Metadata.port)/health" -TimeoutSec 2
            if ($health.status -eq 'ok' -and $health.site -ceq $Metadata.site -and
                (Resolve-StationPath $health.config_path $Plan.WorkingDirectory) -ieq $Plan.ConfigPath -and
                (Get-Service -Name $script:ServiceName).Status -eq 'Running') { return }
        } catch { }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $end)
    throw 'The station did not pass its local health check. Review logs\service.err and logs\service.log.'
}

function New-StationShortcut($Plan) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'AZS Manager.lnk'))
    $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (Quote-NativeArgument (Join-Path $Plan.InstallDir 'Launch-Desktop.ps1'))
    $shortcut.WorkingDirectory = $Plan.InstallDir
    $shortcut.IconLocation = (Join-Path $Plan.InstallDir 'azs-desktop.exe') + ',0'
    $shortcut.Save()
}

function Invoke-StationInstall([string] $PayloadDir, [string] $InstallDir, [string] $ConfigPath, [switch] $MaintenanceConfirmed) {
    if (!$MaintenanceConfirmed) { throw 'Confirm that dispensing has finished and the station can be stopped for maintenance.' }
    Assert-SetupPayload $PayloadDir
    $existing = Read-StationService
    $plan = Get-StationPlan $InstallDir $ConfigPath $existing
    $metadata = Invoke-SetupProcess (Join-Path $PayloadDir 'dispenser-service.exe') @('validate-config', '--config', $plan.SourceConfig) | ConvertFrom-Json
    if ([int]$metadata.port -lt 1 -or [int]$metadata.port -gt 65535) { throw 'The local service port must be between 1 and 65535.' }
    if ($metadata.protocol -ne 'mock' -and $metadata.serial_port -notmatch '^(?:\\\\\.\\)?COM[1-9][0-9]*$') {
        throw 'Select the Windows COM port in the site configuration before installing.'
    }
    $database = Resolve-StationPath $metadata.db_path $plan.WorkingDirectory
    $serialLog = $null
    if ($metadata.serial_log_file) { $serialLog = Resolve-StationPath $metadata.serial_log_file $plan.WorkingDirectory }
    $reserved = @($plan.ConfigPath, (Join-Path $plan.InstallDir 'dispenser-service.exe'),
        (Join-Path $plan.InstallDir 'azs-desktop.exe'), (Join-Path $plan.InstallDir 'station-install.json'),
        (Join-Path $plan.InstallDir 'Launch-Desktop.ps1'), (Join-Path $plan.InstallDir 'tools\nssm.exe'),
        (Join-Path $plan.InstallDir 'logs\service.log'), (Join-Path $plan.InstallDir 'logs\service.err'))
    if ($database -in $reserved -or $serialLog -in ($reserved + @($database, "$database-wal", "$database-shm"))) {
        throw 'The database or serial log path overlaps an application/configuration file.'
    }
    if (!$plan.CopyConfig -and !(Test-Path -LiteralPath $database -PathType Leaf) -and $existing) {
        throw "Existing station database is missing: $database. Setup will not create a replacement."
    }
    Assert-DesktopClosed $plan.InstallDir
    $hasWebView = Test-MachineWebView
    $backup = $null
    $touched = @()
    $serviceMayExist = $false
    $launchAttempted = $false
    $stopped = $false
    try {
        if ($existing) { Stop-StationService; $stopped = $true }
        Assert-StationOffline $plan $database
        Assert-PortFree ([int]$metadata.port)
        $null = New-Item -ItemType Directory -Path $plan.InstallDir -Force
        $backup = New-StationBackup $plan $database
        Write-Host "Backup: $($backup.Directory)"
        foreach ($name in @('dispenser-service.exe', 'azs-desktop.exe', 'Launch-Desktop.ps1')) {
            $destination = Join-Path $plan.InstallDir $name
            $touched += $destination
            Copy-Item -LiteralPath (Join-Path $PayloadDir $name) -Destination $destination -Force
        }
        if ($plan.CopyConfig) {
            $touched += $plan.ConfigPath
            Copy-Item -LiteralPath $plan.SourceConfig -Destination $plan.ConfigPath
        }
        foreach ($directory in @((Split-Path $database -Parent), (Join-Path $plan.InstallDir 'logs'))) {
            $null = New-Item -ItemType Directory -Path $directory -Force
        }
        if ($serialLog) {
            $null = New-Item -ItemType Directory -Path (Split-Path $serialLog -Parent) -Force
        }
        if (!$existing) {
            $tools = Join-Path $plan.InstallDir 'tools'
            $null = New-Item -ItemType Directory -Path $tools -Force
            if (Test-Path -LiteralPath (Join-Path $tools 'nssm.exe')) { throw 'An unmanaged tools\nssm.exe already exists. Move it aside before a new install.' }
            $touched += Join-Path $tools 'nssm.exe'
            Copy-Item -LiteralPath (Join-Path $PayloadDir 'nssm.exe') -Destination $tools
            $serviceMayExist = $true
            Register-StationService $plan
        }
        # Existing NSSM wrapper, service identity, environment, logging, arguments,
        # dependencies and startup settings are deliberately kept as they are.
        $record = Join-Path $plan.InstallDir 'station-install.json'
        $touched += $record
        @{ config_path = $plan.ConfigPath; backup = $backup.Directory; installed_at = [DateTime]::UtcNow.ToString('o') } |
            ConvertTo-Json | Set-Content -LiteralPath $record -Encoding UTF8
        $launchAttempted = $true
        Start-StationService
        Wait-StationHealth $plan $metadata
        try { New-StationShortcut $plan } catch { Write-Warning "Service installed successfully, but desktop shortcut could not be created: $_" }
        Write-Host "Station $($metadata.site) is running. Configuration: $($plan.ConfigPath)"
        $result = 'Station installed and local health check passed. Open AZS Manager using the desktop shortcut.'
        if (!$hasWebView) {
            $result += ' WebView2 was not detected for all users. The desktop requires an existing WebView2 runtime; install it separately if needed. Setup did not download or install it.'
        }
        return $result
    } catch {
        $failure = $_
        if ($launchAttempted) {
            # Startup can run migrations, persist tank IDs and sync data. Never roll
            # a live database back automatically or restart an older binary against it.
            try { Stop-StationService } catch { Write-Warning "Could not stop the service: $_" }
            throw "$failure New service startup was attempted; data was NOT rolled back. Backup: $($backup.Directory). Review logs before restarting."
        }
        if ($serviceMayExist -and (Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue)) {
            $null = Invoke-SetupProcess (Join-Path $plan.InstallDir 'tools\nssm.exe') @('remove', $script:ServiceName, 'confirm')
        }
        foreach ($destination in $touched) {
            $saved = @($backup.Files | Where-Object { $_.original -ieq $destination })
            if ($saved.Count -eq 1) {
                Copy-Item -LiteralPath (Join-Path $backup.Directory $saved[0].backup) -Destination $destination -Force
            } elseif (Test-Path -LiteralPath $destination -PathType Leaf) {
                Remove-Item -LiteralPath $destination
            }
        }
        if ($stopped -and $existing.Status -eq 'Running') { Start-StationService }
        throw $failure
    }
}
