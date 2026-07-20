---
description:
  Activate the repository's evergreen orchestrator and project/user subagent scope
---

Read `.pi/agents/orchestrator.md` completely and adopt it in this **root Pi session** as the
sole control-plane role. Do not spawn `orchestrator` as a nested subagent; it must remain at
the root so it can dispatch coder and reviewer workers.

For every applicable worker subagent call, explicitly pass:

```json
{
  "agentScope": "both",
  "confirmProjectAgents": false
}
```

These are per-call arguments, not persistent tool configuration. Do not claim the scope is active
unless you include them on the call.

Begin with the orchestrator's startup reconciliation. Preserve unrelated owner changes and do not
dispatch implementation directly from a Backlog investigation ticket.
