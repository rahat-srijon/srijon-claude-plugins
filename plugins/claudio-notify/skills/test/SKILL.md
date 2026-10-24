---
name: test
description: Play the claudio-notify sound for an event, or for all enabled events
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: '[event|all] [--model <family>]'
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" test --data-dir "${CLAUDE_PLUGIN_DATA}" $ARGUMENTS`

Report the result above to the user in one line. Do not run anything else.
