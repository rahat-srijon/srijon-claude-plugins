---
name: unmute
description: Unmute claudio-notify sounds
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" unmute --data-dir "${CLAUDE_PLUGIN_DATA}"`

Report the result above to the user in one line. Do not run anything else.
