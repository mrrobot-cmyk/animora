param(
    [Parameter(Mandatory=$true)]
    [string]$Module,

    [Parameter(Mandatory=$true)]
    [string]$Episode,

    [ValidateSet("sub", "dub")]
    [string]$Lang = "sub"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PlayScript = Join-Path $ProjectRoot "src\play.mjs"

Write-Host ""
Write-Host "========================================"
Write-Host "       Synthetiq V4 Windows Player"
Write-Host "========================================"
Write-Host ""
Write-Host "Modul:   $Module"
Write-Host "Episode: $Episode"
Write-Host "Sprache: $Lang"
Write-Host ""

if (-not (Test-Path $PlayScript)) {
    Write-Host "FEHLER: src\play.mjs wurde nicht gefunden." -ForegroundColor Red
    Write-Host ""
    Write-Host "Erwarteter Pfad:"
    Write-Host $PlayScript
    exit 1
}

try {
    node $PlayScript $Module $Episode $Lang
}
catch {
    Write-Host ""
    Write-Host "FEHLER:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}