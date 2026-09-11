[CmdletBinding()]
param(
    [string]$AdminPassword = $env:CLI_MANAGER_ADMIN_PASSWORD,
    [ValidateRange(1, 65535)]
    [int]$FrontendPort = 5173,
    [ValidateRange(1, 65535)]
    [int]$BackendPort = 8787,
    [string]$BackendHost = "127.0.0.1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Stop-PortListener {
    param(
        [Parameter(Mandatory)]
        [int]$Port
    )

    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        Write-Host "Port $Port is available."
        return
    }

    $processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($processId in $processIds) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            continue
        }

        Write-Host "Stopping $($process.ProcessName) (PID $processId) on port $Port..."
        Stop-Process -Id $processId -Force
    }

    $deadline = (Get-Date).AddSeconds(5)
    do {
        $remaining = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
        if ($remaining.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)

    throw "Port $Port is still occupied after stopping its listener."
}

function Wait-HttpEndpoint {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$Uri,

        [int]$TimeoutSeconds = 120
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = "No response"
    do {
        try {
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                Write-Host "$Name is ready: $Uri"
                return
            }
            $lastError = "HTTP $($response.StatusCode)"
        }
        catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw "$Name did not become ready within $TimeoutSeconds seconds. Last error: $lastError"
}

function Format-HostForUri {
    param(
        [Parameter(Mandatory)]
        [string]$HostName
    )

    if ($HostName.Contains(":") -and -not $HostName.StartsWith("[")) {
        return "[$HostName]"
    }
    return $HostName
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $projectRoot "apps\web"
Set-Location -LiteralPath $projectRoot
$backendBindHost = Format-HostForUri -HostName $BackendHost
$backendBind = "$backendBindHost`:$BackendPort"
$backendProbeHost = if ($BackendHost -in @("0.0.0.0", "::")) { "127.0.0.1" } else { $BackendHost }
$backendProbeUriHost = Format-HostForUri -HostName $backendProbeHost

Stop-PortListener -Port $FrontendPort
Stop-PortListener -Port $BackendPort

$viteCache = Join-Path $projectRoot "apps\web\node_modules\.vite"
if (Test-Path -LiteralPath $viteCache) {
    Write-Host "Removing stale Vite cache..."
    Remove-Item -LiteralPath $viteCache -Recurse -Force
}

if ([string]::IsNullOrWhiteSpace($AdminPassword)) {
    $securePassword = Read-Host "CLI-Manager admin password" -AsSecureString
    $credential = [pscredential]::new("admin", $securePassword)
    $AdminPassword = $credential.GetNetworkCredential().Password
}

if ([string]::IsNullOrWhiteSpace($AdminPassword)) {
    throw "CLI_MANAGER_ADMIN_PASSWORD cannot be empty."
}

$shellPath = (Get-Process -Id $PID).Path
$previousPassword = [Environment]::GetEnvironmentVariable(
    "CLI_MANAGER_ADMIN_PASSWORD",
    [EnvironmentVariableTarget]::Process
)
$previousBind = [Environment]::GetEnvironmentVariable(
    "CLI_MANAGER_WEB_BIND",
    [EnvironmentVariableTarget]::Process
)
$previousPort = [Environment]::GetEnvironmentVariable(
    "CLI_MANAGER_WEB_PORT",
    [EnvironmentVariableTarget]::Process
)
$previousWebTarget = [Environment]::GetEnvironmentVariable(
    "VITE_WEB_SERVER_URL",
    [EnvironmentVariableTarget]::Process
)

try {
    [Environment]::SetEnvironmentVariable(
        "CLI_MANAGER_ADMIN_PASSWORD",
        $AdminPassword,
        [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        "CLI_MANAGER_WEB_BIND",
        $backendBind,
        [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        "CLI_MANAGER_WEB_PORT",
        [string]$BackendPort,
        [EnvironmentVariableTarget]::Process
    )
    $backend = Start-Process `
        -FilePath $shellPath `
        -WorkingDirectory $projectRoot `
        -ArgumentList @("-NoExit", "-NoProfile", "-Command", "npm run web:server:run") `
        -PassThru

    [Environment]::SetEnvironmentVariable(
        "VITE_WEB_SERVER_URL",
        "http://$backendProbeUriHost`:$BackendPort",
        [EnvironmentVariableTarget]::Process
    )
    # npm.ps1 consumes the standalone `--`, turning Vite options into positional arguments.
    $frontendCommand = "npm.cmd run dev -- --host 127.0.0.1 --port $FrontendPort --strictPort"
    $frontend = Start-Process `
        -FilePath $shellPath `
        -WorkingDirectory $webRoot `
        -ArgumentList @("-NoExit", "-NoProfile", "-Command", $frontendCommand) `
        -PassThru

    Wait-HttpEndpoint -Name "Backend" -Uri "http://$backendProbeUriHost`:$BackendPort/api/health"
    Wait-HttpEndpoint -Name "Frontend" -Uri "http://127.0.0.1:$FrontendPort/"
    Write-Host "Backend PID: $($backend.Id)"
    Write-Host "Frontend PID: $($frontend.Id)"
}
finally {
    [Environment]::SetEnvironmentVariable(
        "CLI_MANAGER_ADMIN_PASSWORD",
        $previousPassword,
        [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        "CLI_MANAGER_WEB_BIND",
        $previousBind,
        [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        "CLI_MANAGER_WEB_PORT",
        $previousPort,
        [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        "VITE_WEB_SERVER_URL",
        $previousWebTarget,
        [EnvironmentVariableTarget]::Process
    )
}
