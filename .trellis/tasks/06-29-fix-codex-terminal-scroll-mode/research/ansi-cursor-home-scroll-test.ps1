param(
  [int]$Frames = 120,
  [int]$DelayMs = 80,
  [int]$Rows = 12
)

$esc = [char]27

for ($frame = 1; $frame -le $Frames; $frame++) {
  $timestamp = Get-Date -Format "HH:mm:ss.fff"
  [Console]::Write("$esc[H")
  for ($row = 1; $row -le $Rows; $row++) {
    $value = (($frame + $row) % 1000).ToString().PadLeft(3, "0")
    $line = "row {0:D2} frame={1:D3} value={2} time={3}" -f $row, $frame, $value, $timestamp
    [Console]::WriteLine($line)
  }
  Start-Sleep -Milliseconds $DelayMs
}

[Console]::WriteLine("")
[Console]::WriteLine("done frames=$Frames rows=$Rows delayMs=$DelayMs")
