---
name: config
description: Open the claudio-notify settings page to choose sounds per event and per model
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" config --data-dir "${CLAUDE_PLUGIN_DATA}"`

Tell the user the settings page is open and give them the URL above in case the browser didn't open. Do not run anything else.
