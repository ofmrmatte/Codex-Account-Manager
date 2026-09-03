$ErrorActionPreference = 'Stop'

$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = Join-Path $env:LOCALAPPDATA 'CodexAccountManager'

Write-Host 'Atualizando Codex Account Manager para v1.2.2...' -ForegroundColor Cyan

# Stop only this manager's Node process. Do not touch unrelated npx/MCP processes.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -eq 'node.exe' -and
    $_.CommandLine -like '*CodexAccountManager*server.js*'
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Milliseconds 500
New-Item -ItemType Directory -Path $Target -Force | Out-Null

# Preserve account data explicitly. These files are never overwritten by this updater.
$protected = @('accounts.vault', 'master-key.dpapi')
foreach ($name in $protected) {
  $p = Join-Path $Target $name
  if (Test-Path $p) {
    Write-Host "Preservado: $p" -ForegroundColor DarkGray
  }
}

foreach ($dir in @('lib','public','scripts')) {
  $src = Join-Path $Source $dir
  $dst = Join-Path $Target $dir
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src $dst -Recurse -Force
}

foreach ($file in @(
  'server.js','package.json','README.md','THIRD_PARTY_NOTICES.md',
  'Install.ps1','Uninstall.ps1','Cleanup-PreviousManagers.ps1'
)) {
  $src = Join-Path $Source $file
  if (Test-Path $src) { Copy-Item $src (Join-Path $Target $file) -Force }
}

# Preserve legacy runtime homes for one startup. v1.1.1 migrates any newer
# rotated auth.json back into the encrypted vault, then deletes matched copies.
$runtime = Join-Path $Target 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

# Start the updated server hidden. Existing shortcut/startup entries keep working.
$startScript = Join-Path $Target 'Start-Manager.ps1'
if (Test-Path $startScript) {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript | Out-Null
} else {
  Start-Process node.exe -ArgumentList 'server.js' -WorkingDirectory $Target -WindowStyle Hidden
}

Write-Host ''
Write-Host 'Atualizacao concluida. Suas contas e a chave DPAPI foram preservadas.' -ForegroundColor Green
Write-Host 'Abra: http://127.0.0.1:3210' -ForegroundColor Green
