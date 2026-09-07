[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$SourceDir = "src-tauri/target/release",
    [string]$OutputDir = "dist/portable"
)

$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$resolvedSourceDir = if ([System.IO.Path]::IsPathRooted($SourceDir)) {
    [System.IO.Path]::GetFullPath($SourceDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $SourceDir))
}
$resolvedOutputDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    [System.IO.Path]::GetFullPath($OutputDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDir))
}

$normalizedVersion = $Version.Trim().TrimStart([char[]]@("V", "v"))
if ($normalizedVersion -notmatch "^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$") {
    throw "Invalid release version: $Version"
}

$mainExecutable = Join-Path $resolvedSourceDir "cli-manager.exe"
$proxyExecutable = Join-Path $resolvedSourceDir "cli-manager-codex-proxy.exe"
$resourcesDir = Join-Path $resolvedSourceDir "resources"
foreach ($requiredPath in @($mainExecutable, $proxyExecutable, $resourcesDir)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Missing portable package input: $requiredPath"
    }
}

New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null
$stagingDir = Join-Path $resolvedOutputDir "CLI-Manager"
$archivePath = Join-Path $resolvedOutputDir "CLI-Manager-V$normalizedVersion-Windows-x64-portable.zip"

$outputPrefix = $resolvedOutputDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$stagingFullPath = [System.IO.Path]::GetFullPath($stagingDir)
$archiveFullPath = [System.IO.Path]::GetFullPath($archivePath)
if (-not $stagingFullPath.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable staging path escaped the output directory: $stagingFullPath"
}
if (-not $archiveFullPath.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable archive path escaped the output directory: $archiveFullPath"
}

if (Test-Path -LiteralPath $stagingFullPath) {
    Remove-Item -LiteralPath $stagingFullPath -Recurse -Force
}
if (Test-Path -LiteralPath $archiveFullPath) {
    Remove-Item -LiteralPath $archiveFullPath -Force
}

New-Item -ItemType Directory -Path $stagingFullPath | Out-Null
Copy-Item -LiteralPath $mainExecutable -Destination (Join-Path $stagingFullPath "cli-manager.exe")
Copy-Item -LiteralPath $proxyExecutable -Destination (Join-Path $stagingFullPath "cli-manager-codex-proxy.exe")
Copy-Item -LiteralPath $resourcesDir -Destination (Join-Path $stagingFullPath "resources") -Recurse
New-Item -ItemType File -Path (Join-Path $stagingFullPath "portable.flag") | Out-Null

Compress-Archive -LiteralPath $stagingFullPath -DestinationPath $archiveFullPath -CompressionLevel Optimal
Write-Output $archiveFullPath
