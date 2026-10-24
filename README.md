# srijon-claude-plugins

A Claude Code plugin marketplace by Md. Rahat Islam.

## Plugins

| Plugin | What it does |
| --- | --- |
| [claudio-notify](plugins/claudio-notify) | Audio notifications: distinct, customizable sounds when tasks finish, subagents start or stop, Claude asks a question, needs permission, or you near a usage limit, per model. |

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

### Moving from the old claudio-notify marketplace

This repository used to be `rahat-srijon/claudio-notify`, with a marketplace of the same name. If you installed `claudio-notify@claudio-notify`, switch to the new marketplace:

1. If you set up usage-limit sounds, run `/claudio-notify:teardown-usage` first.
2. Copy `config.json` and the `sounds` folder from `~/.claude/plugins/data/claudio-notify-claudio-notify/` somewhere safe. Uninstalling can delete that folder.
3. Run:

   ```
   /plugin uninstall claudio-notify@claudio-notify
   /plugin marketplace remove claudio-notify
   /plugin marketplace add rahat-srijon/srijon-claude-plugins
   /plugin install claudio-notify@srijon-claude-plugins
   ```

4. Put the copied files into `~/.claude/plugins/data/claudio-notify-srijon-claude-plugins/`, and run `/claudio-notify:setup-usage` again if you use usage-limit sounds.

## Repository layout

```
.claude-plugin/marketplace.json   The marketplace: its name and the list of plugins
plugins/<plugin>/                 One folder per plugin, self-contained
  .claude-plugin/plugin.json      The plugin manifest
  README.md, CHANGELOG.md         The plugin's own docs and history
  package.json                    The plugin's scripts (tests and so on)
package.json                      npm workspaces over plugins/*, to test everything at once
```

A plugin folder is what Claude Code copies on install, so it must not reach outside itself.

## Adding a plugin

1. Create `plugins/<name>/` with `.claude-plugin/plugin.json`, a `README.md` and a `CHANGELOG.md`. Add a `package.json` with a `test` script if the plugin has tests.
2. Add an entry to `plugins` in `.claude-plugin/marketplace.json`:

   ```json
   {
     "name": "<name>",
     "source": "./plugins/<name>",
     "description": "One line about what it does.",
     "version": "0.1.0"
   }
   ```

3. Add a row to the table above.
4. Check it:

   ```
   claude plugin validate .
   claude plugin validate plugins/<name>
   npm test
   ```

5. Try it locally with `claude --plugin-dir plugins/<name>`.

## Development

- `npm test` runs every plugin's tests. Run `npm test` inside a plugin folder for just that plugin.
- `npm run validate` checks the marketplace manifest.
- Plugins use Node.js 18 or later with no dependencies.

## Releases

Each plugin is versioned on its own. Keep the version in the plugin's `plugin.json`, its `package.json` and its entry in `marketplace.json` the same, and tag releases as `<plugin>-v<version>`, for example `claudio-notify-v0.3.0`. The older `v0.1.0` and `v0.2.0` tags are claudio-notify releases from before the rename.

## License

MIT
