<# Independent receiver validates the other direction without starting the product. #>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$pocRoot = Split-Path $PSScriptRoot -Parent
$binary = Join-Path $pocRoot 'target/release/poc-window.exe'
$namespace = 'com.cli-manager.gpui-poc.' + [Guid]::NewGuid().ToString('N')
$resultRoot = Join-Path $PSScriptRoot 'results/window'
[void][IO.Directory]::CreateDirectory($resultRoot)
$peerName = [Guid]::NewGuid().ToString('N')
$ready = Join-Path $resultRoot "$peerName.ready.json"
$output = Join-Path $resultRoot "$peerName.peer.json"
$report = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); namespace = $namespace
    passed = $false; realTauriInteropVerified = $false; peerImplementation = 'Python ctypes / Win32'
    sourceProtocol = 'tauri-plugin-single-instance 2.4.2 / Windows'; checks = [ordered]@{} }
$peer = $null
$sender = $null
function Assert-Interop([bool]$Condition, [string]$Name) {
    $report.checks[$Name] = $Condition
    if (-not $Condition) { throw "Interop assertion: $Name" }
}
try {
    $python = (Get-Command python).Source
    # Hidden helpers; the sender must exit before it initializes GPUI.
    $peer = Start-Process $python -ArgumentList @(
        ('"' + (Join-Path $PSScriptRoot 'SingleInstancePeer.py') + '"'), '--namespace', $namespace,
        '--ready', ('"' + $ready + '"'), '--output', ('"' + $output + '"')) -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $resultRoot "$peerName.peer.stdout.log") `
        -RedirectStandardError (Join-Path $resultRoot "$peerName.peer.stderr.log")
    $null = $peer.Handle
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $ready) -and -not $peer.HasExited -and $clock.ElapsedMilliseconds -lt 4000) { Start-Sleep -Milliseconds 30 }
    Assert-Interop (Test-Path -LiteralPath $ready) 'independentReceiverReady'
    Assert-Interop ((Get-Content $ready -Raw -Encoding UTF8 | ConvertFrom-Json).pid -eq $peer.Id) 'receiverPidMatches'
    $senderLog = Join-Path $resultRoot "$peerName.sender.stdout.log"
    $sender = Start-Process $binary -ArgumentList @('--window', '--namespace', $namespace, '独立接收端🙂') `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $senderLog `
        -RedirectStandardError (Join-Path $resultRoot "$peerName.sender.stderr.log")
    $null = $sender.Handle
    Assert-Interop ($sender.WaitForExit(5000)) 'gpuiSenderExited'
    Assert-Interop ($sender.ExitCode -eq 0) 'gpuiSenderSucceeded'
    Assert-Interop ($peer.WaitForExit(5000)) 'independentReceiverExited'
    Assert-Interop ($peer.ExitCode -eq 0) 'independentReceiverSucceeded'
    $evidence = Get-Content $output -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Interop ($evidence.received.Count -eq 1) 'receivedExactlyOnce'
    Assert-Interop ($evidence.received[0].argv[-1] -eq '独立接收端🙂') 'unicodeArgvMatches'
    Assert-Interop ($evidence.received[0].cwd -eq (Get-Location).Path) 'cwdMatches'
    Assert-Interop ($evidence.destroyed -and $evidence.unregistered -and $evidence.released -and $evidence.closed) 'peerResourcesReleased'
    $log = Get-Content $senderLog -Raw -Encoding UTF8
    Assert-Interop ($log -match 'single-instance: forwarded' -and $log -notmatch 'primary receiver=|main: hwnd=') 'senderDidNotInitializeWindow'
    $report.peerEvidence = [IO.Path]::GetFileName($output)
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    foreach ($process in @($sender, $peer)) {
        if ($null -ne $process) {
            if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
            $process.Dispose()
        }
    }
    $report | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $resultRoot 'interop.json') -Encoding utf8
}
Write-Output 'Isolated protocol reverse-direction exercise passed (not real Tauri interop)'
