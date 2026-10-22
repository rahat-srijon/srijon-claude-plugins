# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

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
