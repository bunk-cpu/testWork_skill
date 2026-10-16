param(
    [ValidateSet('Save', 'Read')][string]$Action = 'Save'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$skillDirectory = Split-Path -Parent $PSScriptRoot
$privateDirectory = Join-Path $skillDirectory '.local'
$credentialPath = Join-Path $privateDirectory 'tapd-credential.xml'
if ($Action -eq 'Save') {
    New-Item -ItemType Directory -Path $privateDirectory -Force | Out-Null
    # DPAPI binds the encrypted password to this Windows user and machine.
    $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $privateDirectory /inheritance:r /grant:r "${currentIdentity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict credential directory permissions.' }
    if ($env:TAPD_USERNAME -and $env:TAPD_PASSWORD) {
        $securePassword = ConvertTo-SecureString $env:TAPD_PASSWORD -AsPlainText -Force
        $credential = New-Object System.Management.Automation.PSCredential($env:TAPD_USERNAME, $securePassword)
    } else {
        $credential = Get-Credential -Message 'TAPD login (stored with Windows DPAPI)'
    }
    if ($null -eq $credential) { throw 'Credential entry cancelled.' }
    $credential | Export-Clixml -LiteralPath $credentialPath -Encoding UTF8
    Write-Output 'TAPD credential saved with Windows DPAPI.'
} else {
    if (-not (Test-Path -LiteralPath $credentialPath)) { throw 'No saved TAPD credential. Run credentials.ps1 -Action Save first.' }
    $credential = Import-Clixml -LiteralPath $credentialPath
    @{ username = $credential.UserName; password = $credential.GetNetworkCredential().Password } | ConvertTo-Json -Compress
}
