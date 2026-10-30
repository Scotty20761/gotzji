param(
  [string]$BridgePath = (Join-Path $PSScriptRoot '..\packages\capabilities\src\windows-capability-bridge.ps1'),
  [string]$OutputRoot = (Join-Path $PSScriptRoot '..\.local-artifacts\v5.8.4\E-native-office\extension-acceptance'),
  [ValidateSet('all','word','excel','powerpoint')][string]$Application = 'all'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$runRoot = Join-Path $OutputRoot ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$bridgeSha256 = (Get-FileHash -LiteralPath $BridgePath -Algorithm SHA256).Hash
$fixtureBridgePath = Join-Path $runRoot 'bridge.ps1'
Copy-Item -LiteralPath $BridgePath -Destination $fixtureBridgePath
$BridgePath = $fixtureBridgePath
$tokens = $null; $errors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($BridgePath), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
foreach ($function in $tree.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $function.Extent.Text }
$invokerTree = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'verify-office-provider.ps1'), [ref]$tokens, [ref]$errors)
$invoker = $invokerTree.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Office' }, $true)
Invoke-Expression $invoker.Extent.Text
$ActionTimeoutSeconds = 30
$evidence = New-Object Collections.ArrayList
$word = $null; $excel = $null; $powerpoint = $null
$unicode = [string][char]0x0E44 + [char]0x0E17 + [char]0x0E22 + ' ' + [char]::ConvertFromUtf32(0x1F600)

function Assert-OfficeAcceptance {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}
function Invoke-Extension {
  param([string]$App, [string]$Action, [hashtable]$Fields = @{})
  $payload = @{}; foreach ($key in $Fields.Keys) { $payload[$key] = $Fields[$key] }; $payload.file_path = switch ($App) { 'word' { $wordPath }; 'excel' { $excelPath }; 'powerpoint' { $pptPath } }; $payload.timeout_seconds = 30
  $parsed = ($payload | ConvertTo-Json -Depth 20) | ConvertFrom-Json
  Write-Host ("[office-extension] {0}/{1}" -f $App, $Action)
  $result = Invoke-Office $App $Action $payload
  [void]$evidence.Add([ordered]@{ app = $App; action = $Action; status = 'passed'; result = $result })
  return $result
}

try {
  Add-Type -AssemblyName System.Drawing
  $imagePath = Join-Path $runRoot 'image.png'; $bitmap = [Drawing.Bitmap]::new(32,32)
  try { $bitmap.SetPixel(1,1,[Drawing.Color]::Red); $bitmap.Save($imagePath, [Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
  $wordPath = Join-Path $runRoot 'word.docx'; $excelPath = Join-Path $runRoot 'excel.xlsx'; $pptPath = Join-Path $runRoot 'powerpoint.pptx'
  if ($Application -in @('all', 'word')) {
  $wordFixture = [pscustomobject]@{ file_path = $wordPath; text = $unicode + ' preserved sibling text' }
  [void](Invoke-Office 'word' 'create' @{ file_path = $wordPath; text = $wordFixture.text })
  [void](Invoke-Office 'word' 'insert_table' @{ file_path = $wordPath; table = @{ rows = 2; columns = 2 } })
  [void](Invoke-Office 'word' 'insert_image' @{ file_path = $wordPath; image_path = $imagePath })
  [void](Invoke-Office 'word' 'add_comment' @{ file_path = $wordPath; range = @{ start = 0; end = 1 }; text = 'Fixture comment' })
  Invoke-Extension 'word' 'set_character_format' @{ range = @{ start = 0; end = 1 }; parameters = @{ bold = $true; size = 16 } } | Out-Null
  $runs = Invoke-Extension 'word' 'get_runs' @{ range = @{ start = 0; end = 1 } }
  Assert-OfficeAcceptance ($runs.runs.Count -eq 1 -and $runs.runs[0].font.bold -eq -1) 'Word formatting run was not persisted'
  Invoke-Extension 'word' 'set_paragraph_format' @{ parameters = @{ space_after = 6 } } | Out-Null
  Invoke-Extension 'word' 'set_alignment' @{ parameters = @{ alignment = 0 } } | Out-Null
  Invoke-Extension 'word' 'set_spacing' @{ parameters = @{ space_before = 4 } } | Out-Null
  Invoke-Extension 'word' 'create_or_update_style' @{ style = @{ name = 'ExtensionStyle'; font = @{ bold = $true }; paragraph = @{ space_after = 6 } } } | Out-Null
  $styles = Invoke-Extension 'word' 'get_styles'
  Assert-OfficeAcceptance (@($styles.styles | Where-Object { $_.name -eq 'ExtensionStyle' }).Count -eq 1) 'Word style did not survive reopen'
  Invoke-Extension 'word' 'add_heading' @{ text = 'Fixture heading'; parameters = @{ level = 1 } } | Out-Null
  Invoke-Extension 'word' 'add_page_break' | Out-Null
  Invoke-Extension 'word' 'add_section_break' | Out-Null
  Invoke-Extension 'word' 'create_or_update_style' @{ style = @{ name = 'ExtensionTableStyle'; type = 3 } } | Out-Null
  Invoke-Extension 'word' 'set_table_style' @{ table = @{ index = 1 }; parameters = @{ name = 'ExtensionTableStyle' } } | Out-Null
  Invoke-Extension 'word' 'merge_cells' @{ table = @{ index = 1; row = 1; column = 1 }; parameters = @{ end_row = 1; end_column = 2 } } | Out-Null
  Invoke-Extension 'word' 'split_cells' @{ table = @{ index = 1; row = 1; column = 1 }; parameters = @{ rows = 1; columns = 2 } } | Out-Null
  Invoke-Extension 'word' 'replace_image' @{ index = 1; image_path = $imagePath } | Out-Null
  Invoke-Extension 'word' 'add_textbox' @{ text = $unicode; parameters = @{ left = 10; top = 10; width = 100; height = 50 } } | Out-Null
  Invoke-Extension 'word' 'add_shape' @{ parameters = @{ type = 1; left = 10; top = 80; width = 100; height = 50 } } | Out-Null
  Invoke-Extension 'word' 'add_hyperlink' @{ range = @{ start = 0; end = 1 }; parameters = @{ address = 'https://example.test/fixture' } } | Out-Null
  Invoke-Extension 'word' 'edit_hyperlink' @{ index = 1; parameters = @{ address = 'https://example.test/updated' } } | Out-Null
  Invoke-Extension 'word' 'add_bookmark' @{ range = @{ start = 0; end = 1 }; parameters = @{ name = 'FixtureBookmark' } } | Out-Null
  Invoke-Extension 'word' 'remove_bookmark' @{ parameters = @{ name = 'FixtureBookmark' } } | Out-Null
  Invoke-Extension 'word' 'page_numbering' @{ parameters = @{ section = 1; alignment = 1 } } | Out-Null
  Invoke-Extension 'word' 'set_page_setup' @{ parameters = @{ section = 1; top_margin = 60 } } | Out-Null
  $setup = Invoke-Extension 'word' 'page_setup'
  Assert-OfficeAcceptance ([Math]::Abs($setup.page_setup.top_margin - 60) -lt 0.1) 'Word page setup was not persisted'
  Invoke-Extension 'word' 'add_footnote' @{ range = @{ start = 0; end = 0 }; text = $unicode } | Out-Null
  Invoke-Extension 'word' 'add_endnote' @{ range = @{ start = 0; end = 0 }; text = $unicode } | Out-Null
  $footnotes = Invoke-Extension 'word' 'get_footnotes'; $endnotes = Invoke-Extension 'word' 'get_endnotes'
  Assert-OfficeAcceptance ($footnotes.notes.Count -eq 1 -and $footnotes.notes[0].text.Contains($unicode) -and $endnotes.notes.Count -eq 1) 'Word notes lost content or identity after reopen'
  Invoke-Extension 'word' 'resolve_comment' @{ index = 1 } | Out-Null
  Invoke-Extension 'word' 'delete_comment' @{ index = 1 } | Out-Null
  $word = New-Object -ComObject Word.Application; $word.Visible = $false; $word.DisplayAlerts = 0; $word.AutomationSecurity = 3
  try { $document = $word.Documents.Open($wordPath); try { [void]$document.Fields.Add($document.Range($document.Content.End - 1,$document.Content.End - 1),31); [void]$document.TablesOfContents.Add($document.Range(0,0)); $document.Save() } finally { $document.Close($false) } } finally { $word.Quit(); Release-ComObject $word; $word = $null }
  Invoke-Extension 'word' 'get_fields' | Out-Null
  Invoke-Extension 'word' 'update_field' @{ index = 1 } | Out-Null
  Invoke-Extension 'word' 'update_toc' @{ index = 1 } | Out-Null
  [void](Invoke-Office 'word' 'append_text' @{ file_path = $wordPath; text = 'REPLACEDELETE' })
  $currentText = Invoke-Office 'word' 'read_text' @{ file_path = $wordPath }; $start = $currentText.text.Length - 14
  Invoke-Extension 'word' 'replace_range' @{ range = @{ start = $start; end = $start + 7 }; replace_with = $unicode } | Out-Null
  Invoke-Extension 'word' 'delete_range' @{ range = @{ start = $start; end = $start + $unicode.Length } } | Out-Null
  }

  if ($Application -in @('all', 'excel')) {
  [void](Invoke-Office 'excel' 'create' @{ file_path = $excelPath; sheet = 'Data' })
  [void](Invoke-Office 'excel' 'write_values' @{ file_path = $excelPath; sheet = 'Data'; range = 'A1:A3'; values = @(@($unicode), @(42), @(7)) })
  [void](Invoke-Office 'excel' 'add_sheet' @{ file_path = $excelPath; name = 'Target' })
  $inserted = Invoke-Office 'excel' 'insert_image' @{ file_path = $excelPath; sheet = 'Data'; range = 'C1'; image_path = $imagePath }
  [void](Invoke-Office 'excel' 'set_data_validation' @{ file_path = $excelPath; sheet = 'Data'; range = 'B1'; parameters = @{ type = 'whole'; formula1 = '0' } })
  [void](Invoke-Office 'excel' 'filter' @{ file_path = $excelPath; sheet = 'Data'; range = 'A1:A3'; parameters = @{ field = 1; criteria = '42' } })
  Invoke-Extension 'excel' 'create_named_range' @{ sheet = 'Data'; name = 'FixtureRange'; range = 'A1:A3' } | Out-Null
  Invoke-Extension 'excel' 'update_named_range' @{ sheet = 'Data'; name = 'FixtureRange'; range = 'A1:A2' } | Out-Null
  $names = Invoke-Extension 'excel' 'read_named_ranges'
  Assert-OfficeAcceptance (@($names.names | Where-Object { $_.name -eq 'FixtureRange' -and $_.refers_to -match 'A\$2' }).Count -eq 1) 'Excel named range was not persisted'
  Invoke-Extension 'excel' 'read_filters' @{ sheet = 'Data' } | Out-Null
  $validation = Invoke-Extension 'excel' 'read_data_validation' @{ sheet = 'Data'; range = 'B1' }
  Assert-OfficeAcceptance ($validation.validation.Count -eq 1) 'Excel validation was not observed'
  Invoke-Extension 'excel' 'copy_sheet' @{ sheet = 'Data'; new_name = 'Copied'; parameters = @{ target_sheet = 'Target' } } | Out-Null
  Invoke-Extension 'excel' 'move_sheet' @{ sheet = 'Copied'; parameters = @{ target_sheet = 'Data' } } | Out-Null
  Invoke-Extension 'excel' 'set_border' @{ sheet = 'Data'; range = 'A1:A3'; parameters = @{ line_style = 1; weight = 2; color = 255 } } | Out-Null
  Invoke-Extension 'excel' 'set_conditional_formatting' @{ sheet = 'Data'; range = 'A2:A3'; parameters = @{ type = 1; operator = 5; formula1 = '10'; color = 255 } } | Out-Null
  $conditions = Invoke-Extension 'excel' 'read_conditional_formatting' @{ sheet = 'Data'; range = 'A2:A3' }
  Assert-OfficeAcceptance ($conditions.conditions.Count -eq 1) 'Excel conditional formatting did not survive reopen'
  Invoke-Extension 'excel' 'delete_conditional_formatting' @{ sheet = 'Data'; range = 'A2:A3'; index = 1 } | Out-Null
  Invoke-Extension 'excel' 'add_hyperlink' @{ sheet = 'Data'; range = 'B2'; parameters = @{ address = 'https://example.test/fixture' } } | Out-Null
  Invoke-Extension 'excel' 'replace_image' @{ sheet = 'Data'; name = $inserted.shape; image_path = $imagePath } | Out-Null
  Invoke-Extension 'excel' 'connection_metadata' | Out-Null
  Invoke-Extension 'excel' 'list_macros' | Out-Null
  Invoke-Extension 'excel' 'delete_named_range' @{ name = 'FixtureRange' } | Out-Null
  $copied = Invoke-Office 'excel' 'read_values' @{ file_path = $excelPath; sheet = 'Copied'; range = 'A1:A3' }
  Assert-OfficeAcceptance ($copied.values[0][0] -eq $unicode -and $copied.values[1][0] -eq 42) 'Excel sheet mutation lost Unicode or unrelated cells'
  }

  if ($Application -in @('all', 'powerpoint')) {
  [void](Invoke-Office 'powerpoint' 'create' @{ file_path = $pptPath })
  [void](Invoke-Office 'powerpoint' 'add_slide' @{ file_path = $pptPath; parameters = @{ layout = 12 } })
  $textbox = Invoke-Office 'powerpoint' 'add_textbox' @{ file_path = $pptPath; slide = 1; text = $unicode; parameters = @{ left = 10; top = 10; width = 100; height = 50 } }; $textId = $textbox.shape
  $image = Invoke-Office 'powerpoint' 'add_image' @{ file_path = $pptPath; slide = 1; image_path = $imagePath; parameters = @{ left = 10; top = 80; width = 32; height = 32 } }; $imageId = $image.shape
  Invoke-Extension 'powerpoint' 'change_layout' @{ slide = 1; parameters = @{ layout = 12 } } | Out-Null
  Invoke-Extension 'powerpoint' 'edit_textbox' @{ slide = 1; shape = $textId; text = $unicode; parameters = @{ left = 20 } } | Out-Null
  $shape = Invoke-Extension 'powerpoint' 'add_shape' @{ slide = 1; text = 'Fixture'; parameters = @{ type = 1; left = 10; top = 120; width = 100; height = 50 } }
  Invoke-Extension 'powerpoint' 'edit_shape' @{ slide = 1; shape = [string]$shape.id; parameters = @{ fill_color = 255 } } | Out-Null
  Invoke-Extension 'powerpoint' 'add_hyperlink' @{ slide = 1; shape = [string]$shape.id; parameters = @{ address = 'https://example.test/fixture' } } | Out-Null
  $links = Invoke-Extension 'powerpoint' 'get_hyperlinks' @{ slide = 1 }
  Assert-OfficeAcceptance ($links.hyperlinks.Count -eq 1) 'PowerPoint hyperlink did not survive reopen'
  Invoke-Extension 'powerpoint' 'edit_image' @{ slide = 1; shape = $imageId; parameters = @{ width = 40 } } | Out-Null
  Invoke-Extension 'powerpoint' 'crop_image' @{ slide = 1; shape = $imageId; parameters = @{ left = 1; right = 1 } } | Out-Null
  Invoke-Extension 'powerpoint' 'set_background' @{ slide = 1; parameters = @{ color = 16777215 } } | Out-Null
  Invoke-Extension 'powerpoint' 'set_master' @{ slide = 1; parameters = @{ design = 1 } } | Out-Null
  $installedTheme = Join-Path $env:ProgramFiles 'Microsoft Office\root\Document Themes 16\Wisp.thmx'
  if (Test-Path -LiteralPath $installedTheme -PathType Leaf) {
    $themePath = Join-Path $runRoot 'fixture.thmx'
    Copy-Item -LiteralPath $installedTheme -Destination $themePath
    Invoke-Extension 'powerpoint' 'set_theme' @{ theme_path = $themePath } | Out-Null
  } else { [void]$evidence.Add([ordered]@{ app = 'powerpoint'; action = 'set_theme'; status = 'pending'; reason = 'Disposable local theme fixture is unavailable' }) }
  Invoke-Extension 'powerpoint' 'set_slide_size' @{ parameters = @{ width = 720; height = 540 } } | Out-Null
  Invoke-Extension 'powerpoint' 'set_transition' @{ slide = 1; parameters = @{ effect = 0; duration = 1; advance_on_click = $true } } | Out-Null
  $transition = Invoke-Extension 'powerpoint' 'get_transitions' @{ slide = 1 }
  Assert-OfficeAcceptance ($transition.transition.advance_on_click) 'PowerPoint transition did not survive reopen'
  Invoke-Extension 'powerpoint' 'export_images' @{ slide = 1; target_path = (Join-Path $runRoot 'slide.png') } | Out-Null
  Invoke-Extension 'powerpoint' 'remove_shape' @{ slide = 1; shape = [string]$shape.id } | Out-Null
  Invoke-Extension 'powerpoint' 'remove_image' @{ slide = 1; shape = $imageId } | Out-Null
  Invoke-Extension 'powerpoint' 'remove_textbox' @{ slide = 1; shape = $textId } | Out-Null
  }
  [ordered]@{ status = 'passed'; bridgeSha256 = $bridgeSha256; acceptance = 'Actual disposable Word/Excel/PowerPoint COM readback; account, macro, refresh, print and send actions excluded'; evidence = $evidence } | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $runRoot 'evidence.json') -Encoding UTF8
  Write-Output ("Office extension acceptance passed. Evidence saved in {0}" -f $runRoot)
} catch {
  [ordered]@{ status = 'failed'; error = $_.Exception.Message; trace = $_.ScriptStackTrace; evidence = $evidence } | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $runRoot 'evidence.json') -Encoding UTF8
  throw
} finally {
  foreach ($fixtureApplication in @($word, $excel, $powerpoint)) { if ($null -ne $fixtureApplication) { try { $fixtureApplication.Quit() } catch { }; Release-ComObject $fixtureApplication } }
}
