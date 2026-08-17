# Discovery Report — COMPILED

| Field | Value |
|-------|-------|
| Capability | **evidence-discovery** v1.0.0 |
| App | vendor-console |
| Goal | Look up member 12345 and read their savings balance |
| Trust | manual — not callable until approved |
| Timestamp | 2026-08-16T05:29:58.911Z |

## Cost
8 turns, 50,577 tokens (50,064 prompt / 513 completion), 25.9s wall clock, model: OpenAI

## What Was Learned (8 steps)

### Step 1: Navigate to /t/cascade-cu/search
- **Action:** Navigate to `/t/cascade-cu/search`
- **Target:** navigation in main frame
- **How identified:** Identified by role "navigation" and position only. Fragile: no semantic identifier — fragile.
- **Checkpoint:** the page must show the text 'Sign In'
- **Risk:** safe

### Step 2: Enter the provided <username> username
- **Action:** Type {username} into "Username"
- **Target:** textbox (HTML name: f1) near text [Username] in main frame
- **How identified:** Identified by HTML name "f1" + neighbor text [Username]. Robust: HTML name attr (stable across reflows); neighbor text context. Fragile: position (breaks on layout change).
- **Checkpoint:** the field must contain the typed value
- **Risk:** safe
- **Issues:**
  - Repeated action: type:

### Step 3: Enter the provided <username> password
- **Action:** Type {password} into "Password"
- **Target:** textbox (HTML name: f2) near text [Password] in main frame
- **How identified:** Identified by HTML name "f2" + neighbor text [Password]. Robust: HTML name attr (stable across reflows); neighbor text context. Fragile: position (breaks on layout change).
- **Checkpoint:** the field must contain the typed value
- **Risk:** safe

### Step 4: Submit the completed <username> sign-in form to access the console.
- **Action:** Click "Sign In"
- **Target:** button named "Sign In" in main frame
- **How identified:** Identified by accessible name "Sign In". Robust: accessible name (survives layout changes). Fragile: position (breaks on layout change).
- **Checkpoint:** the page must show the text 'Dashboard'
- **Risk:** safe

### Step 5: Open member search to look up member <memberId>
- **Action:** Click "Member Search"
- **Target:** link named "Member Search" in main frame
- **How identified:** Identified by accessible name "Member Search". Robust: accessible name (survives layout changes). Fragile: position (breaks on layout change).
- **Checkpoint:** the page must show the text 'Member Search'
- **Risk:** safe

### Step 6: Enter the exact member number to search for member <memberId>.
- **Action:** Type {memberId} into "Member"
- **Target:** textbox (HTML name: f1) near text [Member, Number] in main frame
- **How identified:** Identified by HTML name "f1" + neighbor text [Member, Number]. Robust: HTML name attr (stable across reflows); neighbor text context. Fragile: position (breaks on layout change).
- **Checkpoint:** the field must contain the typed value
- **Risk:** safe

### Step 7: Submit the member search for member <memberId>.
- **Action:** Click "Member Search"
- **Target:** button named "Member Search" in main frame
- **How identified:** Identified by accessible name "Member Search". Robust: accessible name (survives layout changes). Fragile: position (breaks on layout change).
- **Checkpoint:** the page must show the text 'Member Search'
- **Risk:** safe

### Step 8: Read the savings account balance for member <memberId>.
- **Action:** Read the value in the "Balance" column and save as `savingsBalance`
- **Target:** cell named "$4,320.10" in column "Balance" near text [00] in accounts frame
- **How identified:** Identified by accessible name "$4,320.10" + column header "Balance" + neighbor text [00]. Robust: accessible name (survives layout changes); column header (structural); neighbor text context; scoped to frame "accounts". Fragile: position (breaks on layout change).
- **Checkpoint:** output `savingsBalance` must have a value
- **Risk:** safe

## Review Checklist
Verify before approving:

- [ ] Repeated action warning: type:. The model struggled here — check if the step is correct.
- [ ] Step "s1" has no semantic identifier — relies on position only. Fragile.

## Exploration Summary
8 turns total, 7 productive, 1 with issues.

### Where the Model Struggled
- **Step 2** (Enter the provided <username> username): Repeated action: type:

<details>
<summary>Contract (inputs, outputs, outcomes)</summary>

### Inputs
| Name | Type | Pattern | Sensitive |
|------|------|---------|-----------|
| memberId | string | ^[0-9]{5}$ | no |
| username | string | — | yes |
| password | string | — | yes |

### Outputs
| Name | Type | Sensitive |
|------|------|-----------|
| savingsBalance | money | yes |

</details>

<details>
<summary>Full trace</summary>

| # | Step | Action | Checkpoint | Risk |
|---|------|--------|------------|------|
| 1 | s1 | Navigate to `/t/cascade-cu/search` | the page must show the text 'Sign In' | safe |
| 2 | s2 | Type {username} into "Username" | the field must contain the typed value | safe |
| 3 | s3 | Type {password} into "Password" | the field must contain the typed value | safe |
| 4 | s4 | Click "Sign In" | the page must show the text 'Dashboard' | safe |
| 5 | s5 | Click "Member Search" | the page must show the text 'Member Search' | safe |
| 6 | s6 | Type {memberId} into "Member" | the field must contain the typed value | safe |
| 7 | s7 | Click "Member Search" | the page must show the text 'Member Search' | safe |
| 8 | s8 | Read the value in the "Balance" column and save as `savingsBalance` | output `savingsBalance` must have a value | safe |

</details>

## Next Actions
- Review the script walkthrough and checklist above.
- Approve: `npm run cli -- approve evidence-discovery --version 1.0.0`
- Until approved, this capability cannot be called by agents.

---
_Generated by computeruse-automation-system. Deterministic — no LLM in report generation._