# Changelog

All notable changes to Memory Daymaker are tracked here.

## 0.1.0 - 2026-05-01

- Native JavaScript OpenClaw plugin for daily memory generation from session transcripts.
- CLI commands for `openclaw daymaker run` and `openclaw daymaker coverage`.
- Managed OpenClaw cron job with OpenClaw `2026.4.22` and `2026.4.23` compatibility mode.
- Direct cron hook mode for OpenClaw `2026.4.24+` when `hooks.allowConversationAccess` is enabled.
- Runtime-derived defaults for sessions, workspace memory, backup path, and timezone.
- Existing memory merge pass, flat timestamped backups, per-day locks, and focused noise filtering.
- Failure handling through OpenClaw cron `failureAlert` defaults.
