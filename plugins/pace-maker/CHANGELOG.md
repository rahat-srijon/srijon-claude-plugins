# Changelog

All notable changes to pace-maker are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-18

### Added

- A smooth progress bar across the full width of the band: a Raster cell bar on the terminal (sub-cell fill edge, gradient, dim track) and an Svg bar on the desktop app, VS Code and mobile. The plain text bar stays as the fallback.
- The final row stays after a turn that did work (a tool call, a task list, or 8 seconds or more) until the next prompt, in every client. With no task list a normal end is Done with a full bar.
- Fixed bar colors per state: violet-blue for progress and working, teal-green for done, amber for waiting, red for blocked, cyan-blue for paused, grey for stopped.
- The determinate fill eases toward its target instead of jumping.
- `node design/preview.mjs` writes an HTML preview of every state's bar at three widths.

### Changed

- The band is two rows: one non-wrapping text line (icon, state and step label on the left; count, percentage and elapsed time on the right) over the bar.
- A plain-text question ending in `?` is Waiting for your answer with or without a task list.
- `barStyle` defaults to `smooth`; `blocks`, `thin`, `dots` and `ascii` now force the plain text bar.
- A quick chat reply with no tool call and under 8 seconds still leaves the band hidden.

### Removed

- The `barWidth` setting: the bar fills the width of the band.
- The one-row layout and the hiding of the band when a turn ends without a task list.

## [0.2.0] - 2026-11-18

### Added

- One row above the prompt on every surface (terminal, desktop and VS Code), drawn by the plugin with a hand-drawn glyph bar. Bar styles `blocks`, `thin`, `dots` and `ascii`, 10 to 40 cells wide.
- A bar whenever a turn runs: determinate when a task list exists, a sliding indeterminate bar when it does not, never an invented fraction.
- Settings as plugin options shown in `/config`: `enabled`, `barStyle`, `barWidth`, `showCount`, `showPercent`, `showLabel`, `showElapsed`, `showSubagents` and `explainStop`.
- Engine tests that mount the band on the terminal, desktop and VS Code surfaces.

### Changed

- The `Paused` state uses the `planMode` theme token and the Blocked icon is `✖`.
- The signals for permission prompts, denied permissions, API errors, usage limits, plans and background-task ends now come from `tool.check`, `tool.call`, `turn.complete` and `session.append`.
- The Working and Stopped states also show the sliding or held bar.
- `explainStop` is the only AI feature and stays off by default.

### Removed

- Every `classic.*` hook and `prompt.compose`. A plugin that runs above pace-maker skips them and Claude Code printed a notice for each.
- The "Ask Claude to keep a task list" option, which depended on `prompt.compose`.
- The settings page, its local Node server, the config file and `/pace config`.
- The native progress element, the spinner suffix, the status-line entry and the VS Code fallback.
- The `display`, `animation`, `showOnVscodeStatus` settings and the `native` bar style.

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

[0.3.0]: https://github.com/rahat-srijon/srijon-claude-plugins/releases/tag/pace-maker-v0.3.0
[0.2.0]: https://github.com/rahat-srijon/srijon-claude-plugins/releases/tag/pace-maker-v0.2.0
[0.1.0]: https://github.com/rahat-srijon/srijon-claude-plugins/releases/tag/pace-maker-v0.1.0
