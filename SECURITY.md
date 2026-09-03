# Security Policy

## Supported version

The current stable line is **v1.2.x**.

## Reporting a vulnerability

Please avoid opening a public issue with credentials, tokens, `auth.json`, vault files, DPAPI material, or other secrets.

Report security-sensitive problems privately to the repository maintainer through GitHub's available private contact/security channels.

## Sensitive files

Never attach or commit:

- `%USERPROFILE%\.codex\auth.json`
- `auth.json.bak`
- `%LOCALAPPDATA%\CodexAccountManager\accounts.vault`
- `%LOCALAPPDATA%\CodexAccountManager\master-key.dpapi`
- temporary login/runtime homes containing authentication material
