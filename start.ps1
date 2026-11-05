# Lance DEX en local (Windows / PowerShell).
#   .\start.ps1                 -> mot de passe "dex", port 5000
#   .\start.ps1 -Password secret -Port 8000
param(
  [string]$Password = "dex",
  [int]$Port = 5000
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
  Write-Host "Creation de l'environnement virtuel..." -ForegroundColor Cyan
  py -3 -m venv .venv
  & .\.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
  & .\.venv\Scripts\python.exe -m pip install --quiet -r requirements.txt
}

$env:EDIT_PASSWORD = $Password
$env:PORT = $Port
if (-not $env:SECRET_KEY) {
  $env:SECRET_KEY = & .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_hex(32))"
}

Write-Host ""
Write-Host "  DEX demarre sur http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "  Mot de passe d'edition : $Password" -ForegroundColor DarkGray
Write-Host "  Ctrl+C pour arreter." -ForegroundColor DarkGray
Write-Host ""

& .\.venv\Scripts\python.exe app.py
