#Requires -Version 5.1
param([Parameter(Mandatory = $true)][string] $Destination)
$ErrorActionPreference = 'Stop'
# PowerShell 5.1's per-buffer progress reporting makes large CI downloads very slow.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$null = New-Item -ItemType Directory -Path $Destination -Force
$Destination = (Resolve-Path -LiteralPath $Destination).Path

# Keep the small public-domain wrapper in the repository: the official download
# server is intermittently unavailable. Provenance and hashes are in vendor/README.md.
$nssm = Join-Path $PSScriptRoot 'vendor\nssm.exe'
if ((Get-FileHash -LiteralPath $nssm -Algorithm SHA256).Hash -ine 'eee9c44c29c2be011f1f1e43bb8c3fca888cb81053022ec5a0060035de16d848') {
    throw 'The bundled NSSM executable differs from the verified upstream build.'
}
Copy-Item -LiteralPath $nssm -Destination (Join-Path $Destination 'nssm.exe') -Force

$webview = Join-Path $Destination 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
if (!(Test-Path -LiteralPath $webview)) {
    # Microsoft's Evergreen standalone x64 installer, not the online bootstrapper.
    Write-Host 'Downloading the full offline WebView2 runtime...'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/?linkid=2124701' -OutFile "$webview.partial" -TimeoutSec 300
    Move-Item -LiteralPath "$webview.partial" -Destination $webview -Force
}
$signature = Get-AuthenticodeSignature -LiteralPath $webview
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)' -or
    (Get-Item -LiteralPath $webview).Length -lt 50MB) {
    throw 'Expected the full offline WebView2 installer with a valid Microsoft signature.'
}
Write-Host "Offline dependencies are ready in $Destination"
