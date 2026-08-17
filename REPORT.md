# REPORT

## 1. Architecture

**An LLM discovers how to use a UI once; a deterministic engine replays what it learned with no model in the path.** Discovery is a tool factory. The artifact is the tool. An AI agent calling the tool through MCP is a customer of the tool — it may commission the factory (discovery is an MCP tool), but it can never authorize what the factory produces.

Three surfaces share one replay engine: an operator console (ask, teach, approve, debug), an MCP server (agents call capabilities as typed tools), and the CLI. All three journal identically.

The target is a deliberately hostile mock bank console — iframes, dense non-semantic tables, no test IDs, session expiry, two tenants with different vocabulary — quarantined from `src/` with zero shared imports.

- **Accessibility tree over DOM.** Works where there is no clean DOM; extends to desktop via OS accessibility APIs.
- **Single process, JSON files.** Reviewable with a text editor; no invented infrastructure.
- **Self-replay gate.** After discovery compiles an artifact, the system replays it with the same inputs before writing it to disk. This exists because discovery once compiled an artifact that read a page blob into a string field — it looked correct and did nothing. The gate then immediately caught a real compiler bug: credential placeholders were recorded literally instead of lifted to `$input` references, so the self-replay typed the placeholder into the login form and failed.

## 2. Artifact schema

**A capability artifact is a contract an agent can call, not a recording of what happened.** It carries semver version, typed inputs with patterns and a sensitive flag, typed outputs with parse rules, declared business outcomes with detection predicates, and ordered steps with human-readable intents.

**(a) Targets are property sets, not selectors.** Role, name, attribute, neighbor text, column header, frame, position, size — scored as a weighted whole so no single property is load-bearing. The first system was a fallback ladder of strategies; a frozen benchmark of hostile pages showed it collapsing on dense tables — label proximity matched every cell in a row, frame-blind geometry summed across iframes. The rewrite to whole-set scoring came from that eval, measured against fixed ground truth.

**(b) Every step asserts.** Business outcomes are checked first in compound expects. An early artifact matched "Member" inside "No member matches" — the success branch swallowed the business outcome. That is why outcome predicates precede success text and why generic checkpoints are avoided.

**(c) The contract is agent-facing.** MCP tool schemas generate from inputs and outputs. `humanAssisted` records whether a human contributed to the recording.

An early replay returned navigation chrome as a transfer confirmation. That false success is why string outputs require a validation pattern and why parse failure is a hard failure, not a returned string.

## 3. Determinism & error handling

**Nothing in the replay path consults a model.** The artifact fixes steps. Weighted scoring fixes resolution. Predicates fix success. Arbitration polls the expect on a tick until it holds or the step times out.

**The margin gate** refuses to guess. The winner must beat the runner-up by a margin; a tie fails with both candidates and their per-property breakdowns. A wrong click in a bank back-office is worse than a stop.

- `SUCCESS` — outputs extracted and validated; may include `recovered: true`.
- `BUSINESS_OUTCOME` — a real answer ("member not found"), returned as data.
- `HARD_FAILURE` — stopped at a named step with expected vs. observed and candidate scores.
- `INVALID_INPUT` — rejected before the browser launches.
- `ESCALATED` — a human's authority was required and used.

**Error recovery** is app-scoped and bounded: detect via predicate, run a fixed recovery route (re-login after session expiry), retry the step once. A second occurrence is a hard failure. Removing the error library turns the same fault into a hard failure — the counterfactual is part of the evidence. Error detection runs before element resolution each step, so a session-expiry redirect is recognized before the scorer tries to match controls on a page that no longer has them.

## 4. Heterogeneity & multi-tenant

**The Surface interface is the only seam between the system and the target application.** `observe()` returns elements with properties; `act()` takes a closed verb; `resolve()` scores a property set against the page. Everything above — replay, discovery, escalation — is surface-agnostic.

One artifact serves both tenants via a **vocabulary overlay** applied before resolution, mapping anchor text (Member Number ↔ Customer ID) and expect predicates. The artifact stays canonical; the overlay is the specialization. Per-step margins are recorded in every run and surfaced as drift signals — the report flags the thin-margin step that will break first if the site changes.

## 5. Escalation & handoff

**Escalate when the system is working and a human's authority is required; fail loudly when it is not working.** We initially conflated these — budget exhaustion triggered escalation, asking a human to push a stuck run through. That is wrong: being stuck is a diagnosis, not an authority question. Exhaustion now produces a dead-end with a diagnosis.

The risky-action gate fires before a click or select whose resolved target matches a configured verb list — deterministic, never the model's judgment. The intervention request carries the live page state: URL, text, numbered elements with risky ones flagged. The operator acts on the same live session through the same act primitives (`click <n>`, `type <n> "..."`), each journaled. The operator surface is text by design — the seam is control ownership, not pixel transport.

**Verified handback:** on resume, the system re-observes, diffs against the pre-handoff snapshot, and checks the step's expect. If the page has not changed, the claim is rejected with the reason shown. Accepted claims resume with `humanAssisted: true`. Unattended callers get a typed `needs-human` status with the console URL — the agent relays and cannot resolve.

## 6. Safety

- **Policy fence.** Origin and action allowlist at the Surface, beneath even the human's relayed actions.
- **Trust gate.** Nothing callable until a named human approves. Approve/revoke exist only in the console, never over MCP.
- **Risk handling.** Risky steps escalate attended, are refused unattended — always.
- **Data handling.** Credentials from env at act time, never in artifacts or journals. Sensitive values masked in every rendering.

Limits:

- Screenshots are not redacted. Designed fix: sensitivity-driven region masking.
- The risky-verb list is lexical. An innocuously named irreversible control would pass it; the trust gate is the backstop.
- The goal string reaches the model unmodified. Bounded by the policy fence and risky gate, not eliminated.

## 7. Cuts

- **Screenshot redaction.** Text operator surface works without them; region masking designed but not built.
- **Third-party sites.** Configured, deliberately removed — a public demo that resets is a flaky proof; the mock is harder.
- **Desktop surface.** Designed to the Surface seam; accessibility APIs map directly.
- **Remote operator transport.** Control-transfer model is real; pixel streaming is infrastructure on top.
- **Attended replay.** Nursing a broken replay rescues one run and leaves the tool broken; we chose re-discovery.
- **Margin trends.** Margins recorded per step per run; the trend alert is the next build.
- **Artifact canonicalization.** Routes relative, vocabulary overlaid; parameterized patterns next.

Next: screenshot redaction, margin trends, a second Surface implementation. The seam's real test is the second implementation.
