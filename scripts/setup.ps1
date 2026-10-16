$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 20 or newer first.' }
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    & node scripts/tapd.mjs --help
    if ($LASTEXITCODE -ne 0) { throw 'TAPD script check failed.' }
} finally { Pop-Location }
