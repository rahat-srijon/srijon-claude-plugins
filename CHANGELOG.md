# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Usage-limit sounds for Pro and Max plans: the 5-hour and weekly limits nearing a threshold (80% and 95% by default) and resetting.
- `/claudio-notify:setup-usage`, which shows and, after you confirm, applies a status line shim that reads the limit data and keeps your existing status line output.
- `/claudio-notify:teardown-usage`, which restores the previous status line.
- Per-event `thresholds` for the "near" events and `minPercent` for the reset events.
- An opt-in reset timer (`usageResetTimer`) that plays reset sounds when no session is running.
- Four bundled sounds for the usage events, and a "Usage limits" section in the settings page.
- An `agent_start` event that plays when Claude starts working on a prompt. Off by default.
- Question, permission and error sounds repeat until you respond (`repeatMs`, 30 seconds by default, 0 turns it off).
- Usage "near" sounds can repeat while Claude works (`repeatWhileWorkingMs`) or on every prompt (`remindOnPrompt`) once a threshold is hit. Both off by default.

## [0.1.0] - 2026-10-23

### Added

- Sounds for six events: finished, subagent started, subagent finished, question, permission request and error.
- Bundled default sounds, generated deterministically with `npm run gen-sounds`.
- Per-model sounds (Opus, Sonnet, Haiku, Fable, plus your own families) for the agent events.
- Model detection from the session transcript, the subagent transcript, or the requested and defined subagent model.
- Sound specs for bundled sounds, uploaded files, absolute paths and text-to-speech.
- A local settings page (`/claudio-notify:config`) on 127.0.0.1 with a per-launch token and an idle timeout.
- Upload, preview and delete of your own `.wav` and `.mp3` sounds from the settings page.
- Commands `/claudio-notify:mute`, `:unmute`, `:status` and `:test [event|all] [--model <family>]`.
- Global volume, per-event volume and quiet hours.
- A minimum turn length for the "finished" sound and a cooldown that merges simultaneous sounds.
- Global config in the plugin data directory and a per-project override in `.claude/claudio.json`.
- Playback on Windows (PowerShell), macOS (`afplay`) and Linux (`paplay`, `pw-play`, `ffplay`, `aplay`).
- A rotating log file that never writes to the conversation.

[Unreleased]: https://github.com/rahat-srijon/claudio-notify/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rahat-srijon/claudio-notify/releases/tag/v0.1.0
