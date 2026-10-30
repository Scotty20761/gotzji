param([string]$BridgePath = (Join-Path $PSScriptRoot '..\packages\capabilities\src\windows-capability-bridge.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$tokens = $null; $errors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($BridgePath), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
foreach ($function in $tree.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $function.Extent.Text }

class CapturedRecipient {
  [string]$Address
  [string]$Name
  [int]$Type = 1
  CapturedRecipient([string]$address) { $this.Address = $address; $this.Name = $address }
  [bool]Resolve() { return $true }
  [string]FreeBusy([datetime]$start, [int]$step, [bool]$complete) { return ('0' * 1000) }
}
class CapturedRecipients {
  [Collections.ArrayList]$Values = [Collections.ArrayList]::new()
  [int]$Count = 0
  [object]Add([string]$address) { $recipient = [CapturedRecipient]::new($address); [void]$this.Values.Add($recipient); $this.Count = $this.Values.Count; return $recipient }
  [object]Item([int]$index) { return $this.Values[$index-1] }
  [void]Remove([int]$index) { $this.Values.RemoveAt($index-1); $this.Count = $this.Values.Count }
  [bool]ResolveAll() { return $true }
}
class CapturedStore {
  [object]GetDefaultFolder([int]$kind) { return [pscustomobject]@{ EntryID = 'source-store-deleted' } }
}
class CapturedItem {
  [int]$Class
  [string]$EntryID = 'fixture-id'
  [object]$Parent = [pscustomobject]@{ EntryID = 'source-folder'; Store = [CapturedStore]::new() }
  [CapturedRecipients]$Recipients = [CapturedRecipients]::new()
  [bool]$Saved = $false
  [bool]$Sent = $false
  [bool]$Deleted = $false
  [string]$Body = 'Original body'
  [int]$MeetingStatus = 1
  [int]$ResponseStatus = 1
  [bool]$ReminderSet = $false
  [int]$ReminderMinutesBeforeStart = 0
  [string]$Location = ''
  [string]$Categories = ''
  [string]$DLName = ''
  [int]$MemberCount = 0
  [Collections.ArrayList]$Members = [Collections.ArrayList]::new()
  [object]$Pattern = [pscustomobject]@{ RecurrenceType = 0; Interval = 1; DayOfWeekMask = 1; DayOfMonth = 1; MonthOfYear = 1; Instance = 1; Occurrences = 1; NoEndDate = $true }
  [object]$Moved = $null
  [int]$Response = 0
  [bool]$NoUI = $false
  CapturedItem([int]$itemClass) { $this.Class = $itemClass }
  [void]Save() { $this.Saved = $true }
  [void]Send() { $this.Sent = $true }
  [void]Delete() { $this.Deleted = $true }
  [object]Reply() { return [CapturedItem]::new(43) }
  [object]ReplyAll() { return [CapturedItem]::new(43) }
  [object]Forward() { return [CapturedItem]::new(43) }
  [object]Move([object]$folder) { $item = [CapturedItem]::new($this.Class); $item.Parent = $folder; $this.Moved = $item; return $item }
  [object]GetRecurrencePattern() { return $this.Pattern }
  [object]Respond([int]$response, [bool]$noUI, [bool]$textDialog) { $this.Response = $response; $this.NoUI = $noUI; return [CapturedItem]::new(53) }
  [void]AddMember([object]$member) { [void]$this.Members.Add($member); $this.MemberCount = $this.Members.Count }
  [object]GetMember([int]$index) { return $this.Members[$index-1] }
  [void]RemoveMember([object]$member) { $this.Members.Remove($member); $this.MemberCount = $this.Members.Count }
}
class CapturedNamespace {
  [CapturedItem]$Item
  CapturedNamespace([int]$itemClass) { $this.Item = [CapturedItem]::new($itemClass) }
  [object]GetItemFromID([string]$id) { if ($id -ne 'fixture-id') { throw 'Unexpected fixture identity' }; return $this.Item }
  [object]GetFolderFromID([string]$id) { return [pscustomobject]@{ EntryID = $id; DefaultItemType = 1 } }
  [object]CreateRecipient([string]$address) { return [CapturedRecipient]::new($address) }
}
class CapturedOutlook {
  [CapturedItem]$Group = [CapturedItem]::new(69)
  [object]CreateItem([int]$kind) { if ($kind -ne 7) { throw 'Unexpected fixture kind' }; return $this.Group }
}
function Assert-CapturedOffice {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}
function Invoke-CapturedOffice {
  param([string]$Action, [CapturedNamespace]$Namespace, [hashtable]$Payload)
  $parsed = ($Payload | ConvertTo-Json -Depth 10) | ConvertFrom-Json
  return Invoke-OutlookExtendedAction ([CapturedOutlook]::new()) $Namespace $Action $parsed
}

foreach ($action in @('reply_draft', 'reply_all_draft', 'forward_draft')) {
  $namespace = [CapturedNamespace]::new(43)
  $result = Invoke-CapturedOffice $action $namespace @{ message_id = 'fixture-id'; body = 'New body'; to = @('fixture@example.test') }
  Assert-CapturedOffice ($result.saved -and -not $result.sent -and $result.draft_id -eq 'fixture-id' -and -not $namespace.Item.Sent) 'Reply/forward dispatch sent a message or lost the draft identity'
}
$namespace = [CapturedNamespace]::new(43)
$deleted = Invoke-CapturedOffice 'permanent_delete' $namespace @{ message_id = 'fixture-id' }
Assert-CapturedOffice ($deleted.permanent -and $namespace.Item.Moved.Deleted -and $namespace.Item.Moved.Parent.EntryID -eq 'source-store-deleted') 'Permanent deletion did not use the source message store'

$namespace = [CapturedNamespace]::new(26)
$availability = Invoke-CapturedOffice 'availability' $namespace @{ start = '2026-10-12T00:00:00Z'; end = '2026-10-12T01:00:00Z'; attendees = @('fixture@example.test') }
Assert-CapturedOffice ($availability.availability[0].slots -eq '00' -and $availability.availability[0].complete) 'Availability did not bound its observed interval'
$moved = Invoke-CapturedOffice 'move_event' $namespace @{ event_id = 'fixture-id'; target_calendar = 'target-calendar' }
Assert-CapturedOffice ($moved.calendar_id -eq 'target-calendar') 'Calendar movement lost its returned target identity'
[void](Invoke-CapturedOffice 'add_attendees' $namespace @{ event_id = 'fixture-id'; attendees = @('fixture@example.test') })
Assert-CapturedOffice ($namespace.Item.Recipients.Count -eq 1 -and $namespace.Item.Saved -and -not $namespace.Item.Sent) 'Attendee addition did not save locally without sending'
[void](Invoke-CapturedOffice 'remove_attendees' $namespace @{ event_id = 'fixture-id'; attendees = @('fixture@example.test') })
Assert-CapturedOffice ($namespace.Item.Recipients.Count -eq 0 -and -not $namespace.Item.Sent) 'Attendee removal sent a meeting or failed to remove the exact recipient'
[void](Invoke-CapturedOffice 'set_reminder' $namespace @{ event_id = 'fixture-id'; parameters = @{ enabled = $true; minutes_before_start = 15 } })
Assert-CapturedOffice ($namespace.Item.ReminderSet -and $namespace.Item.ReminderMinutesBeforeStart -eq 15) 'Reminder dispatch lost its values'
[void](Invoke-CapturedOffice 'set_recurrence' $namespace @{ event_id = 'fixture-id'; parameters = @{ type = 1; interval = 2; day_of_week_mask = 2; occurrences = 4 } })
Assert-CapturedOffice ($namespace.Item.Pattern.Interval -eq 2 -and $namespace.Item.Pattern.Occurrences -eq 4 -and -not $namespace.Item.Pattern.NoEndDate) 'Recurrence dispatch lost its bounded pattern'
[void](Invoke-CapturedOffice 'set_location' $namespace @{ event_id = 'fixture-id'; parameters = @{ location = 'Fixture room' } })
Assert-CapturedOffice ($namespace.Item.Location -eq 'Fixture room') 'Location dispatch lost its value'
$sent = Invoke-CapturedOffice 'send_update' $namespace @{ event_id = 'fixture-id' }
Assert-CapturedOffice ($namespace.Item.Sent -and $sent.submitted -and -not $sent.delivery_verified) 'Update receipt claimed delivery without proof'
$namespace = [CapturedNamespace]::new(26)
$canceled = Invoke-CapturedOffice 'cancel_event' $namespace @{ event_id = 'fixture-id' }
Assert-CapturedOffice ($namespace.Item.Sent -and $namespace.Item.Deleted -and $namespace.Item.MeetingStatus -eq 5 -and -not $canceled.delivery_verified) 'Cancellation dispatch or delivery receipt is incorrect'
$namespace = [CapturedNamespace]::new(26)
$responded = Invoke-CapturedOffice 'respond' $namespace @{ event_id = 'fixture-id'; parameters = @{ response = 'accept' } }
Assert-CapturedOffice ($namespace.Item.Response -eq 3 -and $namespace.Item.NoUI -and $responded.submitted -and -not $responded.delivery_verified) 'Response dispatch or delivery receipt is incorrect'
$namespace = [CapturedNamespace]::new(40)
$categories = Invoke-CapturedOffice 'set_categories' $namespace @{ contact_id = 'fixture-id'; categories = @('Fixture', 'Work') }
Assert-CapturedOffice ($categories.categories -eq 'Fixture, Work' -and $namespace.Item.Saved) 'Contact category dispatch lost data'
$created = Invoke-CapturedOffice 'create_group' ([CapturedNamespace]::new(69)) @{ name = 'Fixture group'; members = @('fixture@example.test') }
Assert-CapturedOffice ($created.name -eq 'Fixture group' -and $created.member_count -eq 1 -and $created.saved) 'Contact group creation lost its members or identity'
$namespace = [CapturedNamespace]::new(69); $namespace.Item.AddMember([CapturedRecipient]::new('old@example.test'))
$updated = Invoke-CapturedOffice 'update_group' $namespace @{ group_id = 'fixture-id'; members = @('new@example.test'); parameters = @{ remove_members = @('old@example.test') } }
Assert-CapturedOffice ($updated.member_count -eq 1 -and $namespace.Item.GetMember(1).Address -eq 'new@example.test') 'Contact group update did not preserve the selected membership change'
Write-Output 'All 17 Office account actions passed captured-provider checks. No real account, printer, macro, send or deletion action was executed.'
