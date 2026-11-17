# Changelog

All notable changes to pace-maker are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-17

### Added

- A per-conversation progress band above the prompt on the desktop app and the CLI, with a native progress bar, the step in progress and the elapsed time.
- Eight states with an icon and a theme color each: hidden, progress, working, stopped, done, waiting (orange), blocked (red) and paused (blue).
- Progress read from the existing task tools only: `TaskCreate` and `TaskUpdate`, `TodoWrite`, and the desktop app's `update_plan`. With no task list it shows the neutral Working and Stopped states, never a made-up bar.
- Reasons from events, not guesses: permission prompts, plain-text questions, usage limits, API errors, denied permissions, user interrupts and plans waiting for approval. When no event explains a stop, the state stays neutral.
- Background work tracking for background commands, subagents and monitors, shown as Working.
- A VS Code fallback that uses the spinner suffix and the status line, because VS Code does not draw the band.
- The `/pace` command: `on`, `off`, `pause <reason>`, `resume` and `config`, per conversation and without a Claude turn.
- A local settings page (`/pace config`) on 127.0.0.1 with a per-launch token and an idle timeout, and a config file in the plugin data directory (`PACE_MAKER_DATA_DIR` overrides it). From the desktop app or VS Code, the command prints the line to run in a terminal.
- Settings for the display (bar or text), the bar style and width, the fields beside the bar, the animation and the VS Code status.
- Two opt-in "Uses AI" settings, both off by default: explain why a turn stopped (one small-model call per unexplained stop) and ask Claude to keep a task list (one line in the system prompt).

[0.1.0]: https://github.com/rahat-srijon/srijon-claude-plugins/releases/tag/pace-maker-v0.1.0
