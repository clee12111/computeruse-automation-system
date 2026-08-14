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
