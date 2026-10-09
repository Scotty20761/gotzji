$ErrorActionPreference = 'Stop'
$cadProcess = $null
$approved = $false
$crashPromptDeclined = $false
# One budget for the whole run, so every wait plus the final close stays inside the runner's 120 s limit.
$runDeadline = [DateTime]::UtcNow.AddSeconds(95)
# Codes the LISP writes before it changes anything; with the conditions in Get-Outcome they prove no effect.
$refusals = @('CAD_SESSION_ENTITY_UNSUPPORTED','CAD_SESSION_ENTITY_NOT_FOUND','CAD_DRAWING_TOO_LARGE')
function Stop-Owned {
  # Ends only the process this script started, through the handle Start-Process returned (no PID reuse is possible).
  if ($null -eq $script:cadProcess) { return $true }
  try { $script:cadProcess.Refresh() } catch { }
  # A main window disabled by a modal dialog refuses the close request; the process is then ended at once.
  try { if (-not $script:cadProcess.HasExited -and $script:cadProcess.CloseMainWindow()) { [void]$script:cadProcess.WaitForExit(10000) } } catch { }
  try { if (-not $script:cadProcess.HasExited) { $script:cadProcess.Kill(); [void]$script:cadProcess.WaitForExit(10000) } } catch { }
  try { return [bool]$script:cadProcess.HasExited } catch { return $false }
}
function Get-Outcome([string]$code, [bool]$exited) {
  # No effect is proven only when nothing was approved (or the LISP refused before any change), the owned process has
  # ended, no output exists and the source still has the approved bytes.
  try {
    $noEffect = (-not $script:approved) -or ($script:refusals -contains $code)
    $noOutput = [string]::IsNullOrEmpty([string]$script:request.outputPath) -or -not (Test-Path -LiteralPath ([string]$script:request.outputPath))
    $sourceSame = (Get-FileHash -LiteralPath $script:request.filePath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $script:request.expectedSha256
    if ($noEffect -and $exited -and $noOutput -and $sourceSame) { return 'none' }
  } catch { }
  return 'unknown'
}
function Remove-Stage([bool]$exited) {
  # The clone and session files go once the owned process has ended; an unended process keeps them for inspection.
  if ($exited -and $null -ne $script:stage) { try { Remove-Item -LiteralPath $script:stage -Recurse -Force } catch { } }
}
function Fail([string]$code) {
  $exited = Stop-Owned
  $outcome = Get-Outcome $code $exited
  Remove-Stage $exited
  @{ok=$false;error=@{code=$code;outcome=$outcome};crashPromptDeclined=$script:crashPromptDeclined} | ConvertTo-Json -Compress -Depth 4
  exit 1
}
function Deadline([int]$seconds) { $until = [DateTime]::UtcNow.AddSeconds($seconds); if ($until -gt $script:runDeadline) { $script:runDeadline } else { $until } }
function Watch-Dialogs {
  # Answers the crash-report question when it appears; returns the text of any other dialog, or $null.
  $dialog = [GotzjiCadSessionWindow]::Dialog([uint32]$script:cadProcess.Id)
  if ($dialog -eq 'declined') { $script:crashPromptDeclined = $true; return $null }
  return $dialog
}
trap {
  $message = [string]$_.Exception.Message
  $code = if ($message -match '^CAD_[A-Z0-9_]+$') { $message } else { 'CAD_SESSION_PROVIDER_FAILED' }
  $exited = Stop-Owned
  # Nothing was started, so nothing can have happened.
  $outcome = if ($null -eq $cadProcess) { 'none' } else { Get-Outcome $code $exited }
  Remove-Stage $exited
  @{ok=$false;error=@{code=$code;outcome=$outcome};crashPromptDeclined=$crashPromptDeclined} | ConvertTo-Json -Compress -Depth 4
  exit 1
}
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$inputText = [Console]::In.ReadToEnd()
if ($inputText.Length -gt 32768) { throw 'CAD_SESSION_INPUT_LIMIT' }
$request = $inputText | ConvertFrom-Json
$allowed = @('cad.entity.inspect','cad.entity.move')
if ($allowed -notcontains $request.operation -or -not [IO.Path]::IsPathRooted($request.executable)) { throw 'CAD_SESSION_INPUT_INVALID' }
$exe = [IO.Path]::GetFullPath($request.executable)
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
if ($version.ProductName -ne 'ZWCAD 2025' -or $version.FileVersion -notmatch '^25\.') { throw 'CAD_SESSION_VERSION_UNSUPPORTED' }
if ($request.handle -notmatch '^[0-9A-Fa-f]{1,64}$' -or [IO.Path]::GetExtension($request.filePath) -ine '.dwg') { throw 'CAD_SESSION_HANDLE_OR_FORMAT_UNSUPPORTED' }
if ((Get-FileHash -LiteralPath $request.filePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $request.expectedSha256) { throw 'CAD_SESSION_SOURCE_CHANGED' }
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class GotzjiCadSessionWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimitInformation; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  // A job closed with this script's process ends the owned ZWCAD even when the runner kills PowerShell (timeout or cancel).
  public static IntPtr KillOnClose(IntPtr process) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    Extended info = new Extended(); info.BasicLimitInformation.LimitFlags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) return IntPtr.Zero;
    return AssignProcessToJobObject(job, process) ? job : IntPtr.Zero;
  }
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  // A modal dialog in the owned process blocks its script. After an earlier ZWCAD crash it asks whether to send a crash
  // report; that question is answered No (posted, so a hung dialog cannot stall this script; nothing is sent and
  // "remember my choice" is never ticked) and "declined" is returned. Otherwise the text of the first other dialog is
  // returned, or null when there is none.
  public static string Dialog(uint pid) {
    string other = null; bool declined = false;
    EnumWindows(delegate (IntPtr hwnd, IntPtr unused) {
      uint owner; GetWindowThreadProcessId(hwnd, out owner);
      System.Text.StringBuilder kind = new System.Text.StringBuilder(64); GetClassName(hwnd, kind, 64);
      if (owner != pid || kind.ToString() != "#32770") return true;
      string text = ""; IntPtr no = IntPtr.Zero;
      EnumChildWindows(hwnd, delegate (IntPtr child, IntPtr unusedChild) {
        System.Text.StringBuilder value = new System.Text.StringBuilder(512); System.Text.StringBuilder childKind = new System.Text.StringBuilder(64);
        GetWindowText(child, value, 512); GetClassName(child, childKind, 64);
        if (childKind.ToString() == "Static") text += value.ToString() + " ";
        if (childKind.ToString() == "Button" && value.ToString() == "No") no = child;
        return true; }, IntPtr.Zero);
      if (text.Contains("Crashed in your last running") && no != IntPtr.Zero) { PostMessage(no, 0x00F5, IntPtr.Zero, IntPtr.Zero); declined = true; }
      else if (other == null) other = text.Trim();
      return true; }, IntPtr.Zero);
    return declined ? "declined" : other;
  }
}
'@
$stage = Join-Path $env:LOCALAPPDATA ('gotzji\cad-sessions\operation-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$clone = Join-Path $stage 'working.dwg'
Copy-Item -LiteralPath $request.filePath -Destination $clone
# Bind the actual cloned bytes, not merely an earlier source-path observation.
if ((Get-FileHash -LiteralPath $clone -Algorithm SHA256).Hash.ToLowerInvariant() -cne $request.expectedSha256) { throw 'CAD_SESSION_SOURCE_CHANGED' }
$nonce = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$ready = Join-Path $stage 'ready.txt'
$approval = Join-Path $stage 'approve.txt'
$resultFile = Join-Path $stage 'native.json'
$failureFile = Join-Path $stage 'native-error.txt'
$script = Join-Path $stage 'operation.scr'
$env:GOTZJI_CAD_NONCE = $nonce
$env:GOTZJI_CAD_READY = $ready
$env:GOTZJI_CAD_READY_TMP = $ready + '.tmp'
$env:GOTZJI_CAD_APPROVAL = $approval
$env:GOTZJI_CAD_RESULT = $resultFile
$env:GOTZJI_CAD_ERROR = $failureFile
$env:GOTZJI_CAD_OPERATION = $request.operation
$env:GOTZJI_CAD_HANDLE = [string]$request.handle
$env:GOTZJI_CAD_SOURCE = [string]$request.filePath
$env:GOTZJI_CAD_OUTPUT = [string]$request.outputPath
$env:GOTZJI_CAD_DX = if ($request.displacement) { ([double]$request.displacement[0]).ToString('R',[Globalization.CultureInfo]::InvariantCulture) } else { '0' }
$env:GOTZJI_CAD_DY = if ($request.displacement) { ([double]$request.displacement[1]).ToString('R',[Globalization.CultureInfo]::InvariantCulture) } else { '0' }
$env:GOTZJI_CAD_DZ = if ($request.displacement) { ([double]$request.displacement[2]).ToString('R',[Globalization.CultureInfo]::InvariantCulture) } else { '0' }
$lisp = @'
(if (equal (getenv "GOTZJI_CAD_NONCE") "@@NONCE@@") (progn
(vl-load-com)
(defun gjq (s) (strcat "\"" (vl-string-subst "\\\"" "\"" (vl-string-subst "\\\\" "\\" s)) "\""))
(defun gjnumber (n / s) (setq s (rtos n 2 12)) (cond ((equal (substr s 1 2) "-.") (strcat "-0" (substr s 2))) ((equal (substr s 1 1) ".") (strcat "0" s)) (T s)))
(defun gjpoint (p) (strcat "[" (gjnumber (car p)) "," (gjnumber (cadr p)) "," (gjnumber (caddr p)) "]"))
(defun gjline (e) (strcat "{\"handle\":" (gjq (vla-get-Handle e)) ",\"objectType\":" (gjq (vla-get-ObjectName e)) ",\"layer\":" (gjq (vla-get-Layer e)) ",\"startPoint\":" (gjpoint (vlax-safearray->list (vlax-variant-value (vla-get-StartPoint e)))) ",\"endPoint\":" (gjpoint (vlax-safearray->list (vlax-variant-value (vla-get-EndPoint e)))) "}"))
(defun gjothers (space excluded / result e data) (setq result nil) (vlax-for e space (if (/= (vla-get-Handle e) excluded) (progn (setq data (vl-remove-if '(lambda (pair) (member (car pair) '(-1 330 360))) (entget (vlax-vla-object->ename e)))) (setq result (cons data result))))) (vl-princ-to-string (reverse result)))
(defun gjwrite (file text / f) (setq f (open file "w")) (write-line text f) (close f))
(defun *error* (message) (gjwrite (getenv "GOTZJI_CAD_ERROR") "CAD_SESSION_NATIVE_FAILED") (princ))
(setq gjapp (vlax-get-acad-object) gjdoc (vla-get-ActiveDocument gjapp) gjspace (vla-get-ModelSpace gjdoc))
(setq gjready (open (getenv "GOTZJI_CAD_READY_TMP") "w"))
(foreach gjvalue (list "@@NONCE@@" (itoa (vla-get-HWND gjapp)) (itoa (vla-get-Count (vla-get-Documents gjapp))) (itoa (getvar "DBMOD")) (itoa (getvar "DWGTITLED")) (itoa (vla-get-Count gjspace)) (vla-get-FullName gjdoc)) (write-line gjvalue gjready))
(close gjready)
(vl-file-rename (getenv "GOTZJI_CAD_READY_TMP") (getenv "GOTZJI_CAD_READY"))
(setq gjdeadline (+ (getvar "MILLISECS") 15000))
(while (and (not (findfile (getenv "GOTZJI_CAD_APPROVAL"))) (< (getvar "MILLISECS") gjdeadline)))
(if (findfile (getenv "GOTZJI_CAD_APPROVAL")) (progn
(setq gjf (open (getenv "GOTZJI_CAD_APPROVAL") "r") gjapproved (equal (read-line gjf) "@@NONCE@@")) (close gjf)
(if gjapproved (progn
(setq gjoperation (getenv "GOTZJI_CAD_OPERATION"))
 (setq gje (vl-catch-all-apply 'vla-HandleToObject (list gjdoc (getenv "GOTZJI_CAD_HANDLE"))))
 (cond
 ((vl-catch-all-error-p gje) (gjwrite (getenv "GOTZJI_CAD_ERROR") "CAD_SESSION_ENTITY_NOT_FOUND"))
 ((/= (vla-get-ObjectName gje) "AcDbLine") (gjwrite (getenv "GOTZJI_CAD_ERROR") "CAD_SESSION_ENTITY_UNSUPPORTED"))
 (T
 (setq gjbefore (gjline gje) gjbeforeothers (gjothers gjspace (vla-get-Handle gje)))
 (if (equal gjoperation "cad.entity.move") (progn (vla-Move gje (vlax-3d-point '(0 0 0)) (vlax-3d-point (list (atof (getenv "GOTZJI_CAD_DX")) (atof (getenv "GOTZJI_CAD_DY")) (atof (getenv "GOTZJI_CAD_DZ"))))) (vla-SaveAs gjdoc (getenv "GOTZJI_CAD_OUTPUT"))))
 (gjwrite (getenv "GOTZJI_CAD_RESULT") (strcat "{\"before\":" gjbefore ",\"after\":" (gjline gje) ",\"unrelatedPreserved\":" (if (equal gjbeforeothers (gjothers gjspace (vla-get-Handle gje))) "true" "false") "}"))
 (gjwrite (strcat (getenv "GOTZJI_CAD_RESULT") ".others") gjbeforeothers)
 ))
))))
(princ)
))
(princ)

'@
# Inline SCR expressions avoid installing startup LISP or changing trusted paths/settings. The script keeps CRLF line
# ends whatever line ends this file was checked out with.
[IO.File]::WriteAllText($script, ($lisp.Replace('@@NONCE@@', $nonce) -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII)
$existing = @(Get-Process -Name ZWCAD -ErrorAction SilentlyContinue | Select-Object Id,StartTime)
$arguments = @(('"'+$clone+'"'),'/B',('"'+$script+'"'))
$cadProcess = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $stage -WindowStyle Hidden -PassThru
# Held for this script's lifetime; never closed explicitly.
$job = [GotzjiCadSessionWindow]::KillOnClose($cadProcess.Handle)
if ($job -eq [IntPtr]::Zero) { Fail 'CAD_SESSION_JOB_UNAVAILABLE' }
$cadProcess.Refresh()
$birth = $cadProcess.StartTime.ToUniversalTime().Ticks
[IO.File]::WriteAllText((Join-Path $stage 'ownership.json'), (@{ pid=$cadProcess.Id; birth=[string]$birth; executable=$exe; nonce=$nonce; stage=$stage } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
# ZWCAD 2025 has been seen taking 30-40 s to run its startup script. ready.txt appears complete (renamed into place).
$deadline = Deadline 60
while (-not (Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline) {
  if ($cadProcess.HasExited) { break }
  [void](Watch-Dialogs)
  Start-Sleep -Milliseconds 250; $cadProcess.Refresh()
}
# A dialog still open at the deadline names the reason; it is never taken for a failure earlier.
if (-not (Test-Path -LiteralPath $ready)) { Fail $(if (-not $cadProcess.HasExited -and $null -ne (Watch-Dialogs)) { 'CAD_SESSION_DIALOG_BLOCKED' } else { 'CAD_OWNED_STARTUP_NOT_OBSERVED' }) }
$metadata = [IO.File]::ReadAllLines($ready)
$windowOwner = [uint32]0
[void][GotzjiCadSessionWindow]::GetWindowThreadProcessId([IntPtr][long]$metadata[1],[ref]$windowOwner)
$current = Get-Process -Id $cadProcess.Id -ErrorAction SilentlyContinue
$owned = $null -ne $current -and $metadata[0] -ceq $nonce -and $windowOwner -eq $cadProcess.Id -and $current.StartTime.ToUniversalTime().Ticks -eq $birth -and $current.Path -ieq $exe -and -not ($existing.Id -contains $cadProcess.Id)
$documentVerified = $owned -and $metadata[2] -eq '1' -and $metadata[3] -eq '0' -and $metadata[6] -ieq $clone
# A refusal releases the session's wait at once: any line other than the nonce is a denial.
if (-not $documentVerified) { [IO.File]::WriteAllText($approval, "DENY`n", [Text.Encoding]::ASCII); Fail 'CAD_OWNED_DOCUMENT_NOT_VERIFIED' }
if ([int]$metadata[5] -gt 5000) { [IO.File]::WriteAllText($approval, "DENY`n", [Text.Encoding]::ASCII); Fail 'CAD_DRAWING_TOO_LARGE' }
# Set before the write it guards: from here on the session may act.
$approved = $true
[IO.File]::WriteAllText($approval, ($nonce + "`n"), [Text.Encoding]::ASCII)
$deadline = Deadline 30
while (-not (Test-Path -LiteralPath $resultFile) -and -not (Test-Path -LiteralPath $failureFile) -and [DateTime]::UtcNow -lt $deadline) {
  [void](Watch-Dialogs)
  Start-Sleep -Milliseconds 100
}
$blocked = -not (Test-Path -LiteralPath $resultFile) -and -not (Test-Path -LiteralPath $failureFile) -and -not $cadProcess.HasExited -and $null -ne (Watch-Dialogs)
$closed = Stop-Owned
if (-not $closed -or -not (Test-Path -LiteralPath $resultFile)) {
  # Read only after the owned process has ended, so a late write cannot follow the decision.
  Fail $(if (Test-Path -LiteralPath $failureFile) { ([IO.File]::ReadAllText($failureFile)).Trim() } elseif ($blocked) { 'CAD_SESSION_DIALOG_BLOCKED' } else { 'CAD_SESSION_RESULT_UNVERIFIED' })
}
$unrelated = if (Test-Path -LiteralPath ($resultFile+'.others')) { (Get-FileHash -LiteralPath ($resultFile+'.others') -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
$originals = $true
foreach ($original in $existing) { $now=Get-Process -Id $original.Id -ErrorAction SilentlyContinue; if ($null -eq $now -or $now.StartTime -ne $original.StartTime) { $originals=$false } }
$native = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
Remove-Stage $closed
@{ok=$true;value=@{native=$native;nativePid=$cadProcess.Id;birth=[string]$birth;providerVersion=$version.FileVersion;owned=$owned;closed=$closed;originalSessionsPreserved=$originals;unrelatedHash=$unrelated;crashPromptDeclined=$crashPromptDeclined}}|ConvertTo-Json -Compress -Depth 12
