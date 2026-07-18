# Evergreen Subagent Recalibration Plan

**Status:** Approved and implemented  
**Scope:** Recalibrate `.pi/agents/project-orchestrator.md`, `.pi/agents/coder.md`, and
`.pi/agents/code-reviewer.md` for evergreen post-MVP work.  
**Primary goal:** Turn Backlog investigation tickets into traceable, non-conflicting implementation
work using the current repository as the baseline rather than the MVP PRD.

## 1. Recommended decisions

1. **Retire `_ignore/PRD/PRD_Audio_Feedback_Implementation_v3_FINAL_MVP.md` as an agent authority.**
   Keep it only as historical v0.1.0 context. Agents must not use it to reject, constrain, or invent
   post-MVP behavior.
2. **Treat Backlog tickets as investigation intake, not executable work.** A coder is never assigned
   directly from a Backlog intake ticket.
3. **Give the owner and orchestrator different ownership boundaries:**
   - The **owner** owns the user problem, desired outcome, priority, product constraints, and
     product decisions.
   - The **orchestrator** owns repository investigation, technical action items, scope,
     dependencies, implementation slicing, acceptance criteria, and verification commands.
4. **Remove workflow boilerplate from intake tickets.** The current `Action items` text in issues
   #22 and #23 belongs in `.pi/agents/project-orchestrator.md`, not in every ticket.
5. **Create separate implementation tickets after investigation.** Each must link its source intake
   ticket and pass a readiness gate before receiving `ready-for-agent`.
6. **Keep one code-changing ticket active at a time by default.** Read-only investigation may be
   delegated in parallel, but only the orchestrator may mutate board state or authorize
   implementation.
7. **Do not mark work Done at reviewer approval.** The orchestrator executes the authorized merge
   only after required PR checks are green, then marks Done after the merged commit and required
   default-branch checks are confirmed.
8. **Remove the one-time “final PRD E2E/project complete” phase.** Evergreen work has no terminal
   project state. Whole-repository, release, migration, security, or manual checks are created only
   when a ticket or release requires them.

## 2. Why recalibration is needed

| Current behavior                                                                                                             | Post-MVP risk                                                                                 | Evergreen replacement                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| The former `project-orchestrator.md` treated the PRD as the product contract and told the orchestrator to decompose PRD §12. | The PRD describes v0.1.0 and can contradict intended improvements.                            | Investigate the current default branch and define the requested delta from owner intent.                                                   |
| `coder` and `code-reviewer` require PRD fidelity and enforce MVP boundaries.                                                 | Valid maintenance work can be blocked as “out of MVP.”                                        | Enforce the implementation ticket, current repository constraints, and explicit owner decisions.                                           |
| Existing ticket order and final E2E phase are fixed to the initial build.                                                    | The workflow cannot naturally process unrelated bugs, enhancements, maintenance, or releases. | Select Backlog intake by priority/readiness and repeat indefinitely.                                                                       |
| Backlog issues include boilerplate `Action items`.                                                                           | Repeated instructions can drift from the orchestrator prompt or conflict across tickets.      | Put the protocol in one canonical orchestrator prompt.                                                                                     |
| Reviewer approval moves a ticket directly to Done, while branches are not supposed to be merged without instruction.         | “Done” can mean approved but not integrated.                                                  | Approval plus green PR checks authorizes the orchestrator to merge; the merged commit plus required default-branch checks authorizes Done. |
| The prompt refers to a Blocked lane, but Project 1 currently has no Blocked status option.                                   | A blocked ticket has no deterministic board state.                                            | Add a Blocked status before rollout; use it as the only blocked lifecycle state.                                                           |
| `Ready` and `ready-for-agent` duplicate readiness.                                                                           | State can drift and accidentally dispatch incomplete work.                                    | Retain both initially as a dispatch invariant and add a reconciliation check.                                                              |
| Current docs, comments, and test names still contain PRD references.                                                         | Agents may treat incidental historical wording as a current requirement.                      | Rewrite them over time as behavior- or contract-specific references.                                                                       |

## 3. Source-of-truth policy

The rewritten prompts should use the following model rather than treating one historical document as
universally normative.

### 3.1 Hard constraints

These always apply unless the owner explicitly changes the repository policy in a dedicated ticket:

- `AGENTS.md` and any narrower repository instructions.
- `docs/Coding_Best_Practices.md`.
- Security, privacy, packaging, compatibility, and release constraints currently encoded in
  maintained repository files.
- The public contracts of supported Pi and Node versions.

If a ready ticket conflicts with a hard constraint, stop and escalate instead of choosing one
silently.

### 3.2 Current-state baseline

The current default branch is evidence of existing behavior:

- Production code under `src/`.
- Tests under `tests/`.
- `package.json`, CI, asset manifests, package inclusion rules, and configuration schemas.
- Maintained user and release documentation such as `README.md` and `docs/`.
- Git history when needed to understand why a behavior exists.

Tests and documentation describe current behavior; they are not immutable when a ticket
intentionally changes that behavior. An implementation ticket must identify which current tests or
docs are expected to change.

### 3.3 Change contract

For an active unit of work, the intended delta is defined by:

1. Recorded owner decisions linked from the ticket.
2. The ready implementation ticket's goal, scope, acceptance criteria, and manual/CI gates.
3. The orchestrator's repository findings and technical plan on that ticket.

The coder and reviewer must not silently expand or reinterpret this contract.

### 3.4 External authority

For Pi integration work, use the installed supported-version Pi documentation, types, and public
APIs. Inspect upstream source when the public API is unclear, but do not couple product code to a
private implementation without a ticketed compatibility decision.

### 3.5 Historical material

`_ignore/PRD/PRD_Audio_Feedback_Implementation_v3_FINAL_MVP.md` is historical v0.1.0 design context
only:

- Do not pass it as a mandatory input to subagents.
- Do not derive new acceptance criteria from it.
- Do not reject a change because it differs from it.
- Consult it only when a ticket explicitly asks for historical rationale, and label any resulting
  observation as non-normative.

## 4. Ownership model

### 4.1 Who owns “Action items”?

**Recommendation: the orchestrator owns technical action items; the owner owns outcomes and
decisions.**

An owner should not need to know the module boundaries, implementation sequence, tests, or exact
shell commands before filing an issue. Requiring that information makes intake slower and can
prematurely prescribe the wrong solution. Conversely, the orchestrator must not decide product
behavior merely because it can infer an implementation.

| Role                 | Owns                                                                                                                                                                                                                                                                          | Must not own                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Owner                | User problem, desired outcome, priority, product constraints/non-goals, UX tradeoffs, acceptance intent, manual validation, approval of material scope changes.                                                                                                               | Repository decomposition or exact technical steps unless intentionally imposing a hard constraint. |
| Project orchestrator | Intake triage, reproduction and repository investigation, consolidated clarification questions, root-cause evidence, technical action items, ticket slicing, dependencies, readiness, board state, dispatch, retries, authorized PR merge execution, and completion evidence. | Product decisions not established by the owner or code implementation.                             |
| Coder                | Implementation of exactly one ready ticket, scoped tests/docs, local verification, branch/PR handoff, and disclosure of deviations or blockers.                                                                                                                               | Board state, requirement changes, peer assignment, merge, or unrelated refactors.                  |
| Code reviewer        | Independent diff review against the ticket and repository constraints, risk-based verification, precise findings, and approval/rejection.                                                                                                                                     | Product fixes, requirement invention, board movement, merge, or peer assignment.                   |

## 5. Reusable intake ticket template

Backlog tickets should be short enough for an owner to file consistently. Replace
`Things to consider` with non-normative hypotheses and remove `Action items` entirely.

```markdown
## User problem

As a <user/context>, I experience <problem and impact>.

## Desired outcome

Describe the observable result, not the implementation.

## Reproduction or evidence

1. ...
2. ...

Include screenshots, logs, frequency, or examples when available.

## Context

- Priority: P0 / P1 / P2 (defaults to P2 when omitted)
- Version/commit:
- Platform/environment:
- Frequency:

## Constraints or non-goals (optional)

- ...

## Hypotheses (optional, non-normative)

- Possible causes or implementation ideas for investigation; these are not requirements.
```

### Intake rules

- Status is **Backlog**.
- It does not receive `ready-for-agent`.
- Apply the workflow-kind label `investigation` plus a classification label such as `bug`,
  `enhancement`, or `documentation`.
- The owner sets Project Priority when known. Missing Priority defaults to P2; within the same
  priority, the orchestrator selects the oldest unblocked item first.
- Missing technical analysis, acceptance criteria, file scope, or verify commands does not make
  intake invalid; producing those is the orchestrator's job.
- A hypothesis, PRD link, code pointer, or proposed solution is evidence to investigate, not a
  requirement.
- The orchestrator asks questions only when an answer changes observable behavior, scope,
  compatibility, or acceptance. Ask one consolidated set of questions rather than a comment per
  uncertainty.

## 6. Investigation protocol

For each selected Backlog ticket, the orchestrator performs these steps before creating
implementation work.

1. **Validate and claim control state**
   - Confirm `gh` authentication, project access, default branch, clean local state, and board
     schema.
   - Confirm there is no other active code-changing ticket.
   - Move the selected `investigation` ticket from Backlog to In progress before analysis so active
     intake is distinguishable from untouched intake.
2. **Check overlap before analysis**
   - Search open issues, project items, PRs, branches, and recent history for duplicates or
     overlapping work.
   - Record dependencies and shared modules. Do not create competing implementation tickets for the
     same invariant.
3. **Reproduce or establish evidence**
   - Follow the ticket's reproduction steps where safe.
   - If reproduction is unavailable, inspect deterministic tests, code paths, logs supplied by the
     owner, and platform boundaries.
   - Distinguish observed facts from hypotheses.
4. **Read the affected repository surface**
   - Production modules, focused tests, public/configuration contracts, current docs, package/CI
     implications, and supported upstream APIs.
   - Capture file/symbol references and the current behavior that must remain or change.
5. **Identify decisions versus technical questions**
   - Resolve technical questions from the repository when possible.
   - Ask the owner only about product tradeoffs, user-visible expectations, non-goals, compatibility
     changes, destructive behavior, or manual acceptance that cannot be inferred safely.
6. **Post an investigation summary**
   - Current behavior and reproduction evidence.
   - Likely cause or bounded unknowns.
   - Affected modules/contracts and regression risks.
   - Recommended disposition and owner questions, if any.
7. **Choose exactly one disposition**
   - `implementation-ready`: create one or more implementation tickets.
   - `needs-owner`: move to Blocked and ask the consolidated questions.
   - `duplicate`: link the canonical issue and close/complete the intake.
   - `no-change`/`cannot-reproduce`: record evidence and close/complete, unless the owner requests
     more investigation.
   - `research-spike`: create a linked ticket labeled `research`, owned by the orchestrator, with a
     bounded question, evidence requirements, and no product-code changes. Move the source intake to
     Blocked with `waiting for #<research>` as its unblock condition. The research ticket uses
     Backlog → In progress → Done/Blocked, requires no coder branch or code review, and feeds its
     findings back into the source intake.
8. **Close the intake loop**
   - When implementation tickets are created, comment with links, move the intake to Project Done,
     and close the GitHub issue because its investigation is complete.
   - Delivery is tracked only on the implementation tickets. This prevents the intake and
     implementation issue from representing the same active work.
   - Duplicate, no-change, and cannot-reproduce dispositions also end with both Project Done and a
     closed GitHub issue after the rationale is recorded.

The orchestrator may delegate bounded read-only scouting, reproduction analysis, or upstream API
research. It remains responsible for the research ticket and final synthesis and is the only role
allowed to mutate the board or create the implementation contract.

## 7. Reusable implementation ticket template

The implementation issue remains more detailed than intake because it is an executable contract.

````markdown
## Goal

One observable implementation outcome.

## Origin and owner decisions

- Origin: #<intake>
- Owner decisions: <links to comments or `none required`>

## Current behavior and evidence

- Relevant files/symbols/tests:
- Reproduction or baseline:

## Scope

**In scope**

- ...

**Out of scope**

- ...

## Dependencies and conflicts

- Depends on: #<issue> or `none`
- Overlap checked against: <issues/PRs/branches>

## Technical plan

1. ...
2. ...

## Acceptance criteria

- [ ] Observable, deterministic criterion.
- [ ] Regression and compatibility criterion.
- [ ] Tests and maintained documentation reflect the intended behavior.

## Verification

### Coder-local required

```bash
<exact commands>
```

### CI/integration required

- <checks the orchestrator must observe before merge>

### Human/owner gates

- <manual checks, or `none`>

## Handoff

- Base branch and expected base commit:
- Branch: `agent/<issue-number>-<short-slug>`
- PR title: `<issue-number>: <ticket title>`
- Commit and structured-return requirements.
````

### Readiness gate

The orchestrator may set **Ready** plus `ready-for-agent` only when all are true:

- The user-visible goal and current-to-desired behavior delta are unambiguous.
- Required owner decisions are linked.
- Scope and non-goals are explicit.
- Dependencies and overlaps have been checked.
- Acceptance criteria are deterministic or explicitly assigned to a human/CI gate.
- Exact local verification commands are valid for the changed surface.
- CI-only, platform-only, release-only, and human-only checks are separated.
- The branch/base and review target are stated.
- The ticket is small enough for one implementation/review cycle; otherwise it is split into
  dependency-ordered tickets.

## 8. Evergreen board state machine

### 8.1 Board prerequisite

Add a **Blocked** option to the Project `Status` field before enabling the new prompt. The
repository already has a `blocked` label, but a lifecycle status is clearer than overloading
Backlog. Use `blocked` as a filter/reason marker only if desired; the Status field remains
authoritative.

Add workflow-kind labels `investigation`, `implementation`, and `research`. These are orthogonal to
classification labels such as `bug` and `enhancement` and let reconciliation apply the correct state
rules. Require exactly one workflow-kind label for open/new evergreen work; historical Done issues
are exempt unless reopened.

### 8.2 Transitions

| Event                                                       | Required action                                                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner files investigation                                   | Label `investigation`; Backlog; no `ready-for-agent`.                                                                                                |
| Orchestrator claims investigation                           | In progress; post/record that investigation began.                                                                                                   |
| Investigation needs product decision                        | Blocked; add `blocked`; record one consolidated question set and the unblock condition.                                                              |
| Owner supplies the blocking decision                        | Remove `blocked`; return the intake to In progress; resume the same investigation without a retry charge.                                            |
| Investigation yields implementation ticket(s)               | Label new work `implementation`; link tickets; move the intake to Done and close it.                                                                 |
| Research is required                                        | Create a linked `research` ticket; move the source intake to Blocked with `waiting for #<research>`; move the research ticket Backlog → In progress. |
| Research cannot proceed                                     | Move the research ticket to Blocked and update the blocked source intake with the same explicit external unblock condition.                          |
| Research completes                                          | Move/close the research ticket as Done; remove `blocked` from the source intake and return it to In progress for disposition.                        |
| Implementation ticket passes readiness gate                 | Ready + `ready-for-agent`.                                                                                                                           |
| Orchestrator dispatches coder                               | In progress; remove `ready-for-agent`; record branch and attempt.                                                                                    |
| Coder returns `blocked`                                     | Blocked; add `blocked`; preserve issue, branch, verify evidence, and attempt count.                                                                  |
| Coder blocker resolves                                      | Remove `blocked`; return to In progress; resume or spawn a coder on the same issue/branch without consuming a rejection attempt.                     |
| Coder returns a reviewable commit and all local checks pass | In review; dispatch a fresh reviewer.                                                                                                                |
| Reviewer returns `blocked`                                  | Blocked; add `blocked`; preserve the review target and record the missing input. Do not consume a rejection attempt.                                 |
| Reviewer blocker resolves                                   | Remove `blocked`; return to In review; dispatch a fresh reviewer against the same target.                                                            |
| Reviewer rejects                                            | Post findings; move to In progress; reassign the same issue and branch; consume one rejection attempt.                                               |
| Reviewer approves and required PR checks are green          | Keep In review; the orchestrator executes the approved merge.                                                                                        |
| Merge requires unavailable human permission                 | Blocked; record `owner` as unblocker and the exact approved PR/commit.                                                                               |
| Merged commit and required default-branch checks are green  | Move to Done, close the implementation issue, and comment with merge/check evidence.                                                                 |

### 8.3 Dispatch invariants

- `Status = Ready` if and only if `ready-for-agent` is present during the initial rollout.
- No ticket with `blocked` may be dispatched, merged, or closed as successful.
- At most one `implementation` ticket may be In progress or In review.
- At most one orchestrator-owned `investigation` or `research` ticket is actively analyzed at a
  time; read-only analysis may coexist with the one active implementation.
- A retry uses the same issue and branch; never create a competing fix branch for a review
  rejection.
- The orchestrator checks board drift and repairs or escalates before selecting work.
- Future parallel coding should require isolated worktrees plus an explicit file/contract overlap
  analysis; it is out of scope for the first evergreen revision.

## 9. Orchestrator prompt rewrite

`.pi/agents/project-orchestrator.md` implements the following sections.

1. **Mission and authority**
   - Sole control plane for intake, board state, dispatch, retries, integration, and completion.
   - No product implementation.
2. **Source-of-truth model**
   - Use Section 3 of this plan.
   - Explicitly exclude the PRD as a mandatory or normative source.
3. **Startup reconciliation**
   - Validate GitHub access, project field/label IDs, default branch, active work count, dirty
     state, and Ready-label invariant.
4. **Backlog investigation loop**
   - Use Section 6 and the disposition model.
5. **Implementation-ticket authoring and readiness**
   - Use Section 7; create dependency-ordered vertical behavior slices rather than the old fixed
     horizontal MVP layers.
6. **Dispatch and structured handoffs**
   - Pass the ready ticket, owner-decision links, exact base, repository instructions, current
     relevant files/tests, rejection history, and verification tiers.
7. **Review, retry, and scope-change control**
   - A rejection fixes the same contract on the same branch.
   - A material requirement/scope change stops work and returns to orchestration; never edit
     acceptance intent silently during implementation.
8. **Merge and completion**
   - Approval is necessary but not sufficient for Done.
   - The orchestrator waits for required pre-merge PR checks, executes the approved merge when
     authorized, then verifies required default-branch checks before closing/moving Done.
   - If the orchestrator lacks merge permission, it blocks and assigns the explicit merge action to
     the owner.
9. **Blocking and escalation**
   - Record a concrete unblock condition, responsible party, prior state, and resume state.
   - Blocked work never consumes a review-rejection attempt; resume rules depend on workflow kind as
     defined in Section 8.2.
10. **Continuous operation**
    - Return to Backlog/Ready selection after each completion; never declare the repository
      “complete.”

### Remove from the current orchestrator prompt

- PRD source precedence and PRD section references in worker inputs.
- “Break PRD §12 into tickets.”
- Fixed MVP implementation order.
- Blanket horizontal-slice rule.
- Mandatory final PRD §11 E2E ticket and “project work is complete.”
- PRD contradiction as an escalation category.
- Hard-coded historical examples such as Space-preview placement.

### Preserve, with revisions

- Sole control-plane ownership.
- One active code-changing ticket.
- Structured coder/reviewer returns.
- Same-ticket/same-branch retries and bounded retry budget.
- Human-only checks, but only when the active ticket or release defines them.
- No Done without independent approval, merge, and required check evidence.

## 10. Coder prompt recalibration

Update `.pi/agents/coder.md` after the orchestrator contract is stable.

### Replace mandatory references

Use this order:

1. Ready implementation ticket and linked owner decisions.
2. `AGENTS.md` and applicable repository instructions.
3. Current relevant production code, tests, package/config contracts, and maintained docs.
4. `docs/Coding_Best_Practices.md`.
5. Supported upstream Pi documentation/types for integration work.

Remove all mandatory PRD and MVP references.

### Behavioral changes

- Read the current implementation and focused tests before editing.
- Treat ticket-listed test changes as valid when they encode an intentional behavior change; do not
  preserve a stale test merely because it existed first.
- Keep changes within scope and report any required scope expansion as blocked.
- Run every **coder-local** command. Do not report blocked merely because a ticket correctly assigns
  a platform, CI, or human check to another gate.
- Update affected maintained docs, tests, public types, package contents, or compatibility
  declarations when required by acceptance criteria.
- Record base commit, head commit, files touched, verify evidence, PR URL, deviations, and blockers.
- Never merge, move board state, or contact the reviewer.

### Revised return fields

Retain the current status model, adding:

- `baseCommit`
- `headCommit`
- `filesTouched`
- `deviations` (empty unless the implementation differs from the technical plan without changing
  scope)
- separate `verifyLocal` and `ciExpected` evidence

## 11. Code-reviewer prompt recalibration

Update `.pi/agents/code-reviewer.md` to review the intended delta rather than PRD fidelity.

### Review order

1. Ticket goal, acceptance criteria, owner decisions, scope, and explicit gates.
2. Diff from the exact base to the coder's head commit.
3. Current repository constraints and affected public/configuration/package behavior.
4. Regression risk, tests, documentation, security/privacy, resource cleanup, and compatibility
   appropriate to the changed surface.
5. Coder verification evidence plus independently rerun cheap, deterministic checks.

### Behavioral changes

- Remove PRD fidelity, MVP scope, and mandatory final-E2E rules.
- Confirm that changed or removed tests are justified by the ticket rather than weakened to hide a
  regression.
- Distinguish blocking findings from non-blocking suggestions.
- Include criterion, severity, and file/symbol evidence for each rejection.
- Expand the reviewer status union to `approved | rejected | blocked`. `blocked` requires a
  non-empty `blockers` list and is used only when the base, diff, ticket, environment, or owner
  decision is missing; do not invent a pass/fail answer.
- Approval authorizes integration but does not merge or move the ticket.
- Keep product files read-only. GitHub review comments are the only normal reviewer writes.

### Revised reviewer return contract

Keep the existing checklist and verification evidence, but require:

- `status`: `approved | rejected | blocked`
- `findings`: non-empty only when rejected
- `blockers`: non-empty only when blocked and includes the missing input plus who can resolve it
- `baseCommit` and `headCommit`: the exact reviewed range
- `verifyReRun`: commands and exit codes actually rerun by the reviewer

The orchestrator accepts approval only when `blockers` and blocking `findings` are empty and the
reviewed head still matches the PR head.

### End-of-ticket contract-consistency protocol

Before approval, the reviewer compares intended behavior and the exact diff against implementation,
tests, `README.md`/maintained docs, public and configuration contracts, package metadata/contents,
CI/compatibility, security/privacy constraints, and explicit human gates.

Resolve conflicts deterministically:

1. Implementation contradicts the ticket → reject and correct implementation.
2. Tests, docs, package metadata, or CI are stale after an intentional change → reject and update
   them in the same ticket/branch.
3. Repository sources conflict and intended behavior is ambiguous → return `blocked` for an owner
   decision.
4. Unrelated pre-existing drift → create a linked Backlog investigation only when it does not
   misrepresent the changed behavior, security, installation, compatibility, or acceptance;
   otherwise it remains blocking.

The coder reports every affected contract surface in `contractUpdates`; the reviewer reports the
same surfaces in `consistency`. After approval, the orchestrator confirms the reviewed head is still
the PR head, waits for required pre-merge checks, merges, and confirms required default-branch
checks before Done.

## 12. Verification selection protocol

The orchestrator derives exact commands from `package.json`, CI, and the changed surface rather than
copying a historical global checklist blindly.

| Changed surface                      | Typical required evidence                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript runtime behavior          | Focused tests, lint, format check, typecheck, then full `npm test` when practical.                                               |
| TUI/Pi API integration               | Focused Settings/extension tests, supported Pi docs/types review, compatibility check, and full quality gates.                   |
| Configuration or persistence         | Focused malformed/failure/concurrency/cleanup tests plus full tests.                                                             |
| Package metadata/runtime graph       | `npm pack --dry-run --json`, production-only install/load checks, privacy/runtime-boundary tests, audit when release-relevant.   |
| Assets/build pipeline                | `assets:verify`; byte reproduction only in its pinned CI environment unless the local environment exactly matches.               |
| CI/tooling                           | Relevant configuration validation and observed workflow run.                                                                     |
| Documentation only                   | Formatting and link/command validation appropriate to the edited docs; do not require unrelated expensive suites without reason. |
| Platform audibility or subjective UX | Explicit owner/human gate; agents report the gate as pending or recorded, never as self-verified.                                |

Each implementation ticket separates:

- **Coder-local required checks** — must pass before review.
- **Reviewer reruns** — selected independently based on risk.
- **CI/integration checks** — must be green before merge/Done.
- **Human/release gates** — assigned to a person and never claimed by an agent.

## 13. Retry, change-control, and conflict protocol

- Keep a maximum of three rejected implementation attempts unless the owner deliberately resets the
  ticket after changing its contract.
- A review rejection consumes an attempt. `blocked` from the coder or reviewer, an infrastructure
  outage, or a clearly documented missing owner decision does not.
- Every Blocked transition records `blockedBy`, `reason`, `priorStatus`, `resumeStatus`, and the
  exact unblock condition. On resolution, remove `blocked` and resume according to Section 8.2
  rather than creating another issue or branch.
- Retry on the same issue and branch with all prior findings and current base/head evidence.
- If a finding exposes an ambiguous or incorrect implementation contract, the orchestrator pauses
  coding, updates or supersedes the implementation ticket, and obtains owner confirmation when
  observable behavior changes.
- Do not edit acceptance criteria silently after coding begins. Add a dated change note and re-run
  readiness.
- Before every dispatch and merge, recheck open PRs, the default branch, dependencies, and affected
  files/contracts for overlap.
- Rebase or merge the current default branch only when it can be done without discarding unrelated
  work. Otherwise block and escalate with exact conflicts.

## 14. Prompt packaging and tool access

The canonical orchestrator persona is `.pi/agents/project-orchestrator.md` with supported
frontmatter and explicit subagent tool access. The root Pi session adopts it through the single
activation template `.pi/prompts/activate_project_orchestrator.md`. It is not spawned as a nested
subagent because it must remain at the root to dispatch coder/reviewer workers within the installed
subagent recursion limit.

The template instructs the root session to read and adopt the orchestrator and, on every applicable
worker subagent call, explicitly pass:

```json
{
  "agentScope": "both",
  "confirmProjectAgents": false
}
```

These are per-call options, not persistent extension configuration. The same requirement is encoded
inside the orchestrator dispatch protocol so worker discovery does not depend on remembering a
separate scope-activation prompt. A dry dispatch must still prove discovery and structured returns
before live ticket work.

## 15. Rollout sequence

### Phase 1 — establish governance

1. Add the Project `Blocked` status and workflow-kind labels `investigation`, `implementation`, and
   `research`.
2. Use `.pi/agents/project-orchestrator.md` as canonical and
   `.pi/prompts/activate_project_orchestrator.md` as the combined persona/scope activation template.
3. Move the historical specification to
   `_ignore/PRD/PRD_Audio_Feedback_Implementation_v3_FINAL_MVP.md`.
4. Maintain the reusable intake template at `.github/ISSUE_TEMPLATE/investigation.md`.

### Phase 2 — rewrite role prompts

1. Rewrite `.pi/agents/project-orchestrator.md` first.
2. Rewrite `.pi/agents/coder.md` to match its new inputs and return schema.
3. Rewrite `.pi/agents/code-reviewer.md` to match the new review and blocked semantics.
4. Verify all three prompts use the same statuses, retry count, branch rules, payload names, merge
   definition, and source-of-truth policy.

### Phase 3 — remove stale coupling

Create separate maintenance work to:

- Maintain `docs/RELEASE_ACCEPTANCE_BASELINE.md` as the current release evidence map rather than a
  historical PRD checklist.
- Replace PRD/MVP wording in production comments and test names with behavior-specific contract
  descriptions.
- Keep any genuinely current constraint in maintained docs/tests/code so its authority does not
  depend on the historical PRD.

This cleanup should not be mixed into the prompt rewrite unless needed to prevent immediate
ambiguity.

### Phase 4 — dry-run the new intake process

Use issues #22 and #23 as calibration cases without dispatching code prematurely.

- **Issue #22:** Treat its scheduler reference as a hypothesis. Inspect `src/settings.ts`,
  `src/scheduler.ts`, focused tests, cue durations, and process-launch behavior. Ask the owner to
  choose the rapid-input UX only if evidence leaves a product tradeoff—for example, overlap cues,
  interrupt the current cue, or prefer the latest cue. Convert the agreed behavior into a separate
  ready implementation ticket.
- **Issue #23:** Inspect the current `ctx.ui.custom(..., { overlay: true })` path and the supported
  Pi TUI public APIs/source. Ask the owner only if matching `/settings` requires a private API,
  copied upstream code, a fallback, or a minimum-Pi-version change. Record that compatibility
  decision before implementation.

For each dry run, verify that:

- No PRD statement is treated as controlling.
- Questions are consolidated and product-focused.
- Current code/test evidence is cited.
- Duplicate and overlap checks occur.
- The generated implementation ticket uses the new template and passes readiness.
- The source investigation ticket is closed/completed only after its disposition is recorded.

### Phase 5 — retrospective after the first merged ticket

After one full investigate → implement → review → merge cycle:

- Audit board/label drift.
- Compare worker payloads with the prompt schemas.
- Check whether any requirement was duplicated or changed silently.
- Check whether verification was excessive or insufficient for the change surface.
- Tighten the prompts once, then use the workflow as the evergreen baseline.

## 16. Recalibration definition of done

- [x] None of the three agent prompts uses the PRD or MVP boundary as an active authority.
- [x] Intake and implementation are separate ticket types with explicit lineage.
- [x] The owner/orchestrator split for outcomes versus technical action items is documented.
- [x] The Backlog template contains no repeated orchestrator workflow instructions.
- [x] Readiness, blocking, retry, review, merge, and Done transitions are aligned across all
      prompts.
- [x] Project 1 has an unambiguous Blocked state and deterministic resume transitions for intake,
      research, coding, and review.
- [x] Workflow-kind labels distinguish investigation, implementation, and research tickets.
- [x] A ticket cannot be Done before approved code is merged and required checks are green.
- [x] Verification distinguishes local, reviewer, CI, and human gates.
- [x] There is no mandatory final PRD review or “project complete” condition.
- [x] A read-only dry run on #22 and #23 produced clear, non-conflicting dispositions.
- [x] The combined template activates the orchestrator in the root session; dry project-agent
      invocations discovered coder/reviewer and returned the expected contracts with explicit
      project scope options.
