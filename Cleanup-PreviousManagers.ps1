param(
    [switch]$DeleteProfileCopies
)

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "=== Limpeza dos gerenciadores anteriores ===" -ForegroundColor Cyan

# Old Continuity Companion
$oldCompanion = Join-Path $HOME ".codex-app-companion"
$startup = [Environment]::GetFolderPath("Startup")
$programs = [Environment]::GetFolderPath("Programs")
$desktop = [Environment]::GetFolderPath("Desktop")

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -ieq "powershell.exe" -and
        ($_.CommandLine -like "*CodexAppCompanion.ps1*" -or $_.CommandLine -like "*CodexProfileManager.ps1*")
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-Item (Join-Path $startup "Codex App Continuity Companion.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $programs "Codex App Continuity Companion.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item $oldCompanion -Recurse -Force -ErrorAction SilentlyContinue

# Previous A/B/C Profile Manager
$profileManager = Join-Path $HOME ".codex-profile-manager"
Remove-Item (Join-Path $startup "Codex Profile Manager.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $programs "Codex Profile Manager.lnk") -Force -ErrorAction SilentlyContinue

foreach ($name in @("Codex A.lnk", "Codex B.lnk", "Codex C.lnk")) {
    Remove-Item (Join-Path $desktop $name) -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $programs $name) -Force -ErrorAction SilentlyContinue
}

Remove-Item $profileManager -Recurse -Force -ErrorAction SilentlyContinue

if ($DeleteProfileCopies) {
    if (-not (Test-Path (Join-Path $HOME ".codex"))) {
        throw "O ~/.codex original nao existe. Por seguranca, as copias A/B/C nao serao apagadas."
    }

    foreach ($folder in @(
        ".codex-a", ".codex-b", ".codex-c",
        ".codex-a-gui", ".codex-b-gui", ".codex-c-gui"
    )) {
        Remove-Item (Join-Path $HOME $folder) -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Copias A/B/C removidas." -ForegroundColor Green
}
else {
    Write-Host "Gerenciadores anteriores removidos." -ForegroundColor Green
    Write-Host "As pastas .codex-a/b/c foram preservadas."
    Write-Host "Quando confirmar que ~/.codex esta normal, voce pode rodar:"
    Write-Host "  .\Cleanup-PreviousManagers.ps1 -DeleteProfileCopies"
}

Write-Host "O ~/.codex original nunca e removido por este script."
