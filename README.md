# srijon-claude-plugins

A Claude Code plugin marketplace by Md. Rahat Islam.

## Plugins

| Plugin | What it does |
| --- | --- |
| [claudio-notify](plugins/claudio-notify) | Audio notifications: distinct, customizable sounds when tasks finish, subagents start or stop, Claude asks a question, needs permission, or you near a usage limit, per model. |
| [pace-maker](plugins/pace-maker) | A per-conversation progress band (a mod): one row above the prompt showing how far the current task is, what Claude is doing now, and why it stopped, at zero model tokens by default. |

## Install

Add the marketplace once:

```
/plugin marketplace add rahat-srijon/srijon-claude-plugins
```

Then install any plugin from it by name:

```
/plugin install claudio-notify@srijon-claude-plugins
```

Each plugin's README has its own requirements and settings.

## Development

- `npm test` runs every plugin's tests. Run `npm test` inside a plugin folder for just that plugin.
- `npm run validate` checks the marketplace manifest.
- Plugins use Node.js 18 or later with no dependencies.

## Releases

Each plugin is versioned on its own. Keep the version in the plugin's `plugin.json`, its `package.json` and its entry in `marketplace.json` the same, and tag releases as `<plugin>-v<version>`, for example `claudio-notify-v0.3.0`.

## License

MIT
