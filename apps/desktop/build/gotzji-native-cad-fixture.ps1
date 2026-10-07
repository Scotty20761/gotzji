param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$Directory=[IO.Path]::GetFullPath($Directory)
if ($Directory -notmatch '\\gotzji\\qualification\\[^\\]+$' -or -not (Test-Path -LiteralPath $Directory -PathType Container)) { throw 'NATIVE_FIXTURE_DIRECTORY_DENIED' }
$target=Join-Path $Directory 'original.dwg'
if (Test-Path -LiteralPath $target) { throw 'NATIVE_FIXTURE_OUTPUT_EXISTS' }
$existingPids=@(Get-Process ZWCAD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GotzjiCadFixturePid { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid); public static uint For(long hwnd) { uint pid; GetWindowThreadProcessId(new IntPtr(hwnd),out pid); return pid; } }' | Out-Null
$app=$null; $doc=$null; $ownedPid=0; $startupBlankNames=@()
try {
 $app=New-Object -ComObject ZWCAD.Application.2025
 $observedPid=[int][GotzjiCadFixturePid]::For([long]$app.HWND)
 if ($observedPid -lt 1 -or $existingPids -contains $observedPid -or (Get-Process -Id $observedPid).Path -ne 'E:\Program Files\ZWSOFT\ZWCAD 2025\ZWCAD.exe') { throw 'NATIVE_SESSION_IDENTITY_UNVERIFIED' }
 $ownedPid=$observedPid; $app.Visible=$false
 foreach ($initial in $app.Documents) { if ($initial.ModelSpace.Count -eq 0 -and $initial.PaperSpace.Count -eq 0 -and $initial.Saved) { $startupBlankNames += [string]$initial.Name } }
 $doc=$app.Documents.Add()
 [void]$doc.Layers.Add('FIXTURE_EDITABLE'); [void]$doc.Layers.Add('FIXTURE_PRESERVED')
 $line=$doc.ModelSpace.AddLine([double[]]@(0,0,0),[double[]]@(10,0,0)); $line.Layer='FIXTURE_EDITABLE'
 $other=$doc.ModelSpace.AddLine([double[]]@(100,100,0),[double[]]@(110,100,0)); $other.Layer='FIXTURE_PRESERVED'
 $handle=[string]$line.Handle
 $doc.SaveAs($target)
 [Console]::Write(([ordered]@{ filePath=$target; handle=$handle; expectedSha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant(); nativePid=$ownedPid } | ConvertTo-Json -Compress))
} finally {
 if ($null -ne $doc) { $doc.Close($false); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) }
 if ($null -ne $app) {
  if ($ownedPid -gt 0) { foreach ($initial in @($app.Documents)) { if ($startupBlankNames -contains [string]$initial.Name -and $initial.ModelSpace.Count -eq 0 -and $initial.PaperSpace.Count -eq 0 -and $initial.Saved) { $initial.Close($false) } }; if ($app.Documents.Count -eq 0) { $app.Quit() } }
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)
 }
}
