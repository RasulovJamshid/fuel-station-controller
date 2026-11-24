#Requires -Version 5.1
#Requires -RunAsAdministrator
param(
    [Parameter(Mandatory = $true)][string] $PayloadDir,
    [Parameter(Mandatory = $true)][string] $InstallDir,
    [string] $ConfigPath,
    [switch] $MaintenanceConfirmed,
    [string] $ResultFile
)
$ErrorActionPreference = 'Stop'
try {
    if (![Environment]::Is64BitOperatingSystem -or ![Environment]::Is64BitProcess) {
        throw 'Use 64-bit PowerShell on 64-bit Windows.'
    }
    . (Join-Path $PSScriptRoot 'StationSetup.ps1')
    $mutex = New-Object Threading.Mutex($false, 'Global\AZSStationInstaller')
    $locked = $false
    try {
        $locked = $mutex.WaitOne(0)
        if (!$locked) { throw 'Another station installer is already running.' }
        Invoke-StationInstall -PayloadDir $PayloadDir -InstallDir $InstallDir -ConfigPath $ConfigPath -MaintenanceConfirmed:$MaintenanceConfirmed
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
    if ($ResultFile) { 'Station installed and local health check passed.' | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }
    exit 0
} catch {
    if ($ResultFile) { $_.ToString() | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }
    Write-Error $_ -ErrorAction Continue
    exit 1
}
