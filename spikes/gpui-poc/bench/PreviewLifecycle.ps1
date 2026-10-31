# Dot-sourced only by Invoke-WindowSmoke.ps1; all operations target its own GUI PID/HWND.
function Get-PocDescendants([int]$RootProcessId) {
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $parents = @($RootProcessId)
    $seen = @{}
    while ($parents.Count -gt 0) {
        $children = @($all | Where-Object { $_.ParentProcessId -in $parents -and
            -not $seen.ContainsKey([int]$_.ProcessId) })
        $parents = @()
        foreach ($child in $children) {
            $childId = [int]$child.ProcessId
            $seen[$childId] = $true
            $parents += $childId
            $childProcess = Get-Process -Id $childId -ErrorAction SilentlyContinue
            if ($null -ne $childProcess) {
                try {
                    [pscustomobject]@{ processId = $childId; name = $childProcess.ProcessName
                        startTicks = $childProcess.StartTime.ToUniversalTime().Ticks }
                } finally { $childProcess.Dispose() }
            }
        }
    }
}

function Invoke-PocPreviewLifecycle([IntPtr]$WindowHandle) {
    $before = [PocWindowCapture+Rect]::new()
    if (-not [PocWindowCapture]::GetPhysicalWindowRect($WindowHandle, [ref]$before)) {
        throw 'Lifecycle: initial window rectangle unavailable'
    }
    # Change only the owned test window. Keep its position and stay within the original size.
    $width = [Math]::Max(600, $before.Right - $before.Left - 160)
    $height = [Math]::Max(400, $before.Bottom - $before.Top - 100)
    if (-not [PocWindowCapture]::MovePhysicalWindow($WindowHandle, $before.Left, $before.Top,
        $width, $height)) { throw 'Lifecycle: resize failed' }
    Start-Sleep -Milliseconds 350
    $after = [PocWindowCapture+Rect]::new()
    if (-not [PocWindowCapture]::GetPhysicalWindowRect($WindowHandle, [ref]$after) -or
        $after.Right - $after.Left -ne $width -or $after.Bottom - $after.Top -ne $height) {
        throw 'Lifecycle: resized window rectangle does not match request'
    }
    [void][PocWindowCapture]::ShowWindow($WindowHandle, 6) # SW_MINIMIZE
    Start-Sleep -Milliseconds 350
    if (-not [PocWindowCapture]::IsIconic($WindowHandle)) { throw 'Lifecycle: not minimized' }
    [void][PocWindowCapture]::ShowWindow($WindowHandle, 9) # SW_RESTORE
    Start-Sleep -Milliseconds 350
    if ([PocWindowCapture]::IsIconic($WindowHandle) -or
        -not [PocWindowCapture]::IsWindowVisible($WindowHandle)) {
        throw 'Lifecycle: not visibly restored'
    }
    $restored = [PocWindowCapture+Rect]::new()
    if (-not [PocWindowCapture]::GetPhysicalWindowRect($WindowHandle, [ref]$restored)) {
        throw 'Lifecycle: restored rectangle unavailable'
    }
    if ($restored.Right - $restored.Left -ne $width -or
        $restored.Bottom - $restored.Top -ne $height) {
        throw 'Lifecycle: restored window lost its resized dimensions'
    }
    [pscustomobject]@{ resizedWidth = $width; resizedHeight = $height
        restoredWidth = $restored.Right - $restored.Left
        restoredHeight = $restored.Bottom - $restored.Top
        coordinateSpace = 'Win32 caller DPI context; surface PNG uses physical pixels'
        minimized = $true; restored = $true; dpiChanged = $false; focusVerified = $false }
}

function Wait-PocDescendantsExit($Observed) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $remaining = @()
        foreach ($item in $Observed) {
            $candidate = Get-Process -Id $item.processId -ErrorAction SilentlyContinue
            if ($null -eq $candidate) { continue }
            try {
                # A reused PID is not a surviving child.
                if ($candidate.StartTime.ToUniversalTime().Ticks -eq $item.startTicks) {
                    $remaining += $item
                }
            } finally { $candidate.Dispose() }
        }
        if ($remaining.Count -gt 0) { Start-Sleep -Milliseconds 200 }
    } while ($remaining.Count -gt 0 -and $watch.ElapsedMilliseconds -lt 10000)
    [pscustomobject]@{ observed = @($Observed); remaining = @($remaining)
        postGuiExitWaitMs = $watch.ElapsedMilliseconds; deadlineMs = 10000 }
}
