## Section ref 3.2
- RE: _"Tests and documentation describe current behavior; they are not immutable when a ticket intentionally changes that behavior. An implementation ticket must identify which current tests or docs are expected to change."_
  - Owner: Are we adding a step at the end of the ticket lifecycle where an agent compares implementation behavior against current state of tests, /docs, README, etc? If a conflict of accuracy is identified, there's a protocol to resolve?

## Section ref 14
- The owner has moved the `agentScope` invocation from `AGENTS.md` into a new prompt template _.pi/prompts/activate_project_subagentScope.md_ to easily invoke the session's subagent config activation. The prompt sets `agentScope = "both"` so the orchestrator can call project and user level subagents.
- The owner has created a prompt template _.pi/prompts/activate_project_subagentScope.md_ to easily invoke the session agent to adopt the `orchestrator` role by reading the `project-orchestrator.md` file. Also, see requested file migrate note below.

## Requested file migrations & renaming
- The owner has moved `project-orchestrator.md` to `.pi/agents` directory and updated the frontmatter to standard definitions 
- Rename `PRD_Audio_Feedback_Implementation.md` to `PRD_Audio_Feedback_Implementation_v3_FINAL_MVP.md` and move to `_ignore/PRD` directory.
- I'd prefer the directory `extensions/` to be renamed to `src/`
- Move `Coding_Best_Practices.md` to `docs/` directory.
- **IMPORTANT**: Some of these changes will cause broken paths. Ask a subagent to update global file path refs.
