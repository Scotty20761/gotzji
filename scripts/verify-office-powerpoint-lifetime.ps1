param(
  [string]$BridgePath = (Join-Path $PSScriptRoot '..\packages\capabilities\src\windows-capability-bridge.ps1'),
  [string]$OutputRoot = (Join-Path $PSScriptRoot '..\.local-artifacts\v5.8.4\E-native-office\powerpoint-lifetime-acceptance')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$runRoot = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$bridgeSha256 = (Get-FileHash -LiteralPath $BridgePath -Algorithm SHA256).Hash
$fixtureBridge = Join-Path $runRoot 'bridge.ps1'; Copy-Item -LiteralPath $BridgePath -Destination $fixtureBridge; $BridgePath = $fixtureBridge
$tokens = $null; $errors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'verify-office-provider.ps1'), [ref]$tokens, [ref]$errors)
$invoker = $tree.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Office' }, $true)
Invoke-Expression $invoker.Extent.Text
$ActionTimeoutSeconds = 60
$application = $null; $unrelated = $null; $created = $false; $children = [Collections.ArrayList]::new()
function Start-OfficeFixtureCall {
  param([string]$Action, [hashtable]$OfficeInput)
  $id = [Guid]::NewGuid().ToString('N'); $request = Join-Path $runRoot ($id + '.json'); $stdout = Join-Path $runRoot ($id + '.stdout'); $stderr = Join-Path $runRoot ($id + '.stderr')
  $OfficeInput.app = 'powerpoint'; $OfficeInput.action = $Action
  @{ capability = 'office'; input = $OfficeInput } | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $request -Encoding UTF8
  $command = "`$json=Get-Content -LiteralPath '" + $request.Replace("'","''") + "' -Raw -Encoding UTF8; `$json | & '" + $BridgePath.Replace("'","''") + "'"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  $receipt = [ordered]@{ process = $process; stdout = $stdout; stderr = $stderr; action = $Action }
  [void]$children.Add($receipt)
  return $receipt
}
try {
  $unrelatedPath = Join-Path $runRoot 'unrelated.pptx'; $requestPath = Join-Path $runRoot 'request.pptx'; $video = Join-Path $runRoot 'request.mp4'
  [void](Invoke-Office 'powerpoint' 'create' @{ file_path = $unrelatedPath; text = 'Unrelated saved fixture' })
  [void](Invoke-Office 'powerpoint' 'create' @{ file_path = $requestPath; text = 'Concurrent request fixture' })
  try { $application = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
  catch [Runtime.InteropServices.COMException] { if ($_.Exception.HResult -ne -2147221021) { throw }; $application = New-Object -ComObject PowerPoint.Application; $created = $true }
  $unrelated = $application.Presentations.Open($unrelatedPath, $false, $false, $false)
  $originalSecurity = [int]$application.AutomationSecurity
  $unrelated.Slides.Item(1).Shapes.Item(1).TextFrame.TextRange.Text = 'Unrelated unsaved fixture'
  $hashBefore = (Get-FileHash -LiteralPath $unrelatedPath -Algorithm SHA256).Hash
  $sameFileRefused = $false
  try { [void](Invoke-Office 'powerpoint' 'get_transitions' @{ file_path = $unrelatedPath; slide = 1 }) }
  catch { $sameFileRefused = $_.Exception.Message -like '*already open*' }
  if (-not $sameFileRefused -or $unrelated.Slides.Item(1).Shapes.Item(1).TextFrame.TextRange.Text -ne 'Unrelated unsaved fixture') { throw 'An already-open borrowed presentation was reused or closed by the request' }
  $first = Start-OfficeFixtureCall 'export_video' @{ file_path = $requestPath; target_path = $video; timeout_seconds = 30 }
  $second = Start-OfficeFixtureCall 'set_background' @{ file_path = $requestPath; slide = 1; parameters = @{ color = 123456 }; timeout_seconds = 30 }
  if ($first.process.HasExited -or $second.process.HasExited) { throw 'Two fixture requests were not concurrently live' }
  $receipts = @()
  foreach ($child in @($first,$second)) {
    if (-not $child.process.WaitForExit(45000)) { throw 'Concurrent PowerPoint child exceeded its bounded timeout' }
    $raw = Get-Content -LiteralPath $child.stdout -Raw -Encoding UTF8
    $result = $raw | ConvertFrom-Json
    if (-not $result.ok) { throw ($child.action + ' failed: ' + $result.error.message) }
    $receipts += [ordered]@{ action = $child.action; result = $result.value }
  }
  if ($unrelated.Slides.Item(1).Shapes.Item(1).TextFrame.TextRange.Text -ne 'Unrelated unsaved fixture' -or $unrelated.Saved -ne 0 -or $application.AutomationSecurity -ne $originalSecurity -or (Get-FileHash -LiteralPath $unrelatedPath -Algorithm SHA256).Hash -ne $hashBefore) { throw 'Provider closed, saved, changed or lost the borrowed user-like presentation' }
  $check = $application.Presentations.Open($requestPath,$true,$false,$false)
  try { if ($check.Slides.Item(1).Background.Fill.ForeColor.RGB -ne 123456) { throw 'Concurrent mutation was not saved and reopened' } } finally { $check.Close() }
  if ((Get-Item -LiteralPath $video).Length -le 0) { throw 'Concurrent video export did not complete its artifact' }
  [ordered]@{ status = 'passed'; bridgeSha256 = $bridgeSha256; concurrentlyLiveRequests = 2; borrowedPresentationSurvived = $true; unsavedTextPreserved = $true; receipts = $receipts } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $runRoot 'evidence.json') -Encoding UTF8
  Write-Output ("Concurrent and borrowed PowerPoint lifetime acceptance passed. Evidence saved in {0}" -f $runRoot)
} catch {
  [ordered]@{ status = 'failed'; bridgeSha256 = $bridgeSha256; error = $_.Exception.Message; trace = $_.ScriptStackTrace } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'evidence.json') -Encoding UTF8
  throw
} finally {
  foreach ($child in $children) { if (-not $child.process.HasExited) { $child.process.Kill(); [void]$child.process.WaitForExit(5000) }; $child.process.Dispose() }
  if ($null -ne $unrelated) { try { $unrelated.Close() } catch { }; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($unrelated) }
  if ($null -ne $application) { if ($created -and $application.Presentations.Count -eq 0) { $application.Quit() }; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) }
}
