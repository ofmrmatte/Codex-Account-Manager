# Codex Account Manager

**English** | [Português](README.md)

A local multi-account manager for Codex on Windows, maintained by **ofmrmatte**. It lets you manually switch accounts without duplicating projects, history, sessions, MCPs, configuration, or Skills.

> Official repository for this project: `ofmrmatte/Codex-Account-Manager`. This is an independent community project; it is not an OpenAI product and does not imply affiliation with or endorsement by OpenAI.

![Codex Account Manager — screenshot with personal information redacted](docs/codex-account-manager-redacted.svg)

## Key features

- Manual switching between multiple Codex accounts.
- A single `%USERPROFILE%\.codex` for projects, history, sessions, MCPs, configuration, and Skills.
- Local AES-256-GCM encrypted vault.
- Master key protected with Windows DPAPI (`CurrentUser`).
- Local server bound to `127.0.0.1` only.
- Isolated reauthentication using the official `account/login/start` flow from `codex app-server`.
- Usage-limit reads through `account/rateLimits/read`.
- Automatic refresh of inactive-account limits every 60 seconds.
- No project-operated token upload service.
- No copying of `sessions/` and no writes to `state_5.sqlite`.

## How it works

The manager keeps the normal Codex environment at:

```text
%USERPROFILE%\.codex
```

Additional accounts are stored in the encrypted local vault. When an account is activated, only the following file is swapped:

```text
%USERPROFILE%\.codex\auth.json
```

Projects and working data remain in the same profile.

## Requirements

- Windows 11
- Node.js 22 or newer
- Codex CLI available on `PATH`
- Codex Desktop optional

## Installation

Clone or download the repository and run in PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install.ps1
```

Then open the **Codex Account Manager** shortcut.

## Add or reauthenticate an account

1. Open the manager.
2. The active account can be imported on first run.
3. Click **Add another account** / **Adicionar outra conta** or **Reauthenticate** / **Reautenticar**.
4. The Manager starts `codex app-server` inside an isolated `CODEX_HOME`.
5. Your browser opens the ChatGPT sign-in flow.
6. Authenticate the intended account.
7. Return to the dashboard and click **Finish login** / **Concluir login** when prompted.
8. The refreshed credential is saved to the encrypted vault.

Account switching is always initiated manually by the user. The project does not automatically rotate accounts based on usage limits.

## Usage limits

The Manager reads usage data through `account/rateLimits/read` using `codex app-server`.

- Inactive accounts are queried in temporary homes under `%LOCALAPPDATA%\CodexAccountManager\runtime\`.
- The active account is not queried through a second competing app-server instance while Codex Desktop is running.
- When switching accounts, the account being left can safely receive a refreshed snapshot.
- The **Refresh limits** / **Atualizar limites** action does not terminate Codex Desktop.

## Security

- Vault: AES-256-GCM.
- Key protection: Windows DPAPI (`CurrentUser`).
- Local bind: `127.0.0.1`.
- No project-operated cloud service.
- No telemetry added by this project.
- No plaintext tokens committed to the repository.

Never commit `auth.json`, `accounts.vault`, `master-key.dpapi`, or local runtime directories.

## Updating

To update an existing installation while preserving the vault and DPAPI key:

```powershell
.\Update.ps1
```

## Uninstall

```powershell
& "$env:LOCALAPPDATA\CodexAccountManager\Uninstall.ps1"
```

Your `~/.codex`, projects, sessions, Skills, and MCPs are not deleted.

## Stable version

**v1.2.2**

This release stabilizes account switching, isolated reauthentication, and safe limit refresh without closing Codex Desktop.

## License

Distributed under the [MIT License](LICENSE).

Copyright © 2026 Matheus Ferreira.

## Credits

Architecture inspired by the MIT-licensed `mahirozdin/Codex-Multi-Account-Manager`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
