---
name: teardown-usage
description: Turn off claudio-notify usage-limit sounds and restore the previous status line
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" teardown-usage --data-dir "${CLAUDE_PLUGIN_DATA}"`

Report the result above to the user in one line. Do not run anything else.
