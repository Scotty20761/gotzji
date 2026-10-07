$ErrorActionPreference = 'Stop'
trap {
  $message = [string]$_.Exception.Message
  $code = if ($message -match '^CAD_[A-Z0-9_]+$') { $message } else { 'CAD_SESSION_PROVIDER_FAILED' }
  $outcome = if ($null -ne $cadProcess) { 'unknown' } else { 'none' }
  @{ok=$false;error=@{code=$code;outcome=$outcome}} | ConvertTo-Json -Compress -Depth 4
  exit 1
}
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$inputText = [Console]::In.ReadToEnd()
if ($inputText.Length -gt 32768) { throw 'CAD_SESSION_INPUT_LIMIT' }
$request = $inputText | ConvertFrom-Json
# Development-only fixture helper. Never package or expose through MCP.
$allowed = @('cad.session.fixture')
if ($allowed -notcontains $request.operation -or -not [IO.Path]::IsPathRooted($request.executable)) { throw 'CAD_SESSION_INPUT_INVALID' }
$exe = [IO.Path]::GetFullPath($request.executable)
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
if ($version.ProductName -ne 'ZWCAD 2025' -or $version.FileVersion -notmatch '^25\.') { throw 'CAD_SESSION_VERSION_UNSUPPORTED' }
if ($request.operation -ne 'cad.session.fixture') {
  if ($request.handle -notmatch '^[0-9A-Fa-f]{1,64}$' -or [IO.Path]::GetExtension($request.filePath) -ine '.dwg') { throw 'CAD_SESSION_HANDLE_OR_FORMAT_UNSUPPORTED' }
  if ((Get-FileHash -LiteralPath $request.filePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $request.expectedSha256) { throw 'CAD_SESSION_SOURCE_CHANGED' }
}
$stage = Join-Path $env:LOCALAPPDATA ('gotzji\cad-sessions\operation-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$clone = Join-Path $stage 'working.dwg'
if ($request.operation -ne 'cad.session.fixture') {
  Copy-Item -LiteralPath $request.filePath -Destination $clone
  # Bind the actual cloned bytes, not merely an earlier source-path observation.
  if ((Get-FileHash -LiteralPath $clone -Algorithm SHA256).Hash.ToLowerInvariant() -cne $request.expectedSha256) { throw 'CAD_SESSION_SOURCE_CHANGED' }
}
$nonce = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$ready = Join-Path $stage 'ready.txt'
$approval = Join-Path $stage 'approve.txt'
$resultFile = Join-Path $stage 'native.json'
$failureFile = Join-Path $stage 'native-error.txt'
$script = Join-Path $stage 'operation.scr'
$env:GOTZJI_CAD_NONCE = $nonce
$env:GOTZJI_CAD_READY = $ready
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
(setq gjready (open (getenv "GOTZJI_CAD_READY") "w"))
(foreach gjvalue (list "@@NONCE@@" (itoa (vla-get-HWND gjapp)) (itoa (vla-get-Count (vla-get-Documents gjapp))) (itoa (getvar "DBMOD")) (itoa (getvar "DWGTITLED")) (itoa (vla-get-Count gjspace)) (vla-get-FullName gjdoc)) (write-line gjvalue gjready))
(close gjready)
(setq gjdeadline (+ (getvar "MILLISECS") 15000))
(while (and (not (findfile (getenv "GOTZJI_CAD_APPROVAL"))) (< (getvar "MILLISECS") gjdeadline)))
(if (findfile (getenv "GOTZJI_CAD_APPROVAL")) (progn
(setq gjf (open (getenv "GOTZJI_CAD_APPROVAL") "r") gjapproved (equal (read-line gjf) "@@NONCE@@")) (close gjf)
(if gjapproved (progn
(setq gjoperation (getenv "GOTZJI_CAD_OPERATION"))
(if (equal gjoperation "cad.session.fixture") (progn
 (vla-Add (vla-get-Layers gjdoc) "GOTZJI_TARGET") (vla-Add (vla-get-Layers gjdoc) "GOTZJI_UNRELATED")
 (setq gje (vla-AddLine gjspace (vlax-3d-point '(0 0 0)) (vlax-3d-point '(10 0 0)))) (vla-put-Layer gje "GOTZJI_TARGET")
 (setq gjother (vla-AddLine gjspace (vlax-3d-point '(0 5 0)) (vlax-3d-point '(10 5 0)))) (vla-put-Layer gjother "GOTZJI_UNRELATED")
 (vla-SaveAs gjdoc (getenv "GOTZJI_CAD_SOURCE"))
 (gjwrite (getenv "GOTZJI_CAD_RESULT") (strcat "{\"fixture\":" (gjline gje) ",\"unrelated\":" (gjline gjother) "}"))
) (progn
 (setq gje (vla-HandleToObject gjdoc (getenv "GOTZJI_CAD_HANDLE")))
 (if (/= (vla-get-ObjectName gje) "AcDbLine") (progn (gjwrite (getenv "GOTZJI_CAD_ERROR") "CAD_SESSION_ENTITY_UNSUPPORTED")) (progn
 (setq gjbefore (gjline gje) gjbeforeothers (gjothers gjspace (vla-get-Handle gje)))
 (if (equal gjoperation "cad.entity.move") (progn (vla-Move gje (vlax-3d-point '(0 0 0)) (vlax-3d-point (list (atof (getenv "GOTZJI_CAD_DX")) (atof (getenv "GOTZJI_CAD_DY")) (atof (getenv "GOTZJI_CAD_DZ"))))) (vla-SaveAs gjdoc (getenv "GOTZJI_CAD_OUTPUT"))))
 (gjwrite (getenv "GOTZJI_CAD_RESULT") (strcat "{\"before\":" gjbefore ",\"after\":" (gjline gje) ",\"unrelatedPreserved\":" (if (equal gjbeforeothers (gjothers gjspace (vla-get-Handle gje))) "true" "false") "}"))
 (gjwrite (strcat (getenv "GOTZJI_CAD_RESULT") ".others") gjbeforeothers)
 ))
))
))))
(princ)
))
(princ)

'@
# Inline SCR expressions avoid installing startup LISP or changing trusted paths/settings.
[IO.File]::WriteAllText($script, $lisp.Replace('@@NONCE@@', $nonce), [Text.Encoding]::ASCII)
$existing = @(Get-Process -Name ZWCAD -ErrorAction SilentlyContinue | Select-Object Id,StartTime)
$arguments = if ($request.operation -eq 'cad.session.fixture') { @('/B',('"'+$script+'"')) } else { @(('"'+$clone+'"'),'/B',('"'+$script+'"')) }
$cadProcess = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $stage -WindowStyle Hidden -PassThru
$cadProcess.Refresh()
$birth = $cadProcess.StartTime.ToUniversalTime().Ticks
[IO.File]::WriteAllText((Join-Path $stage 'ownership.json'), (@{ pid=$cadProcess.Id; birth=[string]$birth; executable=$exe; nonce=$nonce; stage=$stage } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
$deadline = [DateTime]::UtcNow.AddSeconds(45)
while (-not (Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline) { if ($cadProcess.HasExited) { break }; Start-Sleep -Milliseconds 100; $cadProcess.Refresh() }
if (-not (Test-Path -LiteralPath $ready)) { @{ok=$false;error=@{code='CAD_OWNED_STARTUP_NOT_OBSERVED';outcome='unknown'};ownedPid=$cadProcess.Id;stage=$stage}|ConvertTo-Json -Compress -Depth 5; exit 1 }
$metadata = [IO.File]::ReadAllLines($ready)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class GotzjiCadSessionWindow { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid); }
'@
$windowOwner = [uint32]0
[void][GotzjiCadSessionWindow]::GetWindowThreadProcessId([IntPtr][long]$metadata[1],[ref]$windowOwner)
$current = Get-Process -Id $cadProcess.Id -ErrorAction SilentlyContinue
$owned = $null -ne $current -and $metadata[0] -ceq $nonce -and $windowOwner -eq $cadProcess.Id -and $current.StartTime.ToUniversalTime().Ticks -eq $birth -and $current.Path -ieq $exe -and -not ($existing.Id -contains $cadProcess.Id)
$documentVerified = $owned -and $metadata[2] -eq '1' -and $metadata[3] -eq '0' -and [int]$metadata[5] -le 5000
if ($request.operation -eq 'cad.session.fixture') { $documentVerified = $documentVerified -and $metadata[4] -eq '0' -and $metadata[5] -eq '0' -and -not (Test-Path -LiteralPath $request.filePath) }
else { $documentVerified = $documentVerified -and $metadata[6] -ieq $clone }
if (-not $documentVerified) { @{ok=$false;error=@{code='CAD_OWNED_DOCUMENT_NOT_VERIFIED';outcome='unknown'};ownedPid=$cadProcess.Id;stage=$stage}|ConvertTo-Json -Compress -Depth 5; exit 1 }
[IO.File]::WriteAllText($approval, ($nonce + "`n"), [Text.Encoding]::ASCII)
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (-not (Test-Path -LiteralPath $resultFile) -and -not (Test-Path -LiteralPath $failureFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
$closed = $false
$current = Get-Process -Id $cadProcess.Id -ErrorAction SilentlyContinue
if ($null -ne $current -and $current.StartTime.ToUniversalTime().Ticks -eq $birth -and $current.Path -ieq $exe) { [void]$cadProcess.CloseMainWindow(); $closed = $cadProcess.WaitForExit(10000) }
if (-not $closed -or -not (Test-Path -LiteralPath $resultFile)) {
  $code = if (Test-Path -LiteralPath $failureFile) { ([IO.File]::ReadAllText($failureFile)).Trim() } else { 'CAD_SESSION_RESULT_UNVERIFIED' }
  @{ok=$false;error=@{code=$code;outcome='unknown'};ownedPid=$cadProcess.Id;stage=$stage}|ConvertTo-Json -Compress -Depth 5; exit 1
}
$unrelated = if (Test-Path -LiteralPath ($resultFile+'.others')) { (Get-FileHash -LiteralPath ($resultFile+'.others') -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
$originals = $true
foreach ($original in $existing) { $now=Get-Process -Id $original.Id -ErrorAction SilentlyContinue; if ($null -eq $now -or $now.StartTime -ne $original.StartTime) { $originals=$false } }
$native = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
@{ok=$true;value=@{native=$native;nativePid=$cadProcess.Id;birth=[string]$birth;providerVersion=$version.FileVersion;owned=$owned;closed=$closed;originalSessionsPreserved=$originals;unrelatedHash=$unrelated;stage=$stage}}|ConvertTo-Json -Compress -Depth 12
