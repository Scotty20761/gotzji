param(
  [string]$BridgePath = (Join-Path $PSScriptRoot '..\packages\capabilities\src\windows-capability-bridge.ps1'),
  [string]$OutputRoot = (Join-Path $PSScriptRoot '..\.local-artifacts\v5.8.4\E-native-office\merge-video-acceptance')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$runRoot = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$bridgeSha256 = (Get-FileHash -LiteralPath $BridgePath -Algorithm SHA256).Hash
$fixtureBridgePath = Join-Path $runRoot 'bridge.ps1'
Copy-Item -LiteralPath $BridgePath -Destination $fixtureBridgePath
$BridgePath = $fixtureBridgePath
$tokens = $null; $errors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'verify-office-provider.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$invoker = $tree.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Office' }, $true)
Invoke-Expression $invoker.Extent.Text
$ActionTimeoutSeconds = 45
$evidence = [Collections.ArrayList]::new()
$word = $null
$name = [string][char]0x0E44 + [char]0x0E17 + [char]0x0E22 + ' ' + [char]::ConvertFromUtf32(0x1F600)
try {
  $template = Join-Path $runRoot 'template.docx'; $source = Join-Path $runRoot 'source.csv'; $merged = Join-Path $runRoot 'merged.docx'
  [IO.File]::WriteAllText($source, ('Name' + "`r`n" + '"' + $name + '"' + "`r`n"), [Text.UTF8Encoding]::new($true))
  [void](Invoke-Office 'word' 'create' @{ file_path = $template; text = 'Greeting ' })
  $word = New-Object -ComObject Word.Application; $word.Visible = $false; $word.DisplayAlerts = 0; $word.AutomationSecurity = 3; $word.Options.UpdateLinksAtOpen = $false
  try {
    $document = $word.Documents.Open($template)
    try { [void]$document.Fields.Add($document.Range($document.Content.End - 1,$document.Content.End - 1),59,'Name',$false); $document.MailMerge.MainDocumentType = 0; $document.Save() } finally { $document.Close($false) }
  } finally { $word.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word); $word = $null }
  $preview = Invoke-Office 'word' 'mail_merge_preview' @{ file_path = $template; source_path = $source; parameters = @{ record = 1 } }
  if (-not $preview.rendered_text.Contains($name)) { throw 'Mail merge preview lost the selected Unicode record' }
  [void]$evidence.Add([ordered]@{ app = 'word'; action = 'mail_merge_preview'; status = 'passed' })
  $merge = Invoke-Office 'word' 'mail_merge' @{ file_path = $template; source_path = $source; target_path = $merged; parameters = @{ first_record = 1; last_record = 1 } }
  $readback = Invoke-Office 'word' 'read_text' @{ file_path = $merged }
  if (-not $readback.text.Contains($name) -or -not $merge.output.verified) { throw 'Mail merge output failed artifact and Unicode readback' }
  [void]$evidence.Add([ordered]@{ app = 'word'; action = 'mail_merge'; status = 'passed'; bytes = $merge.output.bytes })
  $presentation = Join-Path $runRoot 'presentation.pptx'; $video = Join-Path $runRoot 'presentation.mp4'
  [void](Invoke-Office 'powerpoint' 'create' @{ file_path = $presentation; text = 'Disposable video fixture' })
  $export = Invoke-Office 'powerpoint' 'export_video' @{ file_path = $presentation; target_path = $video; timeout_seconds = 30 }
  $stream = [IO.File]::OpenRead($video)
  try { $prefix = New-Object byte[] 12; [void]$stream.Read($prefix,0,12); if ([Text.Encoding]::ASCII.GetString($prefix,4,4) -ne 'ftyp') { throw 'Video export is not an MP4 container' } } finally { $stream.Dispose() }
  if (-not $export.output.verified -or $export.output.bytes -le 0) { throw 'Video export did not verify its completed artifact' }
  [void]$evidence.Add([ordered]@{ app = 'powerpoint'; action = 'export_video'; status = 'passed'; bytes = $export.output.bytes })
  [ordered]@{ status = 'passed'; bridgeSha256 = $bridgeSha256; evidence = $evidence } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $runRoot 'evidence.json') -Encoding UTF8
  Write-Output ("Mail merge and video acceptance passed. Evidence saved in {0}" -f $runRoot)
} catch {
  [ordered]@{ status = 'failed'; error = $_.Exception.Message; trace = $_.ScriptStackTrace; evidence = $evidence } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $runRoot 'evidence.json') -Encoding UTF8
  throw
} finally { if ($null -ne $word) { try { $word.Quit() } catch { }; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) } }
