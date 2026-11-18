# pace-maker

A per-conversation progress band for Claude Code: how far the current task is, checkable at a glance.

Start a long run, look away, and check back without scrolling the chat or sending a prompt. pace-maker draws two rows above the prompt: a line of text (the step Claude is on, the count and the elapsed time) over a smooth progress bar. When Claude stops, the band says why, in a color you can read from across the room, and it stays there until your next prompt.

pace-maker is a mod: it runs inside Claude Code, draws its own interface, and makes no model calls by default. It is part of the [srijon-claude-plugins](../../README.md) marketplace.

## What the band looks like

Two rows, the same layout on every surface:

1. **Text row.** One line that never wraps (it is cut instead). Left: an icon, the state and the step label. Right: the count, the percentage and the elapsed time, per your settings.
2. **Bar row.** A smooth bar across the full width of the band. On the terminal it is a row of colored cells with sub-cell precision, a gradient and a dim track. On the desktop app and VS Code it is a vector bar with rounded ends. If neither can be drawn, or `barStyle` is a glyph style, it is a plain text bar.

The text row for each state, with a note of what the bar underneath does:

```
▶ Progress · Running tests                    3/5 · 60% · 12m     bar: filled to 60%
● Working · npm test in background            4m · 2 subagents    bar: a soft segment slides along the track
✓ Done                                        5/5 · 18m           bar: full
✓ Done · 40s                                                      bar: full (no task list)
⏸ Waiting for permission: Bash                3/5                 bar: held, amber
⏸ Waiting for your answer                     3/5                 bar: held, amber
✖ Blocked · permission denied: Bash           3/5                 bar: held, red
⏸ Paused by you                               3/5                 bar: held, cyan-blue
○ Stopped · 2 of 5 steps left                 3/5                 bar: held at the list share, grey
```

A rough sketch of a two-row band (ascii only; the real bar is smooth):

```
▶ Progress · Running tests                    3/5 · 60% · 12m
[############----------------]
```

The percentage is off by default (`showPercent`). The pieces on the right can be switched off one by one with the `show*` settings.

## What it shows

Exactly one state at a time. Each has an icon as well as a color, so it still reads in a monochrome terminal. Text colors are theme tokens and follow your theme; bar colors are fixed hex values chosen to read on dark and light backgrounds.

| State | When | Text row | Bar |
| --- | --- | --- | --- |
| Hidden | pace-maker is off, nothing has finished yet in the conversation, or a quick reply that used no tool and took under 8 seconds | Nothing | None |
| Progress `▶` | A task list exists and Claude is working | `Progress · <step>` and `3/5 · 12m` | Filled to the share done (violet-blue) |
| Working `●` | Work is running with no task list to measure: a turn, a background command, subagents, a monitor | `Working` and `4m` | Sliding segment (violet-blue) |
| Stopped `○` | The turn ended, steps are left, and no event explains it | `Stopped · 2 of 5 steps left` | Held at the list share (grey) |
| Done `✓` | The turn ended normally and nothing is left, with or without a task list | `Done`, `5/5 · 18m` or `Done · 40s` | Full (teal-green) |
| Waiting `⏸` | Something you can resolve: a permission prompt, a question for you, a usage limit | `Waiting for permission: Bash`, `Waiting for your answer` | Held (amber) |
| Blocked `✖` | Claude cannot continue without a fix: an API error, a denied permission, tasks waiting on unmet dependencies | `Blocked · permission denied: Bash` | Held (red) |
| Paused `⏸` | Stopped by your choice or the plan's: you pressed Esc, a plan waits for approval, or you ran `/pace pause` | `Paused by you`, `Plan ready for approval` or `Paused · <your reason>` | Held (cyan-blue) |

Details:

- **The band stays after a turn ends.** After a turn that did work (at least one tool call, a task list, or 8 seconds or more) the final row stays until your next prompt starts a turn. It is Done with a full bar when nothing is left (even with no task list), or Stopped, Waiting, Paused or Blocked when a reason applies. It also goes away with `/pace off` or `enabled` off. A quick chat reply with no tool call and under 8 seconds leaves the band hidden.
- A reason is only shown when an event explains it. Otherwise the state stays neutral and states facts only, such as `2 of 5 steps left`.
- A plain-text question counts as Waiting for your answer, with or without a task list. The rule has no model call: the turn ended normally and the last paragraph of Claude's answer is short and ends with `?`. It misses a question phrased without a question mark, and it can flag a rhetorical `?`. When unsure it stays neutral.
- A permission prompt shows as Waiting even in the middle of a turn, and the bar stays visible (held in place).
- A new task list after Done starts fresh. A new prompt while a list is unfinished keeps it.

## Where the progress comes from

Only Claude's own task tools, which pace-maker watches:

- `TaskCreate` and `TaskUpdate`
- `TodoWrite`
- The desktop app's own `update_plan` (a `wrap_up` call completes the list)

With a list, the bar is determinate: completed steps divided by all steps, minus deleted ones, and it eases toward a new value instead of jumping. The label is the step in progress.

With no list, the bar is a soft segment that slides along the track for as long as a turn runs, and the text says Working. It never implies a fraction: pace-maker does not invent progress. A model without a task tool therefore shows only the sliding bar.

## Tokens

pace-maker uses zero model tokens by default. Its hooks only observe events, and it draws the band itself. There is one exception and one opt-in setting:

- **The `/pace` reply text.** A plugin command's one-line output (for example `Resumed.`) is read by the model on its next request, so each `/pace` command adds a few tokens. The lines are kept short on purpose.
- **Explain why it stopped (`explainStop`, Uses AI, off by default).** It is the only AI feature. When a turn ends with steps left and no event explains it, one small-model call (`haiku`, at most 30 tokens out, low effort, 15 second limit) reads the end of Claude's last answer and writes a reason of 8 words or fewer. Expect a few hundred tokens per such stop. The call runs in the background, never delays the turn, and is cancelled when the next turn starts. If it fails or the model is not available, nothing is shown.

With `explainStop` off and no `/pace` commands, usage is the same with the plugin on and off (this was not measured live; see Known limits).

## Clients

| Client | What is drawn | Status |
| --- | --- | --- |
| CLI (terminal) | Two rows: the text row over a Raster bar (colored cells) | **Unverified live** until you check it |
| Desktop app (Code tab) | Two rows: the text row over an Svg bar | **Unverified live** until you check it |
| VS Code extension | Two rows: the text row over an Svg bar | **Unverified live** until you check it |
| Mobile | The same two rows with the Svg bar, if the client loads mods | Not tried; **unverified** |

The engine tests mount the band on the terminal, desktop and VS Code surfaces and assert both rows, so the band is drawn there in the test harness. That is not the same as seeing it in the real client: how smooth the bar looks, the Raster paint and repaint (blit) on the terminal, and the Svg animation are all unverified live. Because the band belongs to this plugin alone, it sits beside other mods' bands without conflict.

## Install

```
/plugin marketplace add rahat-srijon/srijon-claude-plugins
/plugin install pace-maker@srijon-claude-plugins
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
| `barStyle` | `smooth` | `smooth` (a gradient bar: terminal cells, or a vector bar in the desktop app and VS Code), or a plain text bar: `blocks` (`█░`), `thin` (`▬─`), `dots` (`●○`), `ascii` (`[##--]`) |
| `showCount` | on | Show done/total steps, e.g. `3/5` |
| `showPercent` | off | Show the percentage done |
| `showLabel` | on | Show the step in progress (and what runs in the background) |
| `showElapsed` | on | Show how long the work has been running |
| `showSubagents` | on | Show how many subagents are running |
| `explainStop` | off | Uses AI: when Claude stops with steps left, one small-model call writes a short reason |

The bar always fills the width of the band, so there is no width setting.

## Commands

One command, `/pace`, because command names cannot contain a colon. It runs without a Claude turn and applies to the current conversation only.

| Command | What it does |
| --- | --- |
| `/pace off` | Hide the band for this conversation |
| `/pace on` | Show it again and clear any pause |
| `/pace pause <reason>` | Show the cyan-blue Paused state with your reason |
| `/pace resume` | Clear the pause |

Anything else prints a one-line usage message.

## Known limits

- **Only events that are not skipped are used.** A plugin that runs above pace-maker (such as an organization's security plugin) can skip a plugin's `classic.*` hooks and `prompt.compose`, and Claude Code then prints a notice in the transcript for each. pace-maker registers none of them. What it uses instead has these limits:
  - A permission prompt is detected from `tool.check` resolving to an ask. A denied permission comes from `tool.check` or a refused `tool.call`.
  - An API error or usage limit is matched from the reply text of `turn.complete`. This is heuristic text matching and has not been tested against a real API error.
  - The end of a background task is parsed from task-notification rows (`<task-id>` and `<status>`). The format was observed, but the parsing is not live-tested. A finished background task can show as Working for a while.
- **Failed tool calls are not covered.** A failing tool alone does not turn the band red.
- **No badge in the conversation list.** The mod API cannot add one. The desktop sidebar keeps its own indicators.
- **A model without a task tool shows only the sliding bar.** pace-maker does not ask Claude to keep a task list.
- **Not checked live.** Everything about how the band looks in the real clients: the Raster bar and its repaint on the terminal, the Svg bar and its animation on the desktop app and VS Code, the smoothness, the one-line text row at narrow widths, the final row staying after a turn in each client, the `/config` rows applying (and when), the `explainStop` call (timeout, abort, whether `haiku` is allowed on your account), the token-parity claim, background-task end detection, and API-error detection.

## Changes from 0.2.0

- **Two rows.** The text is one non-wrapping line (icon, state and step label on the left; count, percentage and elapsed time on the right) and the bar is its own row below it. In 0.2.0 the text and a short bar shared one row that wrapped on a narrow window.
- **A smooth bar.** A full-width gradient bar: a Raster cell bar on the terminal, a rounded Svg bar on the desktop app and VS Code. The old glyph bars remain as styles and as the fallback.
- **The result stays.** After a turn that did work the final row stays until the next prompt, in the CLI and VS Code as well. With no task list a normal end is now Done, not hidden.
- **Questions.** A plain-text question ending in `?` is Waiting for your answer whether or not a task list exists. It used to need steps left.
- **Settings.** `barStyle` gains `smooth` (the new default) next to `blocks`, `thin`, `dots` and `ascii`; `barWidth` is removed because the bar fills the width.
- Still no skipped hooks: no `classic.*` and no `prompt.compose`.

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
- `node design/preview.mjs [output.html]` renders every state's bar (the terminal cell grid and the Svg markup) at three widths into one HTML file, using the same bar functions as the plugin. With no argument it writes `prompts/pace-maker-v3-preview.html` in the nearest folder above that has a `prompts` folder, otherwise next to the script. It is not loaded by the plugin.
- `claude plugin validate .` checks the manifest. An `ICON_MISSING` warning is expected: there is no icon yet.

## License

MIT
