# claudio-notify

Audio notifications for Claude Code: distinct, customizable sounds when tasks finish, subagents start or stop, Claude asks a question, needs permission, or you near a usage limit.

Step away from the terminal and still hear when Claude finishes, asks you something, or needs permission. Each event has its own sound, and you can pick a different sound per model (Opus, Sonnet, Haiku and so on) so you know who is talking to you.

## Install

```
/plugin marketplace add rahat-srijon/claudio-notify
/plugin install claudio-notify@claudio-notify
```

Or in one step (needs Claude Code 2.1.275 or later):

```
/plugin install claudio-notify --marketplace rahat-srijon/claudio-notify
```

### Requirements

- Node.js 18 or later on your PATH.
- An audio player:
  - Windows: built in (PowerShell).
  - macOS: built in (`afplay`).
  - Linux: one of `paplay` (pulseaudio-utils), `pw-play`, `ffplay`, or `aplay` (WAV files only).
- Optional, for spoken sounds (`tts`): Windows SAPI, macOS `say`, or Linux `spd-say` / `espeak`.

## Events

| Event | When it plays | Default | Hook |
| --- | --- | --- | --- |
| `agent_start` | Claude starts working on your prompt | off | `UserPromptSubmit` |
| `agent_done` | Claude finished its turn | on | `Stop` |
| `subagent_start` | Claude starts a subagent | off | `PreToolUse` (`Agent` / `Task`) |
| `subagent_done` | A subagent finished | on | `SubagentStop` |
| `question` | Claude asks you a question | on | `PreToolUse` (`AskUserQuestion`) |
| `permission` | Claude needs permission to run something | on | `Notification` (`permission_prompt`) |
| `error` | The turn ended with an API error | on | `StopFailure` |

Some details:

- The "finished" sound only plays when the turn took at least `minTurnSeconds` (default 15 seconds), so quick answers stay quiet.
- Subagents that finish together are merged into one sound. A sound for the same event won't play again within `cooldownMs` (default 1500 ms).
- "Subagent started" and "started working" are off by default. Turn them on in the settings page or the config file.
- "Has a question" and "hit an error" repeat every 30 seconds until you respond (`repeatMs`, 0 turns it off). A reminder stops at the next sign of activity in the session: any hook claudio-notify listens to, or a new message in the session's transcript. Reminders also stop after an hour. "Needs permission" plays once, because Claude Code gives no signal when you approve a permission.

## Usage-limit sounds

On a Pro or Max plan, claudio-notify can also tell you when you near your 5-hour or weekly limit, and when a limit resets.

| Event | When it plays | Default |
| --- | --- | --- |
| `usage_5h_near` | 5-hour usage reaches 80% or 95% | on |
| `usage_5h_reset` | The 5-hour limit resets, if it had reached 80% | on |
| `usage_week_near` | Weekly usage reaches 80% or 95% | on |
| `usage_week_reset` | The weekly limit resets, if it had reached 80% | on |

These need a one-time setup, because Claude Code only shares limit data with the status line. Run `/claudio-notify:setup-usage`. It shows the change it would make to `statusLine` in `~/.claude/settings.json` and applies it only after you confirm.

- Your status line keeps working. Setup puts a small shim in front of your current status line command: `node "<data dir>/usage/statusline.mjs" --tee | <your command>`. The shim reads the limit data and passes the input on to your command, so you see the same output as before. If you had no status line, it stays empty.
- Each session start points the shim at the current plugin version, so plugin updates need no new setup.
- Each threshold plays once per limit window. Crossing several at once plays once.
- To keep hearing it while a limit is past a threshold, set `repeatWhileWorkingMs` (replays while Claude works on a prompt, until the turn ends, you press Esc, or the window resets) or turn on `remindOnPrompt` (replays on every prompt). Both are off by default.
- A reset is noticed when the window's reset time passes or its usage drops. While a session is open, Claude Code re-runs the status line at the reset time, so the sound is on time. Resets noticed more than 15 minutes late stay silent.
- To also hear resets when no session is running, turn on "Play reset sounds when no session is running" in the settings page (`usageResetTimer`). A small background process then waits for a pending reset and exits once it has played.
- `/claudio-notify:teardown-usage` restores your previous status line. Run it before uninstalling claudio-notify, because uninstalling can delete the plugin data directory and the shim with it.

## Per-model sounds

`agent_done`, `subagent_start` and `subagent_done` can have a different sound for each model family. claudio-notify finds the model like this:

- Main agent finished: from the session transcript.
- Subagent finished: from the subagent's own transcript.
- Subagent started: from the model requested for it, then the `model:` in the agent's definition, then the session model.

If the model can't be found, it falls back to the session model, and then to the event's normal sound.

A model id is matched to a family by a case-insensitive substring. The built-in families are `opus`, `sonnet`, `haiku` and `fable`. You can add your own family under `modelPatterns`.

## Settings

Run `/claudio-notify:config` to open a local settings page in your browser. There you can:

- Turn events on or off and pick the sound for each one.
- Set a different sound per model family for the agent events.
- Preview any sound.
- Upload your own `.wav` or `.mp3` files (up to 5 MB each) and delete them again.
- Change the volume (global and per event), quiet hours, the minimum turn length and the cooldown.
- Mute everything.

The page is local only. It listens on 127.0.0.1, every launch uses a new secret token, and the server shuts down when you click Done or after 10 minutes without activity.

## Commands

| Command | What it does |
| --- | --- |
| `/claudio-notify:config` | Open the settings page |
| `/claudio-notify:mute` | Silence all sounds |
| `/claudio-notify:unmute` | Turn sounds back on |
| `/claudio-notify:status` | Show settings, quiet hours and detected audio backends |
| `/claudio-notify:test [event\|all] [--model <family>]` | Play one event's sound, or every enabled event's. Plays even when muted. |
| `/claudio-notify:setup-usage` | Set up usage-limit sounds through the status line, after you confirm |
| `/claudio-notify:teardown-usage` | Turn usage-limit sounds off and restore the previous status line |

`event` is one of `agent_start`, `agent_done`, `subagent_start`, `subagent_done`, `question`, `permission`, `error`, `usage_5h_near`, `usage_5h_reset`, `usage_week_near`, `usage_week_reset`. Without `--model`, the test uses the event's normal sound.

## Configuration file

You normally don't need to edit this by hand, since the settings page writes it for you.

- Global config: `config.json` in the plugin data directory, usually `~/.claude/plugins/data/<plugin id>/config.json`. It survives plugin updates.
- Per-project override: `<project>/.claude/claudio.json`. It is deep-merged over the global config, so it only needs the keys you want to change.

```json
{
  "volume": 0.6,
  "minTurnSeconds": 30,
  "quietHours": { "enabled": true, "from": "22:00", "to": "07:00" },
  "events": {
    "agent_done": {
      "sound": "default:done",
      "byModel": {
        "opus": "user:deep-gong.wav",
        "haiku": "tts"
      }
    },
    "subagent_start": { "enabled": true },
    "permission": { "sound": "/home/me/sounds/ping.mp3", "volume": 1 },
    "usage_5h_near": { "thresholds": [75, 90, 98] },
    "usage_week_reset": { "minPercent": 50 }
  },
  "tts": { "template": "{model} {event}" },
  "modelPatterns": { "gpt": "gpt" }
}
```

### Sound specs

| Spec | Meaning |
| --- | --- |
| `default:<id>` | A bundled sound: `start`, `done`, `subagent-start`, `subagent-done`, `question`, `permission`, `error`, `usage-near`, `usage-reset`, `usage-week-near`, `usage-week-reset` |
| `user:<file>` | A `.wav` or `.mp3` in the `sounds` folder of the data directory (the settings page uploads there). File name only, no folders. |
| `/absolute/path/to/file.wav` | Any `.wav` or `.mp3` file, by absolute path |
| `tts` | Speak a phrase built from `tts.template`, for example "Opus finished" |

If a sound can't be found or played, claudio-notify falls back to the event's bundled sound.

### Keys

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `muted` | `false` | Silence everything (what `mute` sets) |
| `volume` | `0.8` | Global volume, 0 to 1 |
| `quietHours` | off, 22:00 to 07:00 | `enabled`, `from`, `to` (local time, `HH:MM`). No sounds during this window. |
| `minTurnSeconds` | `15` | Shortest turn that gets a "finished" sound |
| `cooldownMs` | `1500` | Minimum gap between sounds of the same event |
| `events.<event>.enabled` | see Events | Turn one event on or off |
| `events.<event>.sound` | `default:<id>` | Sound spec for the event |
| `events.<event>.volume` | `null` | Volume for this event, or `null` to use the global one |
| `events.<event>.byModel` | `{}` | Agent events only: family to sound spec |
| `events.<event>.repeatMs` | `30000` | `question` and `error` only: replay every this many ms until you respond. `0` turns it off; at least `1000`. |
| `events.<event>.repeatWhileWorkingMs` | `0` | `usage_5h_near` and `usage_week_near` only: once a threshold is hit, replay every this many ms while Claude works. `0` turns it off. |
| `events.<event>.remindOnPrompt` | `false` | `usage_5h_near` and `usage_week_near` only: once a threshold is hit, replay on every prompt |
| `events.<event>.thresholds` | `[80, 95]` | `usage_5h_near` and `usage_week_near` only: usage percentages that each play once per window |
| `events.<event>.minPercent` | `80` | `usage_5h_reset` and `usage_week_reset` only: play the reset only if the window that ended reached this percentage. `0` plays every reset. |
| `usageResetTimer` | `false` | Keep a background timer that plays reset sounds when no session is running |
| `tts.template` | `{model} {event}` | Phrase for `tts`. `{event}` becomes words like "finished" or "needs permission". |
| `modelPatterns` | opus, sonnet, haiku, fable | Family name to the substring that identifies it |

Invalid values are replaced by the defaults, and unknown keys are ignored. Both are noted in the log.

## What it can't do (yet)

- Usage-limit sounds only work on Pro and Max plans, because Claude Code only gives limit data to the status line, and only for those plans. They need `/claudio-notify:setup-usage`, and the data arrives after the first response in a session.
- Without the reset timer, a reset is only noticed while a Claude Code session is open.
- Usage-credit (extra usage) alerts aren't possible, because Claude Code doesn't expose that data.
- Sounds play on the machine that runs Claude Code. In a remote or SSH session, you won't hear anything on your local machine.

## Troubleshooting

- Run `/claudio-notify:status` to see the settings and which audio and speech backends were found.
- The log is `claudio.log` in the data directory. It is rotated at 1 MiB, and the previous file is kept as `claudio.log.1`.
- No sound on Linux: install `pulseaudio-utils` (for `paplay`), or one of the other players listed above.
- Hooks never print to the conversation, so errors only show up in the log.
- If a config file is broken (bad JSON, wrong types), claudio-notify falls back to the defaults for the affected values and logs a warning.

## Privacy

Everything runs on your machine. claudio-notify makes no network requests, apart from the settings page on 127.0.0.1. It reads session transcripts only to find the model id. With usage-limit sounds set up, it reads the status line input only for the limit percentages and reset times, and stores those in the data directory.

## Development

```
git clone https://github.com/rahat-srijon/claudio-notify
cd claudio-notify
claude --plugin-dir .
```

- `npm run gen-sounds` regenerates the bundled sounds. The output is deterministic.
- `npm test` runs the tests.
- Set `CLAUDIO_DATA_DIR` to a scratch directory to keep your real config and log untouched.

## License

MIT
