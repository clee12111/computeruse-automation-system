# Escalation Demo — Live Walkthrough Script

## Prerequisites
- Mock console running: `npm run mock`
- `.env` configured with `CONSOLE_USER=operator`, `CONSOLE_PASS=demo123`

## Scenario: Attended replay fails at ambiguous step, human resolves

### 1. Start the attended replay
```bash
npm run cli -- replay lookup-savings-balance-live \
  --tenant cascade-cu --memberId 23456 --attended --headed
```

### 2. The run proceeds through login, search, and member detail
- Steps s1-s7 execute normally (login → search → click)
- Member 23456 has two Savings accounts → s8 (read balance) fails on ambiguity

### 3. Escalation prompt appears
```
═══════════════════════════════════════════════════
  ESCALATION — Human intervention required
═══════════════════════════════════════════════════
  Capability: lookup-savings-balance-live v1.1.0
  Step:       s8 — Read the Balance cell for the Savings account row.
  Reason:     Target not resolved
  Expected:   {"outputPopulated":"savingsBalance"}
  Observed:   Target not resolved | Rung reports: rung 0 (tableCell): ambiguous (2 matches)
  Screenshot: evidence/runs/.../obs-0.png
─────────────────────────────────────────────────
  The browser is paused. You may interact with it now.
  (r)etry — re-run this step
  (s)kip  — skip (expect must pass on live screen)
  (a)bort — end run as ESCALATED
─────────────────────────────────────────────────
```

### 4. Human options

#### Option A: Retry (after fixing the situation in the browser)
- The human opens the browser window (headed mode)
- Navigates to the correct member or resolves the ambiguity
- Types `r` → the step re-runs from resolve

#### Option B: Skip (if the data is already visible)
- Types `s` → system checks the step's expect against the live screen
- If expect passes (e.g., the balance is already visible): step advances
- If expect fails: **claim REJECTED** — the system asks again

#### Option C: Abort
- Types `a` → optionally enters notes
- Run ends as ESCALATED with notes in evidence

### 5. Evidence produced
- `intervention-s8.json` — the structured request
- `journal.jsonl` — shows `control_transfer` human→machine transitions
- `result.json` — ESCALATED with resolution and notes

## Controller state invariant
Every journal line between `control→human` and `control→machine` has
`controller: 'human'`. Machine events never appear inside the human window.
