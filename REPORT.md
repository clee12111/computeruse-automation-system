# REPORT

## 1. Architecture

**The LLM figures out a task once. Running the task never involves the LLM.**

- **Discovery** (LLM, runs once): explores the live bank console, records what worked, saves it as a capability.
- **Replay** (no LLM, runs every time): executes the saved capability — same steps, same checks, ~1 second, same result every time.
- Two entry points, one engine: an operator console for humans (ask, teach, approve, debug) and an MCP server for AI agents (run a tool, propose a new one). Both produce identical logs.
- The target is a mock bank console built to be hard: iframes, dense tables, no test IDs, session expiry, two banks with different vocabulary. It shares zero code with the system.
- **Key decision — the self-replay gate.** A capability is only saved if the system can re-run its own recording and reproduce the outputs. Why: discovery once produced "look-up-checking-balance" that looked valid and actually just read text off the search page — it never found a member. Only executing it revealed that. The gate then immediately caught a second real bug: logins were typing the literal placeholder `<sensitive:username>` instead of the credential. Reading the file could not catch either; running it caught both.

## 2. Artifact schema

**A capability is a contract: typed inputs, typed outputs, ordered steps, each step with a check.**

- Example contract: input `memberId` (5 digits) → output `savingsBalance` (money). Input "ABC" is rejected before a browser opens. Page text "No member matches" returns as the answer `MEMBER_NOT_FOUND`, not a crash.
- **Elements are identified by all their recorded properties scored together, not by one selector.** One property changing doesn't break the match. This was forced by testing: the original one-strategy-at-a-time approach matched every cell in a table row, or picked the word "Savings" over the actual number. The rewrite was measured against a locked set of captured hard pages.
- **Every step has a checkpoint, and failure checks run before success checks.** Why: an early capability confirmed success by finding the word "Member" — which also appears inside "No member matches," so failures read as successes.
- **Every output must match its declared format.** Why: an early replay returned the text "Log Out" as a transfer confirmation. Now a value that doesn't parse is a failure, not an answer.
- `humanAssisted: true` is stamped on any capability a human helped record, so the approver knows.

## 3. Determinism & error handling

**Nothing in replay consults a model. Same capability + same inputs = same behavior.**

- **Refuses ties.** If two elements score too close to tell apart, replay does not click either — it fails and reports both candidates. Clicking the wrong thing in a bank system is worse than stopping.
- **Waits by checking, not sleeping.** Each step re-checks its expected condition until it holds or the step times out. Slow pages succeed late; dead pages fail at a named step.
- **Five results, exactly one per run:** `SUCCESS` · `BUSINESS_OUTCOME` (a real answer like "member not found") · `INVALID_INPUT` (rejected pre-flight) · `HARD_FAILURE` (names the step, expected vs. observed) · `ESCALATED` (a human stepped in).
- **Known errors get one bounded recovery.** Session expires mid-run → re-login → retry that step once. A second occurrence is a failure. Removing the error definitions turns the same fault into a plain failure — that comparison is in the evidence.
- Error checks run before element matching on every step, so a session-expiry page is reported as "session expired," not "couldn't find the button."

## 4. Heterogeneity & multi-tenant

**The system touches the browser through one narrow interface: read the page, act on an element. Everything above it is surface-independent.**

- Pages are read via the accessibility tree — the same representation desktop apps expose. Supporting a desktop app means reimplementing the bottom layer only; saved capabilities and the engine don't change.
- **One capability, two banks, demonstrated.** Cascade CU says "Member Number"; Harborview says "Customer ID." A small per-bank word map is applied at run time. The capability itself never changes. Both runs are in the evidence.
- **Drift is visible before it breaks.** Every run records how confidently each element matched. Shrinking confidence flags the step that will fail first. The response is a word-map entry or an explicit re-teach — never a silent per-bank rebuild.

## 5. Escalation & handoff

**If the system works but a person must decide, it stops and asks. If the system is broken, it stops and explains. Never the reverse.**

- We got this wrong first: running out of steps used to page a human. A human staring at "ran out of steps" has nothing to decide — that's a debugging problem, and it now returns a failure with a diagnosis.
- **Escalation fires before an irreversible action.** Teaching "transfer $500 between accounts," the system fills the form, then stops before clicking Transfer. The trigger is a fixed word list (transfer, delete, pay, ...) matched against the button — never the model's own judgment.
- The pause shows: who is in control, the reason, and the live page as text with every element numbered.
- **The human drives the same live session** from the console — `click 3`, `type 2 "60020"` — every action logged.
- **Handback is verified.** Claim "done" without changing anything and the system re-reads the screen and rejects the claim, reason shown. Accepted handbacks resume the run; the capability is stamped `humanAssisted: true`.
- Agents never block on this. An MCP caller gets "a human is needed" plus the console link. Resolving it from an agent is not possible — retry/skip/approve are not MCP tools.

## 6. Safety

Four layers; each assumes the ones above it can fail.

- **Allowlist.** Only listed origins and action types, enforced at the lowest layer — below the LLM, and below a human's relayed clicks.
- **Approval.** No capability is callable by any agent until a named human approves it with a note. Agents cannot approve. Ever.
- **Risky actions.** Irreversible steps pause for a human when one is present, and are refused outright when unattended. An unattended run never clicks Transfer.
- **Data.** Credentials come from environment variables at the moment of typing — never in capabilities, logs, or the repo. Sensitive values render as `•••` everywhere. The mock bank's pages carry realistic fake SSNs and card numbers so the masking is exercised, not assumed.

Limits, stated plainly:

- Screenshots are not masked. Documented cut; fix designed.
- The risky-word list matches button names. An irreversible button with an innocent name would pass it — approval and the unattended refusal are the backstop.
- The goal text a user types reaches the LLM as-is. That is a prompt-injection surface — contained by the allowlist and the risky-action pause, not eliminated.

## 7. Cuts

- **Screenshot masking** — designed, not built. Text logs are fully masked.
- **Public bank-demo sites** — wired, then deliberately dropped: a public demo that resets under you proves nothing reliably, and the mock is harder than either candidate.
- **Desktop apps** — the bottom layer is designed for it; not implemented.
- **Remote takeover** — local takeover works today; streaming the session to a remote operator is described, not built.
- **Human-rescued replays** — rejected on purpose: pushing a broken run through fixes one run and leaves the capability broken. Broken capabilities get re-taught.
- **Drift alerts** — match-confidence is already recorded on every run; the alert on the trend is the next build.

Next, in order: screenshot masking, drift alerts, a desktop implementation of the bottom layer — the real test of the design.
