# Changelog

All notable changes to Codex Account Manager are documented here.

## v1.2.2 — 2026-09-03

### Stable

- Stabilized manual switching across multiple Codex accounts.
- Kept a single `~/.codex` profile so projects, history, sessions, MCPs, settings and Skills remain shared.
- Added encrypted local account vault using AES-256-GCM with a Windows DPAPI-protected master key.
- Added isolated ChatGPT reauthentication through `codex app-server`.
- Added safe usage-limit reads through `account/rateLimits/read`.
- Inactive account limits refresh automatically every 60 seconds.
- The active account is preserved while Codex Desktop is running to avoid refresh-token races.
- The manual limit refresh no longer closes Codex Desktop.
- Added PT-BR and English documentation, security policy, third-party notices and sanitized project screenshot.

## v1.2.0

- Replaced external PowerShell reauthentication with the managed `account/login/start` browser flow.

## v1.1.x

- Added account validation before switching.
- Added recovery/migration for older runtime auth snapshots.
- Improved handling of revoked sessions and reauthentication state.
