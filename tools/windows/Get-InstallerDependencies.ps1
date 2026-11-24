#Requires -Version 5.1
param([Parameter(Mandatory = $true)][string] $Destination)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$null = New-Item -ItemType Directory -Path $Destination -Force
$Destination = (Resolve-Path -LiteralPath $Destination).Path

# Official Windows 10+ build at https://nssm.cc/download. The pinned SHA-256 was
# computed after checking the upstream SHA-1 ca2f6782a05af85facf9b620e047b01271edd11d.
$archive = Join-Path $Destination 'nssm-2.24-101-g897c7ad.zip'
if (!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://www.nssm.cc/ci/nssm-2.24-101-g897c7ad.zip' -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine '99f5045fffbffb745d67fe3a065a953c4a3d9c253b868892d9b685b0ee7d07b8') {
    throw 'NSSM archive checksum differs from the official published checksum. Delete the cached archive and retry.'
}
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $Destination 'nssm') -Force
Copy-Item -LiteralPath (Join-Path $Destination 'nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe') -Destination (Join-Path $Destination 'nssm.exe') -Force

$webview = Join-Path $Destination 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
if (!(Test-Path -LiteralPath $webview)) {
    # Microsoft's Evergreen standalone x64 installer, not the online bootstrapper.
    Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/?linkid=2124701' -OutFile $webview
}
$signature = Get-AuthenticodeSignature -LiteralPath $webview
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)' -or
    (Get-Item -LiteralPath $webview).Length -lt 50MB) {
    throw 'Expected the full offline WebView2 installer with a valid Microsoft signature.'
}
Write-Host "Offline dependencies are ready in $Destination"
