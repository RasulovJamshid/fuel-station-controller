#Requires -Version 5.1
param([Parameter(Mandatory = $true)][string] $Destination)
$ErrorActionPreference = 'Stop'
$null = New-Item -ItemType Directory -Path $Destination -Force
$Destination = (Resolve-Path -LiteralPath $Destination).Path

# Keep the small public-domain wrapper in the repository: the official download
# server is intermittently unavailable. Provenance and hashes are in vendor/README.md.
$nssm = Join-Path $PSScriptRoot 'vendor\nssm.exe'
if ((Get-FileHash -LiteralPath $nssm -Algorithm SHA256).Hash -ine 'eee9c44c29c2be011f1f1e43bb8c3fca888cb81053022ec5a0060035de16d848') {
    throw 'The bundled NSSM executable differs from the verified upstream build.'
}
Copy-Item -LiteralPath $nssm -Destination (Join-Path $Destination 'nssm.exe') -Force

Write-Host "Offline dependencies are ready in $Destination"
