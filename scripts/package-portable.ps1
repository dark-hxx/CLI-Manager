[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$SourceDir = "src-tauri/target/release",
    [string]$OutputDir = "dist/portable",
    [string]$ResourcesDir = "src-tauri/resources",
    [string]$WebDistDir = "apps/web/dist"
)

$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

# 二进制与资源来自各自生产者；所有相对输入均相对仓库根解析，不依赖调用者工作目录。
function Resolve-PortablePath([string]$InputPath) {
    if ([System.IO.Path]::IsPathRooted($InputPath)) {
        return [System.IO.Path]::GetFullPath($InputPath)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $InputPath))
}
$resolvedSourceDir = Resolve-PortablePath $SourceDir
$resolvedOutputDir = Resolve-PortablePath $OutputDir
$resourcesDir = Resolve-PortablePath $ResourcesDir
$webDistDir = Resolve-PortablePath $WebDistDir

$normalizedVersion = $Version.Trim().TrimStart([char[]]@("V", "v"))
if ($normalizedVersion -notmatch "^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$") {
    throw "Invalid release version: $Version"
}

$executableNames = @(
    "cli-manager.exe",
    "cli-manager-codex-proxy.exe",
    "cli-manager-daemon.exe",
    "cli-manager-web-daemon.exe"
)
foreach ($relativePath in $executableNames) {
    $requiredPath = Join-Path $resolvedSourceDir $relativePath
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Missing portable package input: $requiredPath"
    }
}
foreach ($relativePath in @("index.html", "tap/index.html")) {
    $requiredPath = Join-Path $webDistDir $relativePath
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Missing portable package input: $requiredPath"
    }
}
foreach ($requiredPath in @($resourcesDir, (Join-Path $webDistDir "assets"), (Join-Path $webDistDir "tap/assets"))) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Container)) {
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
foreach ($name in $executableNames) {
    Copy-Item -LiteralPath (Join-Path $resolvedSourceDir $name) -Destination (Join-Path $stagingFullPath $name)
}
Copy-Item -LiteralPath $resourcesDir -Destination (Join-Path $stagingFullPath "resources") -Recurse
$webDestination = Join-Path $stagingFullPath "apps/web"
New-Item -ItemType Directory -Path $webDestination -Force | Out-Null
Copy-Item -LiteralPath $webDistDir -Destination (Join-Path $webDestination "dist") -Recurse
New-Item -ItemType File -Path (Join-Path $stagingFullPath "portable.flag") | Out-Null

Compress-Archive -LiteralPath $stagingFullPath -DestinationPath $archiveFullPath -CompressionLevel Optimal
Write-Output $archiveFullPath
