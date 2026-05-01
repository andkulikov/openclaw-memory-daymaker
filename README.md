# openclaw-memory-daymaker

Memory Daymaker is an OpenClaw plugin that rebuilds daily memory files from the conversations OpenClaw actually had.

OpenClaw's built-in memory depends on the agent remembering to write important facts down during normal conversation. On busy days, that is easy to miss. Memory Daymaker treats session transcripts as the source of truth: after a day ends, it summarizes the previous day's conversations, merges the result with any existing memory file, and writes a more complete daily memory record.

## Who It Is For

Use this plugin if you want:

- daily memory files that are generated consistently, even when the agent forgot to write notes during the day
- a scheduled end-of-day cleanup pass over OpenClaw session history
- a manual command to rebuild or inspect memory coverage for a specific date
- backups before existing daily memory files are overwritten

This plugin is a maintenance tool for OpenClaw's file-based memory. It is not a replacement memory backend.

## Requirements

- OpenClaw `2026.4.22` or newer
- Node.js `20` or newer in the OpenClaw runtime
- an OpenClaw model configuration capable of running summarization turns

## Install

Recommended, from ClawHub:

```sh
openclaw plugins install clawhub:openclaw-memory-daymaker
openclaw plugins enable memory-daymaker
openclaw gateway restart
```

From npm:

```sh
openclaw plugins install npm:openclaw-memory-daymaker
openclaw plugins enable memory-daymaker
openclaw gateway restart
```

From GitHub:

```sh
openclaw plugins install git:github.com/andkulikov/openclaw-memory-daymaker@v0.1.0
openclaw plugins enable memory-daymaker
openclaw gateway restart
```

From a local checkout:

```sh
openclaw plugins install ./memory-daymaker
openclaw plugins enable memory-daymaker
openclaw gateway restart
```

Package pages:

- ClawHub: https://clawhub.ai/plugins/openclaw-memory-daymaker
- npm: https://www.npmjs.com/package/openclaw-memory-daymaker
- GitHub: https://github.com/andkulikov/openclaw-memory-daymaker

Then check that OpenClaw can see it:

```sh
openclaw plugins inspect memory-daymaker --runtime
```

## Quick Start

Run a coverage report before generating memory:

```sh
openclaw daymaker coverage --date 2026-04-29
```

Generate memory for one day:

```sh
openclaw daymaker run --date 2026-04-29 --verbose
```

Generate memory for yesterday in the resolved timezone:

```sh
openclaw daymaker run --verbose
```

## Schedule

When enabled in the OpenClaw Gateway, Memory Daymaker manages one daily cron job.

Defaults:

- time: `00:05`
- date processed: previous local day
- timezone: resolved from the OpenClaw/runtime environment
- delivery: quiet on success
- failures: routed through OpenClaw cron failure alerts

The scheduled job survives Gateway restarts. If you disable the plugin schedule, the managed cron job is removed. If the whole plugin is disabled, the managed job is designed to disable itself on its next wake instead of continuing to fail.

## Configuration

All fields are optional.

```json
{
  "plugins": {
    "entries": {
      "memory-daymaker": {
        "enabled": true,
        "config": {
          "model": "mini"
        }
      }
    }
  }
}
```

Common options:

- `model`: OpenClaw model alias or `provider/model` for summarization. If omitted, OpenClaw's normal model defaults are used.
- `schedule.enabled`: set to `false` to remove the managed daily cron job while keeping the plugin installed.
- `schedule.time`: local `HH:MM` time for the daily run.
- `timezone`: optional IANA timezone. Defaults to the runtime timezone.
- `memoryDir`: optional memory output directory. Defaults to the current OpenClaw workspace memory directory.
- `sessionsDir`: optional session transcript directory. Defaults to the current OpenClaw agent sessions directory.
- `backupDir`: optional backup directory. Defaults to `backups/memory-daymaker` under the workspace. Set to `""` to disable backups.
- `schedule.failureAlert`: optional OpenClaw cron failure-alert override. Leave unset to use OpenClaw defaults.

If your OpenClaw config uses an explicit `tools.allow` list on OpenClaw `2026.4.22` or `2026.4.23`, include `cron` plus either `memory-daymaker` or `memory-daymaker-run`.

## What Gets Written

Memory Daymaker writes normal daily memory sections:

```md
## Topic title
- Fact, decision, follow-up, or useful detail.
```

It does not write a wrapper heading or generated footer. Existing memory for the day is included in the final merge pass so older notes are not discarded just because they were missing from transcripts.

## Safety

- Existing daily memory files are backed up before overwrite unless backups are disabled.
- Writes are atomic and protected by a per-date lock.
- Missing session directories are treated as an empty day, not a crash.
- Heartbeats, startup chatter, cron wrapper text, duplicate session fragments, and large embedded attachments are filtered or compacted before summarization.
- The plugin does not shell out to Python or local scripts.

## Development

```sh
npm run smoke
npm run release:check
```

## License

MIT
