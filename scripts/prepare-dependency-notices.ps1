[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$temporaryCensus = [IO.Path]::GetTempFileName()
Push-Location $repositoryRoot
try {
    $licenseJson = & corepack pnpm@10.15.0 licenses list --prod --json
    if ($LASTEXITCODE -ne 0) { throw "Production license census failed: $LASTEXITCODE" }
    [IO.File]::WriteAllText($temporaryCensus, ($licenseJson -join "`n"), [Text.UTF8Encoding]::new($false))
    & node scripts/collect-dependency-notices.mjs $temporaryCensus
    if ($LASTEXITCODE -ne 0) { throw "Dependency notice collection failed: $LASTEXITCODE" }
}
finally {
    Pop-Location
    Remove-Item -LiteralPath $temporaryCensus -ErrorAction SilentlyContinue
}
