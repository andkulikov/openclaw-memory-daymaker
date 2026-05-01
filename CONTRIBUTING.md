# Contributing

Thanks for helping improve Memory Daymaker.

## Development

Use Node.js 20 or newer.

```sh
npm run smoke
```

That command performs a syntax/import check and runs the Node test suite.

Before proposing a release change, also run:

```sh
npm run release:check
```

## Compatibility

Keep OpenClaw `2026.4.22` and `2026.4.23` compatibility unless a release note explicitly raises the minimum host version. Those hosts use the compatibility cron-tool path; newer hosts can use the direct cron hook path when `hooks.allowConversationAccess` is enabled.

## Public Config Hygiene

Do not add personal chat ids, channel ids, absolute home paths, private model names, tokens, or hostnames to defaults, tests, or docs. Runtime defaults should come from OpenClaw APIs whenever possible.
