export const repositoryImportStageAclScript = String.raw`param([string]$Stage)
$ErrorActionPreference = 'Stop'
if([IO.Directory]::Exists($Stage) -or [IO.File]::Exists($Stage)){throw 'STAGE_COLLISION'}
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($sid)
$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
# CreateDirectoryW is create-only: ERROR_ALREADY_EXISTS fails without adopting a racing directory.
# Pass the restrictive DACL at creation time; setting ACL after create opens a race.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ImportStageNative {
 [StructLayout(LayoutKind.Sequential)] public struct SecurityAttributes {
  public uint Length;
  public IntPtr Descriptor;
  public int Inherit;
 }
 [DllImport("kernel32.dll", EntryPoint="CreateDirectoryW", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool CreateDirectory(string path, ref SecurityAttributes attributes);
}
'@
$descriptor=$acl.GetSecurityDescriptorBinaryForm()
$securityPtr=[Runtime.InteropServices.Marshal]::AllocHGlobal($descriptor.Length)
try {
 [Runtime.InteropServices.Marshal]::Copy($descriptor,0,$securityPtr,$descriptor.Length)
 $attributes=[ImportStageNative+SecurityAttributes]::new()
 $attributes.Length=[Runtime.InteropServices.Marshal]::SizeOf([type][ImportStageNative+SecurityAttributes])
 $attributes.Descriptor=$securityPtr
 $attributes.Inherit=0
 if(-not [ImportStageNative]::CreateDirectory($Stage,[ref]$attributes)) {
  throw ('STAGE_CREATE_REFUSED_'+[Runtime.InteropServices.Marshal]::GetLastWin32Error())
 }
} finally {
 [Runtime.InteropServices.Marshal]::FreeHGlobal($securityPtr)
}
if(-not [IO.Directory]::Exists($Stage)){throw 'STAGE_UNAVAILABLE'}
Write-Output 'STAGE_CREATED'`;

export const repositoryImportStageIdentityScript = String.raw`param([string]$AnchorSource,[string]$Workspace,[string]$Destination,[string]$Stage)
$ErrorActionPreference = 'Stop'
Add-Type -Path $AnchorSource
$anchor=[RepositoryImportAnchor]::new($Workspace,$Destination,$false)
try {
 $identity=$anchor.PrepareStage($Stage)
 if($identity -cnotmatch '^[0-9A-F]{16}-[0-9A-F]{32}$'){throw 'IMPORT_STAGE_IDENTITY_UNAVAILABLE'}
 Write-Output $identity
} finally {$anchor.Dispose()}`;

export const repositoryImportVerifyPublishedScript = String.raw`param([string]$AnchorSource,[string]$Workspace,[string]$Destination,[string]$Expected)
$ErrorActionPreference = 'Stop'
Add-Type -Path $AnchorSource
$anchor=[RepositoryImportAnchor]::new($Workspace,$Destination,$false)
try {
 if($anchor.ReadPublishedIdentity() -cne $Expected){throw 'IMPORT_PUBLISHED_IDENTITY_CHANGED'}
 Write-Output 'PUBLISHED_NATIVE_IDENTITY_MATCH'
} finally {$anchor.Dispose()}`;

export const repositoryImportPublishScript = String.raw`param([string]$SpecPath,[string]$ExpectedStageIdentity)
$ErrorActionPreference = 'Stop'
function Write-DurableNewText([string]$filename,[string]$content) {
 $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($content)
 $stream=[IO.File]::Open($filename,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try {
  $stream.Write($bytes,0,$bytes.Length)
  $stream.Flush($true)
 } finally {$stream.Dispose()}
}
$spec=Get-Content -LiteralPath $SpecPath -Raw | ConvertFrom-Json
Add-Type -Path ([string]$spec.anchorSourcePath)
$anchor=[RepositoryImportAnchor]::new([string]$spec.workspaceRoot,[string]$spec.destination)
try {
 # Git cannot chdir into a directory while its no-delete-share native pin is held.
 # Check checkout content before opening the stage handle, then pin and reverify native identity.
 $git=Join-Path (Join-Path $env:SystemDrive 'Program Files\Git\cmd') 'git.exe'
 if(-not [IO.File]::Exists($git)){throw 'IMPORT_TRUSTED_GIT_UNAVAILABLE'}
 $stage=[string]$spec.stagePath
 $head=& $git -c core.fsmonitor=false -C $stage rev-parse --verify HEAD 2>$null
 if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($head) -or $head.Trim().ToLowerInvariant() -cne ([string]$spec.commit).ToLowerInvariant()){throw 'IMPORT_STAGE_HEAD_CHANGED'}
 # Git status may hide mutated files when the index marks them assume-unchanged or skip-worktree.
 $indexTags=& $git -C $stage ls-files -v 2>$null
 if($LASTEXITCODE -ne 0 -or @($indexTags | Where-Object {$_ -cmatch '^[a-zS] '}).Count -gt 0){throw 'IMPORT_STAGE_INDEX_FLAGS_UNSAFE'}
 $changes=& $git -c core.fsmonitor=false -C $stage status --porcelain=v1 --untracked-files=all 2>$null
 if($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace(($changes -join [Environment]::NewLine))){throw 'IMPORT_STAGE_WORKTREE_CHANGED'}
 $identity=$anchor.PrepareStage($stage)
 # A path-only checkout is not ownership proof: the publisher must still hold
 # the exact native stage object that was identified before Git started.
 if($identity -cne $ExpectedStageIdentity){throw 'IMPORT_STAGE_IDENTITY_CHANGED'}
 $prepared=@{version=1;state='prepared';nativeIdentity=$identity;commit=[string]$spec.commit} | ConvertTo-Json -Compress
 $pending=[string]$spec.statePath+'.pending'
 Write-DurableNewText $pending $prepared
 [IO.File]::Move($pending,[string]$spec.statePath)
 $anchor.Publish()
 if($anchor.ReadPublishedIdentity() -ne $identity){throw 'PUBLISHED_IDENTITY_MISMATCH'}
 $published=@{version=1;state='published';nativeIdentity=$identity;commit=[string]$spec.commit} | ConvertTo-Json -Compress
 $complete=[string]$spec.statePath+'.complete'
 Write-DurableNewText $complete $published
 [IO.File]::Delete([string]$spec.statePath)
 [IO.File]::Move($complete,[string]$spec.statePath)
 Write-Output 'PUBLISHED_NATIVE_IDENTITY_VERIFIED'
} finally {$anchor.Dispose()}`;
