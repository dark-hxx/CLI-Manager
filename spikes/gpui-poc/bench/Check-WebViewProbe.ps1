<# Read-only P8 experiment. Only launches and observes its own isolated probe. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$LoaderPath,
    [string]$OutputName = 'webview-probe-p8'
)
$ErrorActionPreference = 'Stop'
if ($OutputName -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid output name' }
$pocRoot = Split-Path $PSScriptRoot -Parent
$binary = Join-Path $pocRoot 'target/release/poc-webview-probe.exe'
$loader = (Resolve-Path -LiteralPath $LoaderPath).Path
if ([IO.Path]::GetFileName($loader) -ine 'WebView2Loader.dll' -or $loader.Contains('"')) {
    throw 'An explicit WebView2Loader.dll path is required'
}
$results = Join-Path $PSScriptRoot 'results'
[void][IO.Directory]::CreateDirectory($results)
$stdout = Join-Path $results "$OutputName.stdout.jsonl"
$stderr = Join-Path $results "$OutputName.stderr.log"
$process = Start-Process -FilePath $binary -ArgumentList @('--probe', '--loader',
    ('"' + $loader + '"'), '--hold-ms', '2000') -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$null = $process.Handle # Retain the handle for reliable ExitCode on Windows PowerShell.
$snapshots = @{}
$watch = [Diagnostics.Stopwatch]::StartNew()
try {
    do {
        $lines = @(Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue)
        if ($lines.Count -gt 0) {
            # Each phase is flushed before a bounded hold. Confirm it did not
            # change while reading modules, otherwise wait for the next poll.
            try { $last = $lines[-1] | ConvertFrom-Json } catch { $last = $null }
            if ($null -ne $last -and -not $snapshots.ContainsKey($last.event)) {
                $candidate = Get-Process -Id $process.Id -ErrorAction Stop
                try {
                    $modules = @($candidate.Modules | Where-Object {
                        $_.ModuleName -ieq 'WebView2Loader.dll'
                    } | ForEach-Object { $_.FileName })
                } finally { $candidate.Dispose() }
                $latestLines = @(Get-Content -LiteralPath $stdout)
                if ($lines.Count -eq $latestLines.Count) {
                    $snapshots[$last.event] = [pscustomobject]@{
                        phase = $last.event; loaderLoaded = $modules.Count -gt 0
                        modulePaths = @($modules); elapsedMs = $watch.ElapsedMilliseconds
                    }
                }
            }
        }
        if ($snapshots.Count -ge 3) { break }
        Start-Sleep -Milliseconds 50
        $process.Refresh()
    } while (-not $process.HasExited -and $watch.ElapsedMilliseconds -lt 12000)
    if (-not $process.WaitForExit(5000)) { throw 'Probe did not exit on time' }
    if ($process.ExitCode -ne 0) { throw "Probe failed: $($process.ExitCode)" }
    $events = @(Get-Content -LiteralPath $stdout | ForEach-Object { $_ | ConvertFrom-Json })
    $result = @($events | Where-Object event -eq 'result')
    $passed = $snapshots.ContainsKey('before_probe') -and $snapshots.ContainsKey('loader_loaded') -and
        $snapshots.ContainsKey('result') -and -not $snapshots['before_probe'].loaderLoaded -and
        $snapshots['loader_loaded'].loaderLoaded -and -not $snapshots['result'].loaderLoaded -and
        $result.Count -eq 1 -and $result[0].p8BeforePassed -and
        -not $result[0].afterLoaderLoaded -and $result[0].probe.duringLoaderLoaded
    $report = [pscustomobject]@{
        processId = $process.Id; passed = $passed; loaderSha256 = (Get-FileHash -LiteralPath $loader).Hash
        loaderSource = $loader; observations = @($snapshots.Values | Sort-Object elapsedMs)
        result = $result; formalPerformance = $false
        scope = 'Standalone dynamic-loader probe; production integration and abnormal-runtime VMs untested'
    }
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $results "$OutputName.json") -Encoding UTF8
    if (-not $passed) { throw 'P8 module phases were not all verified; inspect the report' }
    Write-Output "P8 module phases passed: $(Join-Path $results "$OutputName.json")"
} finally {
    $process.Refresh()
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
}
