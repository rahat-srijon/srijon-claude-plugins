# pace-maker

A per-conversation progress band for Claude Code: how far the current task is, checkable at a glance.

Start a long run, look away, and check back without scrolling the chat or sending a prompt. pace-maker shows a band above the prompt with a progress bar, the step Claude is on, and the elapsed time. When Claude stops, the band says why, in a color you can read from across the room.

pace-maker is a mod: it runs inside Claude Code, draws its own interface, and makes no model calls by default. It is part of the [srijon-claude-plugins](../../README.md) marketplace.

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

Desktop app: `/plugin` is a terminal command and does not run in the Code tab. Click + next to the prompt box, then Plugins, then Add marketplace with `rahat-srijon/srijon-claude-plugins`, then Add plugin. This route has not been run end to end; see Known limits.

### Requirements

- Claude Code CLI 2.1.287 or later, or the VS Code extension 2.1.299 or later (the versions that load mods).
- The desktop app: the minimum version is not known. It was tried on a build that loads mods.
- Node.js 18 or later on your PATH, for the settings page only. The band itself needs no Node.

## What it shows

Exactly one state at a time. Each has an icon as well as a color, so it still reads in a monochrome terminal. Colors are theme tokens, so they follow your theme.

| State | When | Shows | Color |
| --- | --- | --- | --- |
| Hidden | No task list and nothing running, or pace-maker is off | Nothing | n/a |
| Progress | A task list exists and Claude is working | A progress bar, then `3/5 · Running tests · 12m` | Theme accent |
| Working | Work is running but progress cannot be measured: no task list, a background command, subagents, a monitor | `● Working · npm test in background · 4m` | Neutral (`subtle`) |
| Stopped | Nothing running, steps left, and no event explains it | `○ Stopped · 2 of 5 steps left` | Neutral (`subtle`) |
| Done | Every step is completed and the turn ended | `✓ Done · 5/5 · 18m` | Green (`success`) |
| Waiting | Something outside Claude's control that you can resolve: a permission prompt, a question for you, a usage limit | `⏸ Waiting for permission: Bash` | Orange (`warning`) |
| Blocked | Claude cannot continue without a fix: an API error, a denied permission, tasks waiting on unmet dependencies | `⛔ Blocked · permission denied: Bash` | Red (`error`) |
| Paused | Stopped by your choice or the plan's: you pressed Esc, a plan waits for approval, or you ran `/pace pause` | `⏸ Paused by you · 3/5` | Blue (`suggestion`) |

Details:

- A reason is only shown when an event explains it. Otherwise the state stays neutral and states facts only, such as `2 of 5 steps left`.
- A plain-text question counts as Waiting. The rule has no model call: the turn ended normally, steps are left, and the last paragraph of Claude's answer is short and ends with `?`. It misses a question phrased without a question mark, and it can flag a rhetorical `?`. When unsure it stays neutral.
- A permission prompt shows as Waiting even in the middle of a turn.
- The bar animates smoothly between real values. It never moves within a step.
- A new task list after Done or Hidden starts fresh. A new prompt while a list is unfinished keeps it.

## Where the progress comes from

Only Claude's own task tools, which pace-maker watches:

- `TaskCreate` and `TaskUpdate`
- `TodoWrite`
- The desktop app's own `update_plan` (a `wrap_up` call completes the list)

Progress is the completed steps divided by all steps, minus deleted ones. The label is the step in progress.

With no task list, pace-maker shows the neutral Working and Stopped states and never a made-up bar. On some setups Claude has no task tool at all. In testing, this machine's CLI offered none of the three, and only the desktop app offered `update_plan`. There the band shows Working and Stopped, not a bar. Turning on the "Ask Claude to keep a task list" option cannot help when no task tool exists, so it only adds its line when one does.

## Tokens

pace-maker uses zero model tokens by default. Its hooks only observe events, and it draws the band itself. It has one exception and two opt-in settings:

- **The `/pace` command text.** A plugin command's one-line output (for example `Resumed.`) is read by the model on its next request, so each `/pace` command adds a few tokens. The lines are kept short on purpose.
- **Explain why it stopped (Uses AI, off by default).** When a turn ends with steps left and no event explains it, one small-model call (`haiku`, at most 30 tokens out, low effort, 15 second limit) reads the end of Claude's last answer and writes a reason of 8 words or fewer. Expect a few hundred tokens per such stop. The call runs in the background, never delays the turn, and is cancelled when the next turn starts. If it fails or the model is not available, nothing is shown.
- **Ask Claude to keep a task list (Uses AI, off by default).** Adds one sentence to the system prompt, roughly 20 to 30 tokens per session, so Claude is more likely to keep a task list and the bar appears more often. It is added only when the session has a task tool.

With both off and no `/pace` commands, usage is the same with the plugin on and off.

## Clients

| Client | What is drawn | Status |
| --- | --- | --- |
| Desktop app (Code tab) | The band above the prompt, with a native progress bar | Seen on screen |
| CLI | The band above the prompt, with a native progress bar | Seen on screen |
| VS Code extension | No band: VS Code does not draw it. The state goes into the spinner suffix and the status line instead (setting `showOnVscodeStatus`) | Not yet verified on a live VS Code |
| Mobile | Out of scope | n/a |

Because the band is one row per plugin, it sits beside other mods' bands without conflict. The status line entry is cleared when a turn completes.

## Commands

One command, `/pace`, because command names cannot contain a colon. It runs without a Claude turn and applies to the current conversation only. The setting survives a mod reload and never affects other conversations.

| Command | What it does |
| --- | --- |
| `/pace off` | Hide the band for this conversation |
| `/pace on` | Show it again and clear any pause |
| `/pace pause <reason>` | Show the blue Paused state with your reason |
| `/pace resume` | Clear the pause |
| `/pace config` | Open the settings page |

Anything else prints a one-line usage message.

## Settings

`/pace config` starts the settings page and prints its URL. It runs a small Node server, which Claude Code allows only in the CLI (`$.process` is CLI only). From the desktop app or VS Code, the command instead prints the line to run in a terminal:

```
node "<plugin folder>/scripts/cli.js" config
```

Like claudio-notify's page, it is local only: it listens on 127.0.0.1, every launch uses a new secret token, and the server shuts down when you click Done or after 10 minutes without activity.

The page writes `~/.claude/plugins/data/pace-maker/config.json`. Set `PACE_MAKER_DATA_DIR` to use another folder. You normally don't edit it by hand. The settings are read at session start, at each turn start, and on every `/pace` command, so a saved change applies by the next turn at the latest. Invalid or missing values fall back to the defaults.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Global on/off |
| `display` | `bar` | `bar` (bar and label) or `text` (text only) |
| `barStyle` | `native` | `native`, `blocks`, `thin`, `dots` or `ascii` |
| `barWidth` | `20` | 10 to 40 characters; applies to the character styles, not `native` |
| `fields.stepCount` | `true` | Show `3/5` |
| `fields.percentage` | `false` | Show the percentage |
| `fields.stepLabel` | `true` | Show the step in progress |
| `fields.elapsed` | `true` | Show elapsed time |
| `fields.subagents` | `true` | Show the running subagent count |
| `animation` | `smooth` | `smooth` or `instant` |
| `showOnVscodeStatus` | `true` | Use the spinner suffix and status line in VS Code |
| `ai.explainStop` | `false` | Uses AI: explain an unexplained stop |
| `ai.askForTaskList` | `false` | Uses AI: ask Claude to keep a task list |

## Known limits

- **Permission-prompt detection can be bypassed.** A plugin that runs above pace-maker can swallow the event it relies on (seen once in the CLI). pace-maker uses a second signal, and when unsure it stays neutral instead of guessing.
- **Background-task end detection is best effort.** Claude Code has no event for it, so pace-maker infers it from task notifications, subagent and task-stop events, the end of a turn and the end of the session. A finished background task can show as Working for a while.
- **Failed tool calls are not covered.** `PostToolUseFailure` is not used, so a failing tool alone does not turn the band red.
- **No badge in the conversation list.** The mod API cannot add one. The desktop sidebar keeps its own indicators.
- **Settings page outside the CLI.** It cannot be started from the desktop app or VS Code (see Settings).
- **Not yet checked live.** The VS Code spinner suffix and status line, the elapsed-time tick and bar easing on screen, whether the "Ask Claude to keep a task list" line updates right after you toggle it (it may only apply at the next session or compaction), the stop-reason call's timeout and abort behavior, whether `haiku` is allowed on your account, and whether the saved settings are read in a desktop-hosted session.
- The format of the task-notification message used for background detection is unverified.

## Development

```
git clone https://github.com/rahat-srijon/srijon-claude-plugins
cd srijon-claude-plugins
claude --plugin-dir plugins/pace-maker
```

Run these inside `plugins/pace-maker`:

- `npm test` runs the Node tests (`tests/*.spec.ts` and `scripts/test/*.spec.js`). The `.ts` tests need a Node that runs TypeScript files directly (tested on Node 24).
- `claude plugin test .` runs the engine tests, which load the mod in Claude Code's test harness.
- `claude plugin validate .` checks the manifest. An `ICON_MISSING` warning is expected: there is no icon yet.
- Set `PACE_MAKER_DATA_DIR` to a scratch folder to keep your real config untouched.

## License

MIT
