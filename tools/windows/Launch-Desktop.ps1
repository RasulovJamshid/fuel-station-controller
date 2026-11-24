# Runs as the logged-in operator, not as Administrator or LocalSystem.
$ErrorActionPreference = 'Stop'
try {
    $record = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'station-install.json') -Raw | ConvertFrom-Json
    $config = Get-Content -LiteralPath $record.config_path -Raw | ConvertFrom-Json
    $port = [int]$config.service.port
    if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid local service port in the station configuration.' }
    $env:AZS_SERVICE_URL = "http://127.0.0.1:$port"
    Start-Process -FilePath (Join-Path $PSScriptRoot 'azs-desktop.exe') -WorkingDirectory $PSScriptRoot
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.ToString(), 'AZS Manager could not start') | Out-Null
    exit 1
}
