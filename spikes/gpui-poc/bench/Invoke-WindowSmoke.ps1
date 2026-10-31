<# Launches only the isolated PoC; captures its window, never the desktop. #>
[CmdletBinding()]
param(
    [ValidateSet('zh-CN', 'en-US')][string]$Language = 'zh-CN',
    [ValidateSet('poc-compat', 'poc-input', 'poc-term', 'poc-preview', 'poc-window')][string]$Binary = 'poc-compat',
    [string]$FixturePath,
    [switch]$Eight,
    [switch]$Exercise,
    [switch]$PreviewLifecycle,
    [ValidateRange(0, 9)][int]$CaptureDelaySeconds = 0
)
$ErrorActionPreference = 'Stop'
$pocRoot = Split-Path $PSScriptRoot -Parent
$pocBinary = Join-Path $pocRoot "target/release/$Binary.exe"
$mediaRoot = Join-Path $pocRoot 'research/poc-media'
[void][IO.Directory]::CreateDirectory($mediaRoot)
$stdoutFile = Join-Path $mediaRoot "$Binary-$Language.stdout.log"
$stderrFile = Join-Path $mediaRoot "$Binary-$Language.stderr.log"
$imageFile = Join-Path $mediaRoot "$Binary-$Language.png"
$probeArguments = @('--smoke')
if ($PreviewLifecycle) {
    if ($Binary -ne 'poc-preview') { throw 'PreviewLifecycle requires poc-preview' }
    . (Join-Path $PSScriptRoot 'PreviewLifecycle.ps1')
    $stdoutFile = Join-Path $mediaRoot "$Binary-$Language-lifecycle.stdout.log"
    $stderrFile = Join-Path $mediaRoot "$Binary-$Language-lifecycle.stderr.log"
    $imageFile = Join-Path $mediaRoot "$Binary-$Language-lifecycle.png"
}
if ($Exercise) {
    if ($Binary -ne 'poc-input') { throw 'Exercise requires poc-input' }
    $probeArguments += '--exercise'
}
if ($Eight) {
    if ($Binary -ne 'poc-term') { throw 'Eight panes require poc-term' }
    $probeArguments += '--eight'
    $stdoutFile = Join-Path $mediaRoot "$Binary-$Language-eight.stdout.log"
    $stderrFile = Join-Path $mediaRoot "$Binary-$Language-eight.stderr.log"
    $imageFile = Join-Path $mediaRoot "$Binary-$Language-eight.png"
}
if ($FixturePath) {
    if ($Binary -notin @('poc-input', 'poc-term')) { throw 'Fixtures require input or terminal probe' }
    $resolvedFixture = (Resolve-Path -LiteralPath $FixturePath).Path
    if ($resolvedFixture.Contains('"')) { throw 'Unsupported quote in fixture path' }
    $probeArguments += @('--fixture', ('"' + $resolvedFixture + '"'))
    $fixtureName = [IO.Path]::GetFileNameWithoutExtension($resolvedFixture)
    if ($Eight) { $fixtureName += '-eight' }
    $stdoutFile = Join-Path $mediaRoot "$Binary-$Language-$fixtureName.stdout.log"
    $stderrFile = Join-Path $mediaRoot "$Binary-$Language-$fixtureName.stderr.log"
    $imageFile = Join-Path $mediaRoot "$Binary-$Language-$fixtureName.png"
}
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PocWindowCapture {
    private delegate bool EnumWindowCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    public static bool GetPhysicalWindowRect(IntPtr handle, out Rect rect) {
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        try { return GetWindowRect(handle, out rect); }
        finally { SetThreadDpiAwarenessContext(previous); }
    }
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr handle, IntPtr dc, uint flags);
    [DllImport("user32.dll")]
    public static extern bool MoveWindow(IntPtr handle, int x, int y, int width, int height, bool repaint);
    public static bool MovePhysicalWindow(IntPtr handle, int x, int y, int width, int height) {
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        try { return MoveWindow(handle, x, y, width, height, true); }
        finally { SetThreadDpiAwarenessContext(previous); }
    }
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr handle);
    public static IntPtr FindWindow(uint targetProcessId) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((handle, parameter) => {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            Rect rect;
            if (processId == targetProcessId && IsWindowVisible(handle) &&
                GetWindowRect(handle, out rect) && rect.Right - rect.Left >= 300 &&
                rect.Bottom - rect.Top >= 100) {
                found = handle;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
$previousLanguage = $env:POC_LANG
$launchedProcess = $null
try {
    $env:POC_LANG = $Language
    # This is the interactive PoC window under test, not a hidden helper process.
    $launchedProcess = Start-Process -FilePath $pocBinary -ArgumentList $probeArguments `
        -WindowStyle Normal -PassThru -RedirectStandardOutput $stdoutFile `
        -RedirectStandardError $stderrFile
    # Keep a process handle open so Windows PowerShell retains ExitCode after exit.
    $null = $launchedProcess.Handle
    $windowClock = [Diagnostics.Stopwatch]::StartNew()
    $windowHandle = [IntPtr]::Zero
    do {
        Start-Sleep -Milliseconds 100
        $launchedProcess.Refresh()
        $windowHandle = [PocWindowCapture]::FindWindow($launchedProcess.Id)
    } while (-not $launchedProcess.HasExited -and $windowHandle -eq 0 -and
        $windowClock.ElapsedMilliseconds -lt 3500)
    if ($windowHandle -eq 0) { throw 'PoC did not expose a visible window handle within 3.5s' }
    Start-Sleep -Milliseconds (200 + $CaptureDelaySeconds * 1000)
    $windowRect = [PocWindowCapture+Rect]::new()
    if (-not [PocWindowCapture]::GetPhysicalWindowRect($windowHandle, [ref]$windowRect)) {
        throw 'GetWindowRect failed'
    }
    $bitmap = [Drawing.Bitmap]::new($windowRect.Right - $windowRect.Left,
        $windowRect.Bottom - $windowRect.Top)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $deviceContext = $graphics.GetHdc()
    try {
        if (-not [PocWindowCapture]::PrintWindow($windowHandle, $deviceContext, 2)) {
            throw 'PrintWindow failed; no desktop capture fallback'
        }
    } finally { $graphics.ReleaseHdc($deviceContext) }
    try { $bitmap.Save($imageFile, [Drawing.Imaging.ImageFormat]::Png) }
    finally { $graphics.Dispose(); $bitmap.Dispose() }
    $lifecycle = $null
    $observed = @{}
    if ($PreviewLifecycle) {
        $lifecycle = Invoke-PocPreviewLifecycle -WindowHandle $windowHandle
        $lifecycleClock = [Diagnostics.Stopwatch]::StartNew()
        do {
            foreach ($child in @(Get-PocDescendants -RootProcessId $launchedProcess.Id)) {
                $observed["$($child.processId):$($child.startTicks)"] = $child
            }
            Start-Sleep -Milliseconds 500
            $launchedProcess.Refresh()
        } while (-not $launchedProcess.HasExited -and $lifecycleClock.ElapsedMilliseconds -lt 15000)
    }
    if (-not $launchedProcess.WaitForExit(150000)) { throw 'PoC did not quit after smoke timer' }
    $launchedProcess.Refresh()
    if ($launchedProcess.ExitCode -ne 0) { throw "PoC exit: $($launchedProcess.ExitCode)" }
    if ((Get-Content -LiteralPath $stdoutFile -Raw) -notmatch 'smoke timer completed') {
        throw 'Missing smoke completion marker'
    }
    if ($PreviewLifecycle) {
        $reclamation = Wait-PocDescendantsExit -Observed @($observed.Values)
        [ordered]@{ lifecycle = $lifecycle; reclamation = $reclamation
            surfaceInspectionRequired = $true; formalPerformance = $false } |
            ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (
                [IO.Path]::ChangeExtension($imageFile, '.lifecycle.json')) -Encoding utf8
        if ($observed.Count -eq 0) { throw 'Lifecycle: no child process evidence collected' }
        if ($reclamation.remaining.Count -gt 0) { throw 'Lifecycle: observed children remained after exit deadline' }
    }
    [ordered]@{
        at = [DateTime]::UtcNow.ToString('o')
        language = $Language
        binary = $Binary
        processId = $launchedProcess.Id
        windowHandle = $windowHandle.ToInt64()
        width = $windowRect.Right - $windowRect.Left
        height = $windowRect.Bottom - $windowRect.Top
        exitCode = $launchedProcess.ExitCode
        screenshot = [IO.Path]::GetFileName($imageFile)
        visualInspectionRequired = $true
        imeVerified = $false
        performanceVerified = $false
    } | ConvertTo-Json | Set-Content -LiteralPath ([IO.Path]::ChangeExtension($imageFile, '.json')) -Encoding utf8
    Write-Output "Window smoke passed; inspect $imageFile"
} finally {
    $env:POC_LANG = $previousLanguage
    if ($null -ne $launchedProcess) {
        if (-not $launchedProcess.HasExited) { $launchedProcess.Kill(); $launchedProcess.WaitForExit() }
        $launchedProcess.Dispose()
    }
}
