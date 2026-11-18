# pace-maker

A per-conversation progress band for Claude Code: how far the current task is, checkable at a glance.

Start a long run, look away, and check back without scrolling the chat or sending a prompt. pace-maker draws one row above the prompt with a progress bar, the step Claude is on, and the elapsed time. When Claude stops, the row says why, in a color you can read from across the room.

pace-maker is a mod: it runs inside Claude Code, draws its own interface, and makes no model calls by default. It is part of the [srijon-claude-plugins](../../README.md) marketplace.

## What the band looks like

One row, the same on every surface. The bar is drawn by the plugin from glyphs (it is not a built-in element), so it looks the same in the terminal, the desktop app and VS Code. The examples use a 10-cell bar and the `blocks` style; the default is 20 cells.

```
▶ Progress ██████░░░░  3/5 · 60% · Running tests · 12m
● Working ░░██░░░░░░  40s
✓ Done ██████████  5/5 · 18m
⏸ Waiting for permission: Bash ██████░░░░  3/5
✖ Blocked · permission denied: Bash
⏸ Paused by you
○ Stopped · 2 of 5 steps left ██████░░░░  3/5
```

The percentage is off by default (`showPercent`). The row wraps onto a second line on a narrow window instead of cutting text.

## What it shows

Exactly one state at a time. Each has an icon as well as a color, so it still reads in a monochrome terminal. Colors are theme tokens, so they follow your theme.

| State | When | Shows | Color token |
| --- | --- | --- | --- |
| Hidden | No task list and no turn running, or pace-maker is off | Nothing | n/a |
| Progress `▶` | A task list exists and Claude is working | Filled bar, then `3/5 · Running tests · 12m` | `suggestion` |
| Working `●` | Work is running with no task list to measure: a turn, a background command, subagents, a monitor | Sliding bar, then `npm test in background · 4m` | `suggestion` |
| Stopped `○` | The turn ended, steps are left, and no event explains it | `Stopped · 2 of 5 steps left`, bar held at the list's share | `subtle` |
| Done `✓` | Every step is completed and the turn ended | Full bar, then `5/5 · 18m` | `success` (green) |
| Waiting `⏸` | Something you can resolve: a permission prompt, a question for you, a usage limit | `Waiting for permission: Bash`, bar held | `warning` (orange) |
| Blocked `✖` | Claude cannot continue without a fix: an API error, a denied permission, tasks waiting on unmet dependencies | `Blocked · permission denied: Bash` | `error` (red) |
| Paused `⏸` | Stopped by your choice or the plan's: you pressed Esc, a plan waits for approval, or you ran `/pace pause` | `Paused by you`, `Plan ready for approval` or `Paused · <your reason>` | `planMode` (blue-ish) |

Details:

- A reason is only shown when an event explains it. Otherwise the state stays neutral and states facts only, such as `2 of 5 steps left`.
- A plain-text question counts as Waiting. The rule has no model call: the turn ended normally, steps are left, and the last paragraph of Claude's answer is short and ends with `?`. It misses a question phrased without a question mark, and it can flag a rhetorical `?`. When unsure it stays neutral.
- A permission prompt shows as Waiting even in the middle of a turn, and the bar stays visible (held in place).
- A new task list after Done or Hidden starts fresh. A new prompt while a list is unfinished keeps it.

## Where the progress comes from

Only Claude's own task tools, which pace-maker watches:

- `TaskCreate` and `TaskUpdate`
- `TodoWrite`
- The desktop app's own `update_plan` (a `wrap_up` call completes the list)

With a list, the bar is determinate: completed steps divided by all steps, minus deleted ones. The label is the step in progress.

With no list, the bar is a short segment that slides along the track for as long as a turn runs (a 250 ms ticker, running only while the band is live), and the text says Working. It never implies a fraction: pace-maker does not invent progress. A model without a task tool therefore shows only the sliding bar.

## Tokens

pace-maker uses zero model tokens by default. Its hooks only observe events, and it draws the row itself. There is one exception and one opt-in setting:

- **The `/pace` reply text.** A plugin command's one-line output (for example `Resumed.`) is read by the model on its next request, so each `/pace` command adds a few tokens. The lines are kept short on purpose.
- **Explain why it stopped (`explainStop`, Uses AI, off by default).** It is the only AI feature. When a turn ends with steps left and no event explains it, one small-model call (`haiku`, at most 30 tokens out, low effort, 15 second limit) reads the end of Claude's last answer and writes a reason of 8 words or fewer. Expect a few hundred tokens per such stop. The call runs in the background, never delays the turn, and is cancelled when the next turn starts. If it fails or the model is not available, nothing is shown.

With `explainStop` off and no `/pace` commands, usage is the same with the plugin on and off (this was not measured live; see Known limits).

## Clients

| Client | What is drawn | Status |
| --- | --- | --- |
| Desktop app (Code tab) | The one-row band above the prompt | The 0.1.0 band was seen on screen; the 0.2.0 row is **unverified live** until you check it |
| CLI | The one-row band above the prompt | The 0.1.0 band was seen on screen; the 0.2.0 row is **unverified live** until you check it |
| VS Code extension | The same row | Other plugins' bands are drawn above the prompt in VS Code, so the row should show; the pace-maker row is **unverified live** |
| Mobile | Out of scope | n/a |

The engine tests mount the band on the terminal, desktop and VS Code surfaces, so the row is drawn there in the test harness. That is not the same as seeing it in the real client. Because the row belongs to this plugin alone, it sits beside other mods' bands without conflict.

## Install

```
/plugin marketplace add rahat-srijon/srijon-claude-plugins
/plugin install pace-maker@srijon-claude-plugins
```

Or in one step:

```
/plugin install pace-maker --marketplace rahat-srijon/srijon-claude-plugins
```

From a shell:

```
claude plugin marketplace add rahat-srijon/srijon-claude-plugins
claude plugin install pace-maker@srijon-claude-plugins
```

Desktop app: `/plugin` is a terminal command and does not run in the Code tab. Click + next to the prompt box, then Plugins, then Add marketplace with `rahat-srijon/srijon-claude-plugins`, then Add plugin. Restart the client after installing or updating.

To update an installed copy: `claude plugin marketplace update srijon-claude-plugins`, then `claude plugin update pace-maker`.

### Requirements

- Claude Code CLI 2.1.287 or later, or the VS Code extension 2.1.299 or later (the versions that load mods).
- The desktop app: the minimum version is not known.
- Nothing else. There is no settings server and no Node requirement for using the plugin.

## Settings

Settings are plugin options. Open `/config` in any client and look for the pace-maker rows. The options are read when the plugin loads. Whether a changed option applies at once or only after a reload or restart is not verified; restart the client if a change does not show.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | on | Show the progress band above the prompt |
| `barStyle` | `blocks` | `blocks` (`█░`), `thin` (`▬─`), `dots` (`●○`) or `ascii` (`[##--]`) |
| `barWidth` | 20 | Bar width in cells, 10 to 40 |
| `showCount` | on | Show done/total steps, e.g. `3/5` |
| `showPercent` | off | Show the percentage done |
| `showLabel` | on | Show the step in progress (and what runs in the background) |
| `showElapsed` | on | Show how long the work has been running |
| `showSubagents` | on | Show how many subagents are running |
| `explainStop` | off | Uses AI: when Claude stops with steps left, one small-model call writes a short reason |

## Commands

One command, `/pace`, because command names cannot contain a colon. It runs without a Claude turn and applies to the current conversation only.

| Command | What it does |
| --- | --- |
| `/pace off` | Hide the band for this conversation |
| `/pace on` | Show it again and clear any pause |
| `/pace pause <reason>` | Show the blue Paused state with your reason |
| `/pace resume` | Clear the pause |

Anything else prints a one-line usage message.

## Known limits

- **Only events that are not skipped are used.** A plugin that runs above pace-maker (such as an organization's security plugin) can skip a plugin's `classic.*` hooks and `prompt.compose`, and Claude Code then prints a notice in the transcript for each. pace-maker registers none of them. What it uses instead has these limits:
  - A permission prompt is detected from `tool.check` resolving to an ask. A denied permission comes from `tool.check` or a refused `tool.call`.
  - An API error or usage limit is matched from the reply text of `turn.complete`, which is heuristic and has not been tested against a real API error.
  - The end of a background task is parsed from task-notification rows (`<task-id>` and `<status>`). The format was observed, but the parsing is not live-tested. A finished background task can show as Working for a while.
- **Failed tool calls are not covered.** A failing tool alone does not turn the band red.
- **No badge in the conversation list.** The mod API cannot add one. The desktop sidebar keeps its own indicators.
- **A model without a task tool shows only the sliding bar.** pace-maker no longer asks Claude to keep a task list (see Changes from 0.1.0).
- **Not checked live.** The row in the desktop app, the CLI and VS Code for 0.2.0, the sliding animation, wrapping at narrow widths, the `/config` rows applying (and when), the `explainStop` call (timeout, abort, whether `haiku` is allowed on your account), the token-parity claim, background-task end detection, and API-error detection.

## Changes from 0.1.0

- The row is one line above the prompt on every surface, drawn by the plugin with a glyph bar. The native progress element, the spinner suffix, the status-line entry and the VS Code fallback are gone: they depended on built-ins that behaved differently per client, and VS Code showed only a text line.
- A bar is always shown while a turn runs: filled when a task list exists, sliding when it does not.
- The settings page, its local server, its config file and `/pace config` are gone. Settings are plugin options in `/config`. The `display`, `animation`, `showOnVscodeStatus` and `native` bar settings are gone with the things they controlled.
- The "Ask Claude to keep a task list" option is gone. It relied on `prompt.compose`, which a plugin above pace-maker skips.
- Every `classic.*` hook is gone, for the same reason; the signals they provided now come from `tool.check`, `turn.complete`, `tool.call` and `session.append`.

See the [changelog](CHANGELOG.md).

## Development

```
git clone https://github.com/rahat-srijon/srijon-claude-plugins
cd srijon-claude-plugins
claude --plugin-dir plugins/pace-maker
```

Run these inside `plugins/pace-maker`:

- `npm test` runs the Node tests (`tests/*.spec.ts`). They need a Node that runs TypeScript files directly (tested on Node 24).
- `claude plugin test .` runs the engine tests (`tests/engine/*.test.ts`), which load the mod in Claude Code's test harness and mount the band on each surface.
- `claude plugin validate .` checks the manifest. An `ICON_MISSING` warning is expected: there is no icon yet.

## License

MIT
