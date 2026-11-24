#Requires -Version 5.1
param(
    [string] $DependencyDir,
    [string] $OutputDir,
    [string] $IsccPath = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    [string] $BuildVersion = '0.1.0',
    [switch] $SkipBuild,
    [switch] $Offline
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (!$OutputDir) { $OutputDir = Join-Path $repo 'dist\windows-installer' }
$null = New-Item -ItemType Directory -Path $OutputDir -Force
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
if (!$DependencyDir) { $DependencyDir = Join-Path $OutputDir 'dependencies' }
if ($BuildVersion -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') { throw 'BuildVersion must be a numeric version, for example 0.1.0.' }
if (!(Test-Path -LiteralPath $IsccPath -PathType Leaf)) { throw 'Install Inno Setup 6 on the build machine, or pass -IsccPath.' }

Push-Location $repo
try {
    if (!$SkipBuild) {
        & cargo build --locked --release -p dispenser-service
        if ($LASTEXITCODE) { throw 'Service build failed.' }
        & npm.cmd ci
        if ($LASTEXITCODE) { throw 'Node dependency installation failed.' }
        & npm.cmd run tauri --workspace=apps/desktop -- build --no-bundle
        if ($LASTEXITCODE) { throw 'Desktop build failed.' }
    }
    if (!$Offline) { & (Join-Path $PSScriptRoot 'Get-InstallerDependencies.ps1') -Destination $DependencyDir }
    $payload = Join-Path $OutputDir ('payload-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $payload
    $sources = @{
        'dispenser-service.exe' = Join-Path $repo 'target\release\dispenser-service.exe'
        'azs-desktop.exe' = Join-Path $repo 'target\release\azs-desktop.exe'
        'nssm.exe' = Join-Path $DependencyDir 'nssm.exe'
        'Launch-Desktop.ps1' = Join-Path $PSScriptRoot 'Launch-Desktop.ps1'
    }
    foreach ($name in $sources.Keys) {
        if (!(Test-Path -LiteralPath $sources[$name] -PathType Leaf)) { throw "Build input missing: $($sources[$name])" }
        Copy-Item -LiteralPath $sources[$name] -Destination (Join-Path $payload $name)
    }
    if ((Get-FileHash -LiteralPath (Join-Path $payload 'nssm.exe') -Algorithm SHA256).Hash -ine
        'eee9c44c29c2be011f1f1e43bb8c3fca888cb81053022ec5a0060035de16d848') {
        throw 'Use the tested official NSSM 2.24-101 win64 executable.'
    }
    $files = @($sources.Keys | Sort-Object | ForEach-Object {
        @{ name = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $payload $_) -Algorithm SHA256).Hash }
    })
    @{ version = $BuildVersion; files = $files } | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $payload 'payload.json') -Encoding UTF8
    & $IsccPath "/DPayloadDir=$payload" "/DOutputDir=$OutputDir" "/DBuildVersion=$BuildVersion" (Join-Path $PSScriptRoot 'StationInstaller.iss')
    if ($LASTEXITCODE) { throw 'Installer compilation failed.' }
    $installer = Join-Path $OutputDir "AZS-Station-Setup-$BuildVersion-x64.exe"
    "$((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash)  $([IO.Path]::GetFileName($installer))" |
        Set-Content -LiteralPath "$installer.sha256" -Encoding ASCII
    Write-Host "Offline station installer: $installer"
} finally { Pop-Location }
