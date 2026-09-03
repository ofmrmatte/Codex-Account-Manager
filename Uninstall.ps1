$ErrorActionPreference = "Continue"

$installRoot = Join-Path $env:LOCALAPPDATA "CodexAccountManager"
$dataRoot = Join-Path $env:LOCALAPPDATA "CodexAccountManager"
$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")

# Stop only node.exe instances whose command line references this manager.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*CodexAccountManager*server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-Item (Join-Path $desktop "Codex Account Manager.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $programs "Codex Account Manager.lnk") -Force -ErrorAction SilentlyContinue

if (Test-Path $installRoot) {
    Remove-Item $installRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Codex Account Manager removido." -ForegroundColor Green
Write-Host "Observacao: como instalacao e vault usam a mesma pasta neste build, o vault local tambem foi removido."
Write-Host "Seu ~/.codex, projetos, sessoes, Skills e MCPs nao foram alterados."
