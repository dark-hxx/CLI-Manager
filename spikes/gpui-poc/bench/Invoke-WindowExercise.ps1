<# Exercises only HWNDs owned by the isolated process launched here. No desktop capture/input. #>
[CmdletBinding()]
param([ValidateSet('zh-CN', 'en-US')][string]$Language = 'zh-CN')
$ErrorActionPreference = 'Stop'
$pocRoot = Split-Path $PSScriptRoot -Parent
$binary = Join-Path $pocRoot 'target/release/poc-window.exe'
$resultRoot = Join-Path $PSScriptRoot 'results/window'
[void][IO.Directory]::CreateDirectory($resultRoot)
$namespace = 'com.cli-manager.gpui-poc.' + [Guid]::NewGuid().ToString('N')
$stdout = Join-Path $resultRoot "$Language.stdout.log"
$stderr = Join-Path $resultRoot "$Language.stderr.log"
$report = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); language = $Language
    namespace = $namespace; passed = $false; syntheticMessages = $true
    snapMenuVerified = $false; realTauriInteropVerified = $false; checks = [ordered]@{} }
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PocWindowExercise {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct CopyData { public UIntPtr Kind; public uint Size; public IntPtr Data; }
    private delegate bool EnumCallback(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr Style(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")] private static extern IntPtr Send(IntPtr hwnd, uint msg, UIntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);
    public static void Owns(IntPtr hwnd, uint expected) {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        if (hwnd == IntPtr.Zero || pid != expected) throw new Exception("HWND ownership mismatch");
    }
    public static IntPtr FindOwned(uint pid, string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) => {
            uint owner; GetWindowThreadProcessId(h, out owner);
            var text = new StringBuilder(256); GetWindowText(h, text, text.Capacity);
            if (owner == pid && text.ToString() == title) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static long Message(IntPtr hwnd, uint msg, uint wp, long lp) {
        UIntPtr result;
        if (Send(hwnd, msg, new UIntPtr(wp), new IntPtr(lp), 3, 2000, out result) == IntPtr.Zero)
            throw new Exception("Window message timed out: " + msg);
        return unchecked((long)result.ToUInt64());
    }
    private static long XY(int x, int y) { return (long)((uint)(x & 65535) | ((uint)(y & 65535) << 16)); }
    public static long Hit(IntPtr hwnd, int x, int y) {
        Message(hwnd, 0x200, 0, XY(x,y)); // Synthetic mouse move; does not change system cursor.
        var point = new Point { X=x, Y=y }; ClientToScreen(hwnd, ref point);
        return Message(hwnd, 0x84, 0, XY(point.X, point.Y));
    }
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    public static void CaptionDoubleClick(IntPtr hwnd) {
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        try {
            Hit(hwnd, 40, 20);
            var point = new Point { X=40, Y=20 }; ClientToScreen(hwnd, ref point);
            var position = XY(point.X, point.Y);
            Message(hwnd, 0xa3, 2, position);
            Message(hwnd, 0xa2, 2, position); // Release the synthetic non-client press.
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
    public static long Payload(IntPtr hwnd, byte[] bytes, ulong kind) {
        IntPtr data = Marshal.AllocHGlobal(Math.Max(1,bytes.Length));
        IntPtr packet = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CopyData)));
        try {
            Marshal.Copy(bytes, 0, data, bytes.Length);
            var cds = new CopyData { Kind = new UIntPtr(kind), Size=(uint)bytes.Length, Data=data };
            Marshal.StructureToPtr(cds, packet, false);
            return Message(hwnd, 0x4A, 0, packet.ToInt64());
        } finally { Marshal.FreeHGlobal(packet); Marshal.FreeHGlobal(data); }
    }
}
'@
function Assert-Probe([bool]$Condition, [string]$Name) {
    $report.checks[$Name] = $Condition
    if (-not $Condition) { throw "Window probe assertion: $Name" }
}
function Wait-Probe([scriptblock]$Condition) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do { if (& $Condition) { return $true }; Start-Sleep -Milliseconds 50 } while ($timer.ElapsedMilliseconds -lt 4000)
    return $false
}
$previousLanguage = $env:POC_LANG
$primary = $null
$secondary = $null
$receiver = [IntPtr]::Zero
$mainTitle = if ($Language -eq 'zh-CN') { 'GPUI 窗口实验' } else { 'GPUI window probe' }
$petTitle = if ($Language -eq 'zh-CN') { 'GPUI 透明窗实验' } else { 'GPUI pet probe' }
try {
    $env:POC_LANG = $Language
    # Visible windows are the subject of this explicitly requested UI experiment.
    $primary = Start-Process $binary -ArgumentList @('--window', '--namespace', $namespace) -WindowStyle Normal -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $null = $primary.Handle
    Assert-Probe (Wait-Probe { [PocWindowExercise]::FindOwned($primary.Id, $mainTitle) -ne 0 }) 'mainCreated'
    $main = [PocWindowExercise]::FindOwned($primary.Id, $mainTitle)
    Assert-Probe (Wait-Probe { [PocWindowExercise]::FindOwned($primary.Id, $petTitle) -ne 0 }) 'petCreated'
    $pet = [PocWindowExercise]::FindOwned($primary.Id, $petTitle)
    $receiver = [PocWindowExercise]::FindWindow("$namespace-sic", "$namespace-siw")
    foreach ($handle in @($main, $pet, $receiver)) { [PocWindowExercise]::Owns($handle, $primary.Id) }
    Start-Sleep -Milliseconds 500
    $exStyle = [PocWindowExercise]::Style($pet, -20).ToInt64()
    $style = [PocWindowExercise]::Style($pet, -16).ToInt64()
    $report.petExStyle = $exStyle; $report.petStyle = $style
    Assert-Probe (($exStyle -band 8) -ne 0) 'petTopmost'
    Assert-Probe (($exStyle -band 0x80) -ne 0 -and ($exStyle -band 0x40000) -eq 0) 'petToolwindow'
    Assert-Probe (($style -band 0xc40000) -eq 0) 'petBorderless'
    Assert-Probe ((Get-Content $stdout -Raw -Encoding UTF8) -match 'tray: added') 'trayAdded'
    [void][PocWindowExercise]::Message($receiver, 0x111, 102, 0)
    Assert-Probe (Wait-Probe { -not [PocWindowExercise]::IsWindowVisible($main) }) 'trayHide'
    [void][PocWindowExercise]::Message($receiver, 0x111, 101, 0)
    Assert-Probe (Wait-Probe { [PocWindowExercise]::IsWindowVisible($main) }) 'trayRestore'
    [void][PocWindowExercise]::ShowWindow($main, 6)
    Assert-Probe (Wait-Probe { [PocWindowExercise]::IsIconic($main) }) 'mainMinimized'
    # Secondary is a hidden helper; it must forward and exit without another GPUI window.
    $secondary = Start-Process $binary -ArgumentList @('--window', '--namespace', $namespace, '中文参数🙂') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $resultRoot "$Language.secondary.log") -RedirectStandardError (Join-Path $resultRoot "$Language.secondary.stderr.log")
    $null = $secondary.Handle
    Assert-Probe ($secondary.WaitForExit(5000)) 'secondaryExited'
    Assert-Probe ($secondary.ExitCode -eq 0) 'secondaryForwarded'
    Assert-Probe (Wait-Probe { -not [PocWindowExercise]::IsIconic($main) }) 'forwardRestoredMinimized'
    Assert-Probe (Wait-Probe { (Get-Content $stdout -Raw -Encoding UTF8) -match '中文参数🙂' }) 'unicodeReceived'
    $good = [Text.Encoding]::UTF8.GetBytes("F:\probe|independent-peer|中文🙂`0")
    Assert-Probe ([PocWindowExercise]::Payload($receiver, $good, 1542) -eq 1) 'independentSenderAccepted'
    Assert-Probe ([PocWindowExercise]::Payload($receiver, $good, 999) -eq 0) 'wrongTagRejected'
    Assert-Probe ([PocWindowExercise]::Payload($receiver, [Text.Encoding]::UTF8.GetBytes('unterminated'), 1542) -eq 0) 'unterminatedRejected'
    Assert-Probe ([PocWindowExercise]::Payload($receiver, [byte[]]@(0xff,0), 1542) -eq 0) 'invalidUtf8Rejected'
    Assert-Probe ([PocWindowExercise]::Payload($receiver, [byte[]]::new(65537), 1542) -eq 0) 'oversizedRejected'
    $client = [PocWindowExercise+Rect]::new()
    [void][PocWindowExercise]::GetClientRect($main, [ref]$client)
    $scale = [PocWindowExercise]::GetDpiForWindow($main) / 96.0
    $hits = @{}
    for ($x = [int]($client.Right * 0.65); $x -lt $client.Right - 8; $x += [int](4 * $scale)) {
        $hit = [PocWindowExercise]::Hit($main, $x, [int](22 * $scale))
        $hits["$hit"] = $true
    }
    $report.titlebarHitCodes = @($hits.Keys | Sort-Object)
    foreach ($code in @('2', '8', '9', '20')) { Assert-Probe ($hits.ContainsKey($code)) "titlebarHit$code" }
    # Observation only: synthesized double-clicks are not real system input.
    $report.doubleClickObservation = [ordered]@{}
    [PocWindowExercise]::CaptionDoubleClick($main)
    $report.doubleClickObservation.maximized = Wait-Probe { [PocWindowExercise]::IsZoomed($main) }
    Start-Sleep -Milliseconds 600
    [PocWindowExercise]::CaptionDoubleClick($main)
    $report.doubleClickObservation.restored = Wait-Probe { -not [PocWindowExercise]::IsZoomed($main) }
    $report.doubleClickVerified = $false
    # Exercise deterministic native state transitions separately, without retries.
    [void][PocWindowExercise]::Message($main, 0x112, 0xf030, 0) # SC_MAXIMIZE
    Assert-Probe (Wait-Probe { [PocWindowExercise]::IsZoomed($main) }) 'nativeMaximized'
    [void][PocWindowExercise]::Message($main, 0x112, 0xf120, 0) # SC_RESTORE
    Assert-Probe (Wait-Probe { -not [PocWindowExercise]::IsZoomed($main) }) 'nativeRestored'
    [void][PocWindowExercise]::Message($receiver, 0x111, 103, 0)
    Assert-Probe ($primary.WaitForExit(5000)) 'trayQuit'
    Assert-Probe ($primary.ExitCode -eq 0) 'primaryExitZero'
    Assert-Probe ((Get-Content $stdout -Raw -Encoding UTF8) -match 'tray: deleted=true') 'trayDeleted'
    Assert-Probe ([PocWindowExercise]::FindWindow("$namespace-sic", "$namespace-siw") -eq 0) 'receiverDestroyed'
    $mutexProbe = $null
    $existing = [Threading.Mutex]::TryOpenExisting("$namespace-sim", [ref]$mutexProbe)
    if ($null -ne $mutexProbe) { $mutexProbe.Dispose() }
    Assert-Probe (-not $existing) 'mutexReleased'
    $primary.Dispose()
    $restartLog = Join-Path $resultRoot "$Language.restart.stdout.log"
    $primary = Start-Process $binary -ArgumentList @('--window', '--namespace', $namespace) -WindowStyle Normal -PassThru -RedirectStandardOutput $restartLog -RedirectStandardError (Join-Path $resultRoot "$Language.restart.stderr.log")
    $null = $primary.Handle
    Assert-Probe (Wait-Probe { [PocWindowExercise]::FindOwned($primary.Id, $petTitle) -ne 0 }) 'sameNamespaceRestarted'
    $main = [PocWindowExercise]::FindOwned($primary.Id, $mainTitle)
    $pet = [PocWindowExercise]::FindOwned($primary.Id, $petTitle)
    $receiver = [PocWindowExercise]::FindWindow("$namespace-sic", "$namespace-siw")
    foreach ($handle in @($main, $pet, $receiver)) { [PocWindowExercise]::Owns($handle, $primary.Id) }
    [void][PocWindowExercise]::Message($pet, 0x10, 0, 0)
    Start-Sleep -Milliseconds 150
    Assert-Probe (-not $primary.HasExited -and [PocWindowExercise]::IsWindowVisible($main)) 'closingPetKeepsMain'
    [void][PocWindowExercise]::Message($main, 0x10, 0, 0)
    Assert-Probe ($primary.WaitForExit(5000)) 'closingMainExits'
    Assert-Probe ($primary.ExitCode -eq 0 -and (Get-Content $restartLog -Raw -Encoding UTF8) -match 'tray: deleted=true') 'closePathCleansTray'
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    $env:POC_LANG = $previousLanguage
    if ($null -ne $primary) {
        $primary.Refresh()
        if (-not $primary.HasExited -and $receiver -ne 0) {
            try { [PocWindowExercise]::Owns($receiver, $primary.Id); [void][PocWindowExercise]::Message($receiver, 0x111, 103, 0); [void]$primary.WaitForExit(3000) } catch { }
        }
    }
    foreach ($process in @($secondary, $primary)) {
        if ($null -ne $process) {
            if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
            $process.Dispose()
        }
    }
    $report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $resultRoot "$Language.json") -Encoding utf8
}
Write-Output "Window exercise passed: $Language"
