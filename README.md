# claudio-notify

Audio notifications for Claude Code: distinct, customizable sounds when tasks finish, subagents start or stop, Claude asks a question, or needs permission.

Step away from the terminal and still hear when Claude finishes, asks you something, or needs permission. Each event has its own sound, and you can pick a different sound per model (Opus, Sonnet, Haiku and so on) so you know who is talking to you.

## Install

```
/plugin marketplace add <owner>/claudio-notify
/plugin install claudio-notify@claudio-notify
```

`<owner>` is the GitHub owner of the repository.

Or in one step (needs Claude Code 2.1.275 or later):

```
/plugin install claudio-notify --marketplace <owner>/claudio-notify
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
| `agent_done` | Claude finished its turn | on | `Stop` |
| `subagent_start` | Claude starts a subagent | off | `PreToolUse` (`Agent` / `Task`) |
| `subagent_done` | A subagent finished | on | `SubagentStop` |
| `question` | Claude asks you a question | on | `PreToolUse` (`AskUserQuestion`) |
| `permission` | Claude needs permission to run something | on | `Notification` (`permission_prompt`) |
| `error` | The turn ended with an API error | on | `StopFailure` |

Some details:

- The "finished" sound only plays when the turn took at least `minTurnSeconds` (default 15 seconds), so quick answers stay quiet.
- Subagents that finish together are merged into one sound. A sound for the same event won't play again within `cooldownMs` (default 1500 ms).
- "Subagent started" is off by default. Turn it on in the settings page or the config file.

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

`event` is one of `agent_done`, `subagent_start`, `subagent_done`, `question`, `permission`, `error`. Without `--model`, the test uses the event's normal sound.

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
    "permission": { "sound": "/home/me/sounds/ping.mp3", "volume": 1 }
  },
  "tts": { "template": "{model} {event}" },
  "modelPatterns": { "gpt": "gpt" }
}
```

### Sound specs

| Spec | Meaning |
| --- | --- |
| `default:<id>` | A bundled sound: `done`, `subagent-start`, `subagent-done`, `question`, `permission`, `error` |
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
| `tts.template` | `{model} {event}` | Phrase for `tts`. `{event}` becomes words like "finished" or "needs permission". |
| `modelPatterns` | opus, sonnet, haiku, fable | Family name to the substring that identifies it |

Invalid values are replaced by the defaults, and unknown keys are ignored. Both are noted in the log.

## What it can't do (yet)

- Usage-limit alerts (5-hour or weekly limit nearing or reset) are planned. They will need an opt-in status line integration, because Claude Code only exposes limit data to the status line, and only on Pro and Max plans.
- Usage-credit (extra usage) alerts aren't possible, because Claude Code doesn't expose that data.
- Sounds play on the machine that runs Claude Code. In a remote or SSH session, you won't hear anything on your local machine.

## Troubleshooting

- Run `/claudio-notify:status` to see the settings and which audio and speech backends were found.
- The log is `claudio.log` in the data directory. It is rotated at 1 MiB, and the previous file is kept as `claudio.log.1`.
- No sound on Linux: install `pulseaudio-utils` (for `paplay`), or one of the other players listed above.
- Hooks never print to the conversation, so errors only show up in the log.
- If a config file is broken (bad JSON, wrong types), claudio-notify falls back to the defaults for the affected values and logs a warning.

## Privacy

Everything runs on your machine. claudio-notify makes no network requests, apart from the settings page on 127.0.0.1. It reads session transcripts only to find the model id.

## Development

```
git clone https://github.com/<owner>/claudio-notify
cd claudio-notify
claude --plugin-dir .
```

- `npm run gen-sounds` regenerates the bundled sounds. The output is deterministic.
- `npm test` runs the tests.
- Set `CLAUDIO_DATA_DIR` to a scratch directory to keep your real config and log untouched.

## License

MIT
