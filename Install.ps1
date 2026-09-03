$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Codex Account Manager ===" -ForegroundColor Cyan
Write-Host ""

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "Node.js 22+ nao encontrado. Instale Node.js antes de continuar."
}

$versionText = (& node --version).Trim().TrimStart("v")
$major = [int]($versionText.Split(".")[0])
if ($major -lt 22) {
    throw "Node.js 22+ necessario. Versao atual: $versionText"
}

$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
    throw "Comando 'codex' nao encontrado no PATH."
}

$installRoot = Join-Path $env:LOCALAPPDATA "CodexAccountManager"
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null

Write-Host "Instalando em $installRoot..." -ForegroundColor Yellow

robocopy $PSScriptRoot $installRoot /E /R:1 /W:1 /XD ".git" "node_modules" | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "Falha ao copiar arquivos. Robocopy exit code: $LASTEXITCODE"
}

$nodePath = $node.Source
$launcherVbs = Join-Path $installRoot "Launch-CodexAccountManager.vbs"

$vbs = @"
Set shell = CreateObject("WScript.Shell")
nodePath = "$nodePath"
serverPath = "$(Join-Path $installRoot "server.js")"
cmd = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & serverPath & Chr(34)
shell.Run cmd, 0, False
WScript.Sleep 900
shell.Run "http://127.0.0.1:3210", 1, False
"@

Set-Content -Path $launcherVbs -Value $vbs -Encoding ASCII

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")

foreach ($destination in @(
    (Join-Path $desktop "Codex Account Manager.lnk"),
    (Join-Path $programs "Codex Account Manager.lnk")
)) {
    $shortcut = $ws.CreateShortcut($destination)
    $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
    $shortcut.Arguments = "`"$launcherVbs`""
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.Description = "Codex Account Manager - local"
    $shortcut.Save()
}

Write-Host ""
Write-Host "Instalacao concluida." -ForegroundColor Green
Write-Host "Atalho criado: Codex Account Manager"
Write-Host ""
Write-Host "Abrindo..."
Start-Process "$env:SystemRoot\System32\wscript.exe" -ArgumentList "`"$launcherVbs`""
