<# Read-only sampler. No command lines, process launches, or process termination. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][int]$RootProcessId,
    [int[]]$AdditionalRootProcessId = @(),
    [ValidateRange(1, 600)][int]$Samples = 5,
    [ValidateRange(100, 60000)][int]$IntervalMs = 1000,
    [string]$Scenario = 'sampler-smoke-uncontrolled',
    [Parameter(Mandatory)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$sampleRoots = @($RootProcessId) + $AdditionalRootProcessId | Select-Object -Unique
$rootIdentity = @{}
foreach ($sampleRoot in $sampleRoots) {
    $rootProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$sampleRoot"
    if ($null -eq $rootProcess) { throw "Missing root process: $sampleRoot" }
    $rootIdentity[$sampleRoot] = $rootProcess.CreationDate
}
$measurements = @()
$sampleClock = [Diagnostics.Stopwatch]::StartNew()
for ($sampleIndex = 0; $sampleIndex -lt $Samples; $sampleIndex++) {
    $processRows = @(Get-CimInstance Win32_Process |
        Select-Object ProcessId, ParentProcessId, Name, CreationDate)
    foreach ($sampleRoot in $sampleRoots) {
        $currentRoot = $processRows | Where-Object ProcessId -eq $sampleRoot
        if ($null -eq $currentRoot -or $currentRoot.CreationDate -ne $rootIdentity[$sampleRoot]) {
            throw "Root exited or PID reused: $sampleRoot; discard incomplete run"
        }
    }
    $included = [Collections.Generic.HashSet[int]]::new()
    foreach ($sampleRoot in $sampleRoots) { [void]$included.Add($sampleRoot) }
    do {
        $added = $false
        foreach ($processRow in $processRows) {
            if ($included.Contains([int]$processRow.ParentProcessId) -and
                -not $included.Contains([int]$processRow.ProcessId)) {
                $parentRow = $processRows | Where-Object ProcessId -eq $processRow.ParentProcessId
                if ($processRow.CreationDate -ge $parentRow.CreationDate) {
                    [void]$included.Add([int]$processRow.ProcessId)
                    $added = $true
                }
            }
        }
    } while ($added)
    $privateWorkingSets = @{}
    Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object {
        $privateWorkingSets[[int]$_.IDProcess] = [long]$_.WorkingSetPrivate
    }
    $rows = @($processRows | Where-Object { $included.Contains([int]$_.ProcessId) } |
        ForEach-Object {
            $processNumber = [int]$_.ProcessId
            [pscustomobject]@{
                processId = $processNumber
                parentProcessId = [int]$_.ParentProcessId
                name = $_.Name
                createdAt = $_.CreationDate.ToUniversalTime().ToString('o')
                privateWorkingSetBytes = $privateWorkingSets[$processNumber]
            }
        })
    $missing = @($rows | Where-Object { $null -eq $_.privateWorkingSetBytes })
    $totalBytes = if ($missing.Count -eq 0) {
        [long]($rows | Measure-Object privateWorkingSetBytes -Sum).Sum
    } else { $null }
    $measurements += [pscustomobject]@{
        at = [DateTime]::UtcNow.ToString('o')
        elapsedMs = $sampleClock.ElapsedMilliseconds
        processCount = $rows.Count
        complete = ($missing.Count -eq 0)
        totalPrivateWorkingSetBytes = $totalBytes
        processes = $rows
    }
    if ($sampleIndex -lt $Samples - 1) { Start-Sleep -Milliseconds $IntervalMs }
}
$machineOs = Get-CimInstance Win32_OperatingSystem
$report = [ordered]@{
    schemaVersion = 1
    scenario = $Scenario
    formalBaseline = $false
    rootProcessIds = @($sampleRoots)
    metric = 'Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate'
    limitations = @('Non-atomic process/performance snapshots; retry incomplete samples.',
        'Detached daemons must be supplied as additional roots after independent identification.',
        'Includes descendant shells and tools; compare identical workloads.',
        'Private working set excludes shared pages; this is not total physical memory.',
        'No cold-start, frame-rate, input-latency, DPI, or CPU-wakeup measurement.')
    machine = @{
        os = $machineOs.Caption
        version = $machineOs.Version
        build = $machineOs.BuildNumber
        physicalMemoryKiB = [long]$machineOs.TotalVisibleMemorySize
        cpu = @((Get-CimInstance Win32_Processor).Name)
        gpu = @((Get-CimInstance Win32_VideoController).Name)
    }
    samples = $measurements
}
$sampleDestination = [IO.Path]::GetFullPath($OutputPath)
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($sampleDestination))
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $sampleDestination -Encoding utf8
Write-Output "Saved $($measurements.Count) samples to $sampleDestination (formalBaseline=false)"
