$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$inputText = [Console]::In.ReadToEnd()
if ($inputText.Length -gt 16384) { throw 'CAD_PROBE_INPUT_LIMIT' }
$request = $inputText | ConvertFrom-Json
if ($request.operation -ne 'cad.session.probe' -or -not [IO.Path]::IsPathRooted($request.executable) -or -not (Test-Path -LiteralPath $request.executable -PathType Leaf)) { throw 'CAD_PROBE_INPUT_INVALID' }
$executable = [IO.Path]::GetFullPath($request.executable)
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
if ($version.ProductName -notmatch 'ZWCAD' -or $version.FileVersion -notmatch '^25\.') { throw 'CAD_PROBE_VERSION_UNSUPPORTED' }
$stage = Join-Path $env:LOCALAPPDATA ('gotzji\cad-sessions\probe-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$nonce = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))
$readyFile = Join-Path $stage 'ready.json'
$scriptFile = Join-Path $stage 'probe.scr'
$lisp = @'
(if (equal (getenv "GOTZJI_CAD_NONCE") "@@NONCE@@") (progn (vl-load-com) (setq gjapp (vlax-get-acad-object)) (setq gjfile (open (getenv "GOTZJI_CAD_READY") "w")) (write-line (strcat "{\"nonce\":\"@@NONCE@@\",\"hwnd\":" (itoa (vla-get-HWND gjapp)) ",\"documents\":" (itoa (vla-get-Count (vla-get-Documents gjapp))) ",\"dbmod\":" (itoa (getvar "DBMOD")) ",\"titled\":" (itoa (getvar "DWGTITLED")) ",\"entities\":" (itoa (vla-get-Count (vla-get-ModelSpace (vla-get-ActiveDocument gjapp)))) "}") gjfile) (close gjfile)))
(princ)

'@
[IO.File]::WriteAllText($scriptFile, $lisp.Replace('@@NONCE@@', $nonce), [Text.Encoding]::ASCII)
$existing = @(Get-Process -Name ZWCAD -ErrorAction SilentlyContinue | Select-Object Id,StartTime)
$env:GOTZJI_CAD_NONCE = $nonce
$env:GOTZJI_CAD_READY = $readyFile
$cadProcess = Start-Process -FilePath $executable -ArgumentList @('/B', ('"' + $scriptFile + '"')) -WorkingDirectory $stage -WindowStyle Hidden -PassThru
$cadProcess.Refresh()
$birth = $cadProcess.StartTime.ToUniversalTime().Ticks
$ownership = @{ pid = $cadProcess.Id; birth = [string]$birth; executable = $executable; nonce = $nonce; stage = $stage }
[IO.File]::WriteAllText((Join-Path $stage 'ownership.json'), ($ownership | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
$until = [DateTime]::UtcNow.AddSeconds(45)
while (-not (Test-Path -LiteralPath $readyFile -PathType Leaf) -and [DateTime]::UtcNow -lt $until) {
  $cadProcess.Refresh()
  if ($cadProcess.HasExited) { break }
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $readyFile -PathType Leaf)) {
  @{ ok = $false; error = @{ code = 'CAD_OWNED_STARTUP_NOT_OBSERVED'; outcome = 'unknown' }; ownedPid = $cadProcess.Id; stage = $stage } | ConvertTo-Json -Compress -Depth 5
  exit 1
}
$ready = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GotzjiCadProbeWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
}
'@
$windowOwner = [uint32]0
[void][GotzjiCadProbeWindow]::GetWindowThreadProcessId([IntPtr][long]$ready.hwnd, [ref]$windowOwner)
$current = Get-Process -Id $cadProcess.Id -ErrorAction SilentlyContinue
$owned = $null -ne $current -and $ready.nonce -ceq $nonce -and $windowOwner -eq $cadProcess.Id -and $current.StartTime.ToUniversalTime().Ticks -eq $birth -and $current.Path -ieq $executable -and -not ($existing.Id -contains $cadProcess.Id)
$blank = $owned -and $ready.documents -eq 1 -and $ready.dbmod -eq 0 -and $ready.titled -eq 0 -and $ready.entities -eq 0
$closed = $false
if ($blank) {
  # Only the process created by this helper, with exact window/birth/blank proof.
  [void]$cadProcess.CloseMainWindow()
  $closed = $cadProcess.WaitForExit(10000)
}
$originalsPreserved = $true
foreach ($original in $existing) {
  $now = Get-Process -Id $original.Id -ErrorAction SilentlyContinue
  if ($null -eq $now -or $now.StartTime -ne $original.StartTime) { $originalsPreserved = $false }
}
@{ ok = $true; value = @{ owned = $owned; blank = $blank; closed = $closed; providerVersion = $version.FileVersion; nativePid = $cadProcess.Id; startedAtTicks = [string]$birth; originalsPreserved = $originalsPreserved; preExistingCount = $existing.Count; stage = $stage } } | ConvertTo-Json -Compress -Depth 5
