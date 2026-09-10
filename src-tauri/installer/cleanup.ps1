param(
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [string]$DiscoveryDirectory = (Join-Path $env:USERPROFILE '.cli-manager')
)

$ErrorActionPreference = 'Stop'

function Get-InstalledProcesses([string[]]$ExecutablePaths) {
    # An inaccessible process path is never guessed from its name.
    $names = @($ExecutablePaths | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_) } | Select-Object -Unique)
    @(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ($_.Path -and $ExecutablePaths -contains [IO.Path]::GetFullPath($_.Path)) { $_ }
        } catch { }
    })
}

function Stop-VerifiedProcess($Process, [string[]]$ExecutablePaths) {
    # Re-open the process and compare both identity and path immediately before
    # termination so a recycled PID cannot target another installation.
    try {
        $current = Get-Process -Id $Process.Id -ErrorAction Stop
        if ($current.StartTime -eq $Process.StartTime -and
            $ExecutablePaths -contains [IO.Path]::GetFullPath($current.Path)) {
            $current.Kill()
            if (-not $current.WaitForExit(2000)) { throw 'Process did not exit.' }
        }
    } catch {
        if (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue) { throw }
    }
}

function Request-DaemonShutdown([string]$InfoFile, [string]$ExecutablePath, [bool]$IsWeb) {
    if (-not (Test-Path -LiteralPath $InfoFile)) { return }
    $client = $null
    try {
        $info = Get-Content -LiteralPath $InfoFile -Raw | ConvertFrom-Json
        $owner = Get-Process -Id ([int]$info.pid) -ErrorAction Stop
        if ([IO.Path]::GetFullPath($owner.Path) -ine $ExecutablePath) { return }
        $client = New-Object Net.Sockets.TcpClient
        $connect = $client.BeginConnect('127.0.0.1', [int]$info.port, $null, $null)
        try {
            if (-not $connect.AsyncWaitHandle.WaitOne(500)) { return }
            $client.EndConnect($connect)
        } finally { $connect.AsyncWaitHandle.Close() }
        $stream = $client.GetStream()
        $stream.ReadTimeout = 700
        $stream.WriteTimeout = 700
        $writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding($false)))
        $writer.AutoFlush = $true
        $reader = New-Object IO.StreamReader($stream)
        $auth = @{ type = 'auth'; token = $info.token; client_version = '1.3.9' }
        if ($IsWeb) { $auth.protocol_version = [int]$info.protocolVersion }
        $writer.WriteLine(($auth | ConvertTo-Json -Compress))
        if (-not $IsWeb) {
            $response = $reader.ReadLine() | ConvertFrom-Json
            if ($response.type -ne 'auth_ok') { return }
            # Existing PTY protocol only exits when sessions and routing stop.
            $writer.WriteLine('{"type":"close_all","id":1}')
            $writer.WriteLine('{"type":"routing_stop","id":2}')
        }
        $writer.WriteLine('{"type":"shutdown","id":3}')
        # Keep the socket alive until acknowledgement, EOF, or bounded timeout.
        for ($i = 0; $i -lt 4; $i++) {
            $line = $reader.ReadLine()
            if (-not $line -or $IsWeb) { break }
            if (($line | ConvertFrom-Json).id -eq 3) { break }
        }
    } catch {
        # Missing/stale discovery and unresponsive old protocols fall back to
        # verified executable paths. Never log discovery contents or tokens.
        Write-Output 'Graceful daemon shutdown unavailable; checking installed process paths.'
    } finally {
        if ($client) { $client.Dispose() }
    }
}

function Invoke-InstallationCleanup {
    $installRoot = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\', '/')
    if (-not [IO.Path]::IsPathRooted($InstallDirectory) -or
        $installRoot -eq [IO.Path]::GetPathRoot($installRoot).TrimEnd('\', '/') -or
        $installRoot -eq [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\', '/')) {
        throw 'Invalid installation directory.'
    }
    $mainPath = Join-Path $installRoot 'cli-manager.exe'
    $webPath = Join-Path $installRoot 'cli-manager-web-daemon.exe'
    $ptyPath = Join-Path $installRoot 'cli-manager-daemon.exe'
    $paths = @($mainPath, $webPath, $ptyPath,
        (Join-Path $installRoot 'cli-manager-codex-proxy.exe'),
        (Join-Path $installRoot 'resources\conpty\OpenConsole.exe'),
        (Join-Path $installRoot 'resources\conpty\x64\OpenConsole.exe'),
        (Join-Path $installRoot 'resources\conpty\x86\OpenConsole.exe'),
        (Join-Path $installRoot 'resources\conpty\arm64\OpenConsole.exe'))

    # Stop the UI first so its reconnect loop cannot respawn a daemon while
    # files are being replaced. CloseMainWindow may only minimize to tray.
    $mainProcesses = @(Get-InstalledProcesses @($mainPath))
    foreach ($process in $mainProcesses) { [void]$process.CloseMainWindow() }
    foreach ($process in $mainProcesses) {
        if (-not $process.WaitForExit(1500)) { Stop-VerifiedProcess $process @($mainPath) }
    }
    Request-DaemonShutdown (Join-Path $DiscoveryDirectory 'web-daemon.json') $webPath $true
    Request-DaemonShutdown (Join-Path $DiscoveryDirectory 'daemon.json') $ptyPath $false

    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        $remaining = @(Get-InstalledProcesses $paths)
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    foreach ($process in $remaining) { Stop-VerifiedProcess $process $paths }
    if (@(Get-InstalledProcesses $paths).Count -ne 0) {
        throw 'Installed CLI-Manager processes are still running.'
    }
    # User data and discovery files are preserved; their owners manage them.
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-InstallationCleanup; exit 0 }
    catch { Write-Error 'CLI-Manager installation cleanup failed.'; exit 1 }
}
