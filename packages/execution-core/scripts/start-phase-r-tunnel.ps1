param(
  [Parameter(Mandatory=$true)][string]$TunnelId,
  [Parameter(Mandatory=$true)][string]$HostConfigPath,
  [string]$TunnelClientPath = "$env:LOCALAPPDATA/Programs/lnwjud/resources/tunnel-client/tunnel-client.exe"
)
$ErrorActionPreference = 'Stop'
if ($TunnelId -notmatch '^tunnel_[A-Za-z0-9_-]{8,128}$') { throw 'Use the real new gotzji Tunnel ID from OpenAI Platform.' }
$resolvedConfig = (Resolve-Path -LiteralPath $HostConfigPath).Path
$config = Get-Content -LiteralPath $resolvedConfig -Raw | ConvertFrom-Json
$profileDirectory = Join-Path $config.directory 'gotzji-tunnel-profile'
$frontend = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../dist/phase-r-frontend.mjs'))
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $TunnelClientPath)) { throw 'The official tunnel-client executable was not found.' }
if (-not (Test-Path -LiteralPath $frontend)) { throw 'Build execution-core before connecting.' }
# All filesystem targets are derived from the exact host-created config. Nothing
# changes the original lnwjud runtime/profile or publishes an inbound listener.
New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
$mcpCommand = '"' + $nodeExecutable + '" "' + $frontend + '" "' + $resolvedConfig + '"'
& $TunnelClientPath init --profile gotzji-phase-r --profile-dir $profileDirectory --tunnel-id $TunnelId --mcp-command $mcpCommand --health-listen-addr 127.0.0.1:0 --control-plane-api-key-ref env:CONTROL_PLANE_API_KEY
if ($LASTEXITCODE -ne 0) { throw 'Tunnel profile creation failed; existing profiles were preserved.' }
Write-Host 'Enter the runtime key locally. It is hidden and is not sent to the chat or saved in this repository.'
$secretInput = Read-Host 'Runtime control-plane key' -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretInput)
$environmentNames = @('CONTROL_PLANE_API_KEY', 'MCP_STDIO_SEND_INITIALIZED_NOTIFICATION', 'HEALTH_URL_FILE')
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $existing = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
  if ($null -ne $existing) { $previousEnvironment[$name] = $existing.Value }
}
try {
  $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  $env:MCP_STDIO_SEND_INITIALIZED_NOTIFICATION = 'true'
  $env:HEALTH_URL_FILE = Join-Path $profileDirectory 'health-url.txt'
  & $TunnelClientPath doctor --profile gotzji-phase-r --profile-dir $profileDirectory --explain
  if ($LASTEXITCODE -ne 0) { throw 'Tunnel diagnostics did not pass; do not claim connection acceptance.' }
  Write-Host 'Run continues in this terminal. Closing it stops only this gotzji tunnel connection.'
  & $TunnelClientPath run --profile gotzji-phase-r --profile-dir $profileDirectory
} finally {
  foreach ($name in $environmentNames) {
    if ($previousEnvironment.ContainsKey($name)) {
      Set-Item -LiteralPath "Env:$name" -Value $previousEnvironment[$name]
    } else {
      Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
  }
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
}
