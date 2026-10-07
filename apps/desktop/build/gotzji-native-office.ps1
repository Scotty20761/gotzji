# Private, typed provider worker. Public operations must enter through Grace and a verified host grant.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$script:effectStarted = $false
$script:ownedPid = 0
$script:stage = 'validate'
$application = $null
$document = $null
$startupBlankNames=@()
$provider = ([string]$request.operation).Split('.')[0]
$providerMap = @{
  excel = @{ progId = 'Excel.Application'; process = 'EXCEL'; appPath = 'excel.exe' }
  word = @{ progId = 'Word.Application'; process = 'WINWORD'; appPath = 'winword.exe' }
  powerpoint = @{ progId = 'PowerPoint.Application'; process = 'POWERPNT'; appPath = 'powerpnt.exe' }
  cad = @{ progId = 'ZWCAD.Application.2025'; process = 'ZWCAD'; appPath = 'zwcad.exe' }
}
function Hash-File([string]$File) { return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function As-Json($Value) { return ($Value | ConvertTo-Json -Depth 30 -Compress) }
function Media-Snapshot([string]$File) {
  if ([IO.Path]::GetExtension($File) -notin @('.xlsx','.xlsm','.docx','.pptx')) { return @() }
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
  $archive=[IO.Compression.ZipFile]::OpenRead($File)
  try {
    $items=@()
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName -notmatch '^(xl|word|ppt)/media/' -and $entry.FullName -notmatch 'vbaProject\.bin$') { continue }
      $stream=$entry.Open(); $algorithm=[Security.Cryptography.SHA256]::Create()
      try { $digest=[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant(); $items += [ordered]@{ hash=$digest; length=$entry.Length } }
      finally { $stream.Dispose(); $algorithm.Dispose() }
    }
    return @($items | Sort-Object hash,length)
  } finally { $archive.Dispose() }
}
function Fail([string]$Code) { throw $Code }
function Release-Com($Value) { if ($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value) } }
function Provider-Discovery {
  $items = @()
  foreach ($name in @('excel','word','powerpoint','cad')) {
    $spec = $providerMap[$name]
    $key = 'Registry::HKEY_CLASSES_ROOT\' + $spec.progId
    $registered = Test-Path -LiteralPath $key
    $appPath = Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $spec.appPath) -ErrorAction SilentlyContinue
    $executable = if ($null -ne $appPath) { [string]$appPath.'(default)' } else { '' }
    if (-not $executable -and $name -eq 'cad' -and $registered) {
      $classId = (Get-Item -LiteralPath ($key + '\CLSID')).GetValue('')
      $command = [string](Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\CLSID\' + $classId + '\LocalServer32')).GetValue('')
      if ($command -match '^"([^"]+)"') { $executable = $matches[1] } elseif ($command -match '^(.+?\.exe)') { $executable = $matches[1] }
    }
    $installed = $executable -and (Test-Path -LiteralPath $executable -PathType Leaf)
    $active = @(Get-Process -Name $spec.process -ErrorAction SilentlyContinue)
    $items += [ordered]@{ provider = $name; registered = [bool]$registered; installed = [bool]$installed; executable = $executable; version = if ($installed) { (Get-Item -LiteralPath $executable).VersionInfo.FileVersion } else { $null }; state = if (-not $installed -or -not $registered) { 'unavailable' } elseif ($active.Count -gt 0) { 'action-required' } else { 'installed-unqualified' }; reason = if ($active.Count -gt 0) { 'NATIVE_SESSION_IN_USE' } elseif (-not $installed -or -not $registered) { 'NATIVE_PROVIDER_NOT_INSTALLED' } else { 'NATIVE_QUALIFICATION_REQUIRED' }; activeProcessCount = $active.Count }
  }
  return $items
}
function Excel-Snapshot($Book, [string]$SheetName, [string]$Address) {
  $targetSheet = $Book.Worksheets.Item($SheetName)
  $target = $targetSheet.Range($Address)
  if ([int]$target.CountLarge -gt 10000) { Fail 'NATIVE_RANGE_TOO_LARGE' }
  $selected = @(); $unrelated = @(); $structure = @()
  foreach ($sheet in $Book.Worksheets) {
    $used = $sheet.UsedRange
    if ([int]$used.CountLarge -gt 10000) { Fail 'NATIVE_PRESERVATION_SCOPE_TOO_LARGE' }
    $shapes = @(); foreach ($shape in $sheet.Shapes) { $shapes += [ordered]@{ name=[string]$shape.Name; type=[int]$shape.Type; left=[double]$shape.Left; top=[double]$shape.Top; width=[double]$shape.Width; height=[double]$shape.Height } }
    $tables = @(); foreach ($table in $sheet.ListObjects) { $tables += [ordered]@{ name=[string]$table.Name; range=[string]$table.Range.Address($false,$false) } }
    $structure += [ordered]@{ sheet=[string]$sheet.Name; shapeCount=[int]$sheet.Shapes.Count; charts=[int]$sheet.ChartObjects().Count; tables=$tables; shapes=$shapes }
    foreach ($cell in $used.Cells) {
      $item = [ordered]@{ sheet=[string]$sheet.Name; address=[string]$cell.Address($false,$false); value=$cell.Value2; formula=$cell.Formula; format=[string]$cell.NumberFormat; bold=[bool]$cell.Font.Bold }
      $inside = [string]$sheet.Name -eq $SheetName -and [int]$cell.Row -ge [int]$target.Row -and [int]$cell.Row -lt ([int]$target.Row+[int]$target.Rows.Count) -and [int]$cell.Column -ge [int]$target.Column -and [int]$cell.Column -lt ([int]$target.Column+[int]$target.Columns.Count)
      if ($inside) { $selected += $item } else {
        # Formula text/format must survive; a legitimately recalculated cached
        # value can change when the selected input cell changes.
        if ($cell.HasFormula) { $item.value=$null }
        $unrelated += $item
      }
    }
  }
  return [ordered]@{ selected=$selected; unrelated=$unrelated; structure=$structure }
}
function Word-Snapshot($Doc, [int]$ParagraphIndex) {
  if ($Doc.Paragraphs.Count -gt 10000) { Fail 'NATIVE_PRESERVATION_SCOPE_TOO_LARGE' }
  if ($ParagraphIndex -lt 1 -or $ParagraphIndex -gt $Doc.Paragraphs.Count) { Fail 'NATIVE_OBJECT_NOT_FOUND' }
  $rows=@(); $selected=$null
  for ($index=1; $index -le $Doc.Paragraphs.Count; $index++) {
    $paragraphObject = $Doc.Paragraphs.Item($index)
    $item=[ordered]@{ index=$index; text=[string]$paragraphObject.Range.Text; style=[string]$paragraphObject.Style.NameLocal; bold=[int]$paragraphObject.Range.Font.Bold }
    if ($index -eq $ParagraphIndex) { $selected=$item } else { $rows += $item }
  }
  return [ordered]@{ selected=$selected; unrelated=$rows; structure=[ordered]@{ paragraphs=[int]$Doc.Paragraphs.Count; tables=[int]$Doc.Tables.Count; inlineShapes=[int]$Doc.InlineShapes.Count; shapes=[int]$Doc.Shapes.Count; sections=[int]$Doc.Sections.Count } }
}
function PowerPoint-Snapshot($Presentation, [int]$SlideIndex, [string]$ShapeName) {
  if ($Presentation.Slides.Count -gt 1000) { Fail 'NATIVE_PRESERVATION_SCOPE_TOO_LARGE' }
  $rows=@(); $selected=$null; $structure=@()
  foreach ($slide in $Presentation.Slides) {
    if ($slide.Shapes.Count -gt 1000 -or $rows.Count -gt 10000) { Fail 'NATIVE_PRESERVATION_SCOPE_TOO_LARGE' }
    $structure += [ordered]@{ slide=[int]$slide.SlideIndex; count=[int]$slide.Shapes.Count; layout=[int]$slide.Layout }
    foreach ($shape in $slide.Shapes) {
      $item=[ordered]@{ slide=[int]$slide.SlideIndex; name=[string]$shape.Name; type=[int]$shape.Type; text=if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { [string]$shape.TextFrame.TextRange.Text } else { '' }; left=[double]$shape.Left; top=[double]$shape.Top; width=[double]$shape.Width; height=[double]$shape.Height }
      if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { $item.font=[ordered]@{ name=[string]$shape.TextFrame.TextRange.Font.Name; size=[double]$shape.TextFrame.TextRange.Font.Size; bold=[int]$shape.TextFrame.TextRange.Font.Bold; italic=[int]$shape.TextFrame.TextRange.Font.Italic } }
      if ([int]$slide.SlideIndex -eq $SlideIndex -and [string]$shape.Name -eq $ShapeName) { $selected=$item } else { $rows += $item }
    }
  }
  if ($null -eq $selected) { Fail 'NATIVE_OBJECT_NOT_FOUND' }
  return [ordered]@{ selected=$selected; unrelated=$rows; structure=$structure }
}
function Cad-Snapshot($Drawing, [string]$Handle) {
  if ($Drawing.ModelSpace.Count -gt 10000) { Fail 'NATIVE_PRESERVATION_SCOPE_TOO_LARGE' }
  $rows=@(); $selected=$null; $layers=@()
  foreach ($layer in $Drawing.Layers) { $layers += [ordered]@{ name=[string]$layer.Name; color=[int]$layer.Color; frozen=[bool]$layer.Freeze; locked=[bool]$layer.Lock } }
  foreach ($entity in $Drawing.ModelSpace) {
    $item=[ordered]@{ handle=[string]$entity.Handle; type=[string]$entity.ObjectName; layer=[string]$entity.Layer }
    if ([string]$entity.ObjectName -eq 'AcDbLine') { $item.start=@($entity.StartPoint); $item.end=@($entity.EndPoint); $item.length=[double]$entity.Length }
    elseif ($request.operation -eq 'cad.entity.move') { Fail 'NATIVE_PRESERVATION_GEOMETRY_UNSUPPORTED' }
    if ([string]$entity.Handle -eq $Handle) { $selected=$item } else { $rows += $item }
  }
  if ($null -eq $selected) { Fail 'NATIVE_OBJECT_NOT_FOUND' }
  return [ordered]@{ selected=$selected; unrelated=$rows; structure=[ordered]@{ count=[int]$Drawing.ModelSpace.Count; layers=$layers } }
}
try {
  if ($request.operation -eq 'discover') { $value = Provider-Discovery; [Console]::Write((As-Json ([ordered]@{ ok=$true; value=@($value) }))); exit 0 }
  $allowed=@('excel.range.read','excel.range.write','word.paragraph.read','word.paragraph.write','powerpoint.shape.read','powerpoint.shape.write','cad.entity.inspect','cad.entity.move')
  if ($allowed -notcontains [string]$request.operation) { Fail 'NATIVE_OPERATION_UNSUPPORTED' }
  $source=[IO.Path]::GetFullPath([string]$request.filePath)
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { Fail 'NATIVE_FILE_NOT_FOUND' }
  if ((Hash-File $source) -ne [string]$request.expectedSha256) { Fail 'NATIVE_FILE_VERSION_CONFLICT' }
  $write=[string]$request.operation -match '\.(write|move)$'
  $output=if ($write) { [IO.Path]::GetFullPath([string]$request.outputPath) } else { $null }
  if ($write -and ($source -eq $output -or (Test-Path -LiteralPath $output) -or [IO.Path]::GetExtension($source) -ne [IO.Path]::GetExtension($output))) { Fail 'NATIVE_OUTPUT_DENIED' }
  $sourceMedia=@(Media-Snapshot $source)
  $spec=$providerMap[$provider]
  $existingProviderPids=@(Get-Process -Name $spec.process -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($provider -ne 'cad' -and $existingProviderPids.Count -gt 0) { Fail 'NATIVE_SESSION_IN_USE' }
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GotzjiNativePid { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid); public static uint For(long hwnd) { uint pid; GetWindowThreadProcessId(new IntPtr(hwnd),out pid); return pid; } }' | Out-Null
  $script:stage='start'
  $application=New-Object -ComObject $spec.progId
  if ($provider -ne 'word') { $script:ownedPid=[int][GotzjiNativePid]::For([long]$application.HWND); if ($script:ownedPid -lt 1 -or (Get-Process -Id $script:ownedPid).ProcessName -ne $spec.process) { Fail 'NATIVE_SESSION_IDENTITY_UNVERIFIED' }; if ($existingProviderPids -contains $script:ownedPid) { $script:ownedPid=0; Fail 'NATIVE_SESSION_IN_USE' } }
  $version=[string]$application.Version
  if ($provider -eq 'excel') { $application.Visible=$false; $application.DisplayAlerts=$false; $application.AutomationSecurity=3; if ($application.Workbooks.Count -ne 0) { Fail 'NATIVE_SESSION_IN_USE' }; $document=$application.Workbooks.Open($source,0,$true); $before=Excel-Snapshot $document ([string]$request.sheet) ([string]$request.range) }
  elseif ($provider -eq 'word') { $application.Visible=$false; $application.DisplayAlerts=0; $application.AutomationSecurity=3; if ($application.Documents.Count -ne 0) { Fail 'NATIVE_SESSION_IN_USE' }; $document=$application.Documents.Open($source,$false,$true); $script:ownedPid=[int][GotzjiNativePid]::For([long]$document.Windows.Item(1).Hwnd); if ($script:ownedPid -lt 1 -or (Get-Process -Id $script:ownedPid).ProcessName -ne $spec.process) { Fail 'NATIVE_SESSION_IDENTITY_UNVERIFIED' }; $before=Word-Snapshot $document ([int]$request.paragraph) }
  elseif ($provider -eq 'powerpoint') { $application.AutomationSecurity=3; if ($application.Presentations.Count -ne 0) { Fail 'NATIVE_SESSION_IN_USE' }; $document=$application.Presentations.Open($source,$true,$false,$false); $before=PowerPoint-Snapshot $document ([int]$request.slide) ([string]$request.shape) }
  else { $application.Visible=$false; foreach ($startupDocument in $application.Documents) { if ($startupDocument.ModelSpace.Count -eq 0 -and $startupDocument.PaperSpace.Count -eq 0 -and $startupDocument.Saved) { $startupBlankNames += [string]$startupDocument.Name } }; $document=$application.Documents.Open($source,$true); $before=Cad-Snapshot $document ([string]$request.handle) }
  $after=$before
  if ($write) {
    $script:effectStarted=$true
    if ($provider -eq 'excel') {
      $script:stage='write'
      $target=$document.Worksheets.Item([string]$request.sheet).Range([string]$request.range)
      $values=@($request.values)
      if ($values.Count -ne [int]$target.Rows.Count) { Fail 'NATIVE_MATRIX_DIMENSIONS_INVALID' }
      for ($row=0; $row -lt $values.Count; $row++) { if ($values[$row] -isnot [Array] -or @($values[$row]).Count -ne [int]$target.Columns.Count) { Fail 'NATIVE_MATRIX_DIMENSIONS_INVALID' }; for ($column=0; $column -lt @($values[$row]).Count; $column++) { $value=$values[$row][$column]; if ($value -is [string]) { $value="'"+$value }; $target.Cells.Item($row+1,$column+1).Value2=$value } }
      $script:stage='save-reopen'
      $document.SaveAs($output,[int]$document.FileFormat); $document.Close($false); Release-Com $document; $document=$application.Workbooks.Open($output,0,$true); $after=Excel-Snapshot $document ([string]$request.sheet) ([string]$request.range)
      $target=$document.Worksheets.Item([string]$request.sheet).Range([string]$request.range)
      for ($row=0; $row -lt $values.Count; $row++) { for ($column=0; $column -lt @($values[$row]).Count; $column++) { if ((As-Json $target.Cells.Item($row+1,$column+1).Value2) -ne (As-Json $values[$row][$column])) { Fail 'NATIVE_POSTCONDITION_FAILED' } } }
    } elseif ($provider -eq 'word') {
      $script:stage='write-save-reopen'
      if ($document.Paragraphs.Item([int]$request.paragraph).Range.Information(12)) { Fail 'NATIVE_TABLE_PARAGRAPH_UNSUPPORTED' }
      $range=$document.Paragraphs.Item([int]$request.paragraph).Range.Duplicate; $range.End=$range.End-1; $range.Text=[string]$request.text; $document.SaveAs2($output,12); $document.Close($false); Release-Com $document; $document=$application.Documents.Open($output,$false,$true); $after=Word-Snapshot $document ([int]$request.paragraph)
      if ($after.selected.text.TrimEnd([char]13) -ne [string]$request.text) { Fail 'NATIVE_POSTCONDITION_FAILED' }
      if ($before.selected.style -ne $after.selected.style -or $before.selected.bold -ne $after.selected.bold) { Fail 'NATIVE_STYLE_PRESERVATION_FAILED' }
    } elseif ($provider -eq 'powerpoint') {
      $script:stage='write-save-reopen'
      $shape=$document.Slides.Item([int]$request.slide).Shapes.Item([string]$request.shape); if (-not $shape.HasTextFrame) { Fail 'NATIVE_OBJECT_UNSUPPORTED' }; $shape.TextFrame.AutoSize=0; $shape.TextFrame.TextRange.Text=[string]$request.text; $shape.Left=[double]$before.selected.left; $shape.Top=[double]$before.selected.top; $shape.Width=[double]$before.selected.width; $shape.Height=[double]$before.selected.height; $document.SaveAs($output,24); $document.Close(); Release-Com $document; $document=$application.Presentations.Open($output,$true,$false,$false); $after=PowerPoint-Snapshot $document ([int]$request.slide) ([string]$request.shape)
      if ($after.selected.text -ne [string]$request.text) { Fail 'NATIVE_POSTCONDITION_FAILED' }
    } else {
      $entity=$document.HandleToObject([string]$request.handle); if ($entity.ObjectName -ne 'AcDbLine') { Fail 'NATIVE_GEOMETRY_UNSUPPORTED' }; $entity.Move([double[]]@(0,0,0),[double[]]@($request.displacement)); $document.SaveAs($output); $document.Close($false); Release-Com $document; $document=$application.Documents.Open($output,$true); $after=Cad-Snapshot $document ([string]$request.handle)
      for ($index=0; $index -lt 3; $index++) { if ([Math]::Abs(([double]$after.selected.start[$index]-[double]$before.selected.start[$index])-[double]$request.displacement[$index]) -gt 0.000001) { Fail 'NATIVE_POSTCONDITION_FAILED' } }
    }
    $script:stage='verify'
    if ((As-Json $before.unrelated) -ne (As-Json $after.unrelated) -or (As-Json $before.structure) -ne (As-Json $after.structure)) { Fail 'NATIVE_PRESERVATION_FAILED' }
    if ($provider -eq 'powerpoint') { foreach ($key in @('left','top','width','height')) { if ([Math]::Abs([double]$before.selected[$key]-[double]$after.selected[$key]) -gt 0.00001) { Fail 'NATIVE_LAYOUT_PRESERVATION_FAILED' } } }
    if ((As-Json $sourceMedia) -ne (As-Json @(Media-Snapshot $output))) { Fail 'NATIVE_MEDIA_PRESERVATION_FAILED' }
  }
  if ((Hash-File $source) -ne [string]$request.expectedSha256) { Fail 'NATIVE_ORIGINAL_CHANGED' }
  $binaryVersion=[string](Get-Item -LiteralPath (Get-Process -Id $script:ownedPid).Path).VersionInfo.FileVersion
  $value=[ordered]@{ operation=[string]$request.operation; provider=$provider; providerVersion=$binaryVersion; automationVersion=$version; nativePid=$script:ownedPid; sourceSha256=[string]$request.expectedSha256; outputSha256=if ($write) { Hash-File $output } else { $null }; originalPreserved=$true; savedAndReopened=[bool]$write; unrelatedPreserved=$true; verified=$true; before=$before; after=$after }
  [Console]::Write((As-Json ([ordered]@{ ok=$true; value=$value })))
} catch {
  [Console]::Error.WriteLine($_.ScriptStackTrace)
  $code=[string]$_.Exception.Message
  if ($code -notmatch '^[A-Z][A-Z0-9_]{1,79}$') { $code='NATIVE_COM_OPERATION_FAILED' }
  [Console]::Write((As-Json ([ordered]@{ ok=$false; error=[ordered]@{ code=$code; field=$script:stage; outcome=if ($script:effectStarted -or ($null -ne $application -and $script:ownedPid -eq 0)) { 'unknown' } else { 'none' } } })))
} finally {
  if ($null -ne $document) { try { if ($provider -eq 'powerpoint') { $document.Close() } else { $document.Close($false) } } catch {}; Release-Com $document }
  if ($null -ne $application) {
    if ($provider -eq 'cad' -and $script:ownedPid -gt 0) { foreach ($blankDocument in @($application.Documents)) { try { if ($startupBlankNames -contains [string]$blankDocument.Name -and $blankDocument.ModelSpace.Count -eq 0 -and $blankDocument.PaperSpace.Count -eq 0 -and $blankDocument.Saved) { $blankDocument.Close($false) } } catch {} } }
    try { $remaining=if ($provider -eq 'excel') { $application.Workbooks.Count } elseif ($provider -eq 'powerpoint') { $application.Presentations.Count } else { $application.Documents.Count }; if ($remaining -eq 0 -and $script:ownedPid -gt 0) { $application.Quit() } } catch {}
    Release-Com $application
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
