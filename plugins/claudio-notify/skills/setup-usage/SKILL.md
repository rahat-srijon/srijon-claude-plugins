---
name: setup-usage
description: Set up claudio-notify usage-limit sounds by routing the status line through a small shim
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" setup-usage --data-dir "${CLAUDE_PLUGIN_DATA}"`

The output above is a planned change to the user's Claude Code settings, or says that nothing needs to change.

- If nothing needs to change, report that in one line and stop.
- Otherwise show the user the planned change, including the before and after status line, and ask whether to apply it. Use AskUserQuestion when it is available.
- If they confirm, run exactly this and report its result in one line:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" setup-usage --yes --data-dir "${CLAUDE_PLUGIN_DATA}"`
- If they decline, say that nothing was changed.

Do not edit any settings file yourself, and do not run anything else.
