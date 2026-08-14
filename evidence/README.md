# Evidence Directory

Each subdirectory under `runs/` is a single execution (discovery or replay).

## Directory naming

`<ISO-timestamp>-<capability-name>/`

## Contents per run

| File | Purpose |
|---|---|
| `journal.jsonl` | One event per line: step starts, rung matches, conditions handled, expect results, outcomes detected. Sensitive values masked as `•••`. |
| `result.json` | Final result (SUCCESS/BUSINESS_OUTCOME/HARD_FAILURE/ESCALATED). Sensitive values masked. |
| `obs-*.png` | Screenshots captured during the run (on failure, or every observation during discovery). |
| `compiled-artifact.json` | (Discovery only) The artifact produced by the recorder/compiler. |

## Redaction rules

- Input values declared `sensitive: true` (e.g. username, password) are replaced with `•••` in ALL files.
- Output values declared `sensitive: true` (e.g. savingsBalance) are masked in journal and result.json; clear values appear ONLY in the programmatic return to the caller.
- The `controller` field on every journal line is `machine` (Phase 8 adds `human` for escalated sessions).

## Subdirectories

- `discovery-*` — Discovery runs (LLM-driven exploration)
- `replay-*` — Replay runs (deterministic artifact execution)

## Shipped artifact model

The artifact at `capabilities/lookup-savings-balance-live.v1.json` was produced by
**gpt-5.6-luna** via the Responses API (Phase 6.5). Zero manual edits.

### Attempt history

| # | Model | API | Turns | Tokens | Cost est. | Result |
|---|---|---|---|---|---|---|
| 1-3 | gpt-5.6-luna | Chat Completions | — | 0 | $0 | Error: function tools need Responses API |
| 4-5 | gpt-4o | Chat Completions | 10 | ~20K | ~$0.06 | Dead end: wrong cell targeted |
| 6 | gpt-4.1 | Chat Completions | 9 | 18K | ~$0.05 | Compiled but missing search-click step |
| 7 | gpt-4.1 | Chat Completions | 8 | 15K | ~$0.04 | Compiled, replay 5/5 (manual tableCell fix needed) |
| 8 | gpt-5.6-luna | Responses API | 8 | 24K (224 reasoning) | ~$0.10 | **Compiled, replay 5/5, zero edits** |
