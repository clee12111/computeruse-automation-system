# ComputerUse Automation System

An LLM figures out a legacy bank console **once**. What it learned is saved as a
typed, versioned **capability**. Agents then call it through **deterministic
replay** — no model in the loop, ~1 second. Humans approve what's callable.

> The model discovers. The artifact becomes a reusable capability.
> Deterministic replay is how the AI agent invokes it in production.

## Quick start

```bash
git clone <repo-url> && cd computeruse-automation-system
npm install && npx playwright install chromium
cp .env.example .env                    # fill OPENAI_API_KEY for discovery
npm run mock &                          # mock bank console on :3000
npm run seed                            # populate with real runs
npm run console &                       # operator console on :4000
```

Open http://localhost:4000 — runs, tools, and sites are ready.

- **:4000** — the **operator console**. Start here: ask, teach, approve, debug.
- **:3000** — the **mock bank console** (the target being automated). Two tenants, one product:
  - [localhost:3000/t/cascade-cu/login](http://localhost:3000/t/cascade-cu/login) — **Cascade Credit Union** (member/share vocabulary)
  - [localhost:3000/t/harborview/login](http://localhost:3000/t/harborview/login) — **Harborview Community Bank** (customer/account vocabulary)
- The OpenAI key is needed **only** for teaching new tools (discovery). Replay, seeding, and all tests run without it.
- Secrets live in `.env` only (gitignored) — never in artifacts or logs; journals show `•••`.

## The operator console

| Tab | What it does |
|---|---|
| **Ask** | Type a sentence → matched to an approved capability by keyword, shown before you click Run. **No model anywhere — not even the match.** |
| **Sites** | One card per app/tenant: tools, vocabulary overlay, error library, and **Teach a new tool** (goal + site). |
| **Runs** | Every execution — console or MCP — journaled identically. Margins, screenshots, recovery, failure debug reports. Paused discoveries are answered here: you act on the live session (`click 3`, `type 2 "60020"`), and skip/resume claims are verified against the live screen. |

Approve / revoke live on each tool's Trust tab — and only there.

## MCP (how agents call it)

```bash
npm run mcp:config     # prints the config block for Claude Desktop
```

Paste it in ([docs/mcp-setup.md](docs/mcp-setup.md)), restart, ask *"What's member 60020's savings balance?"*

- Approved capabilities = typed tools, plus two built-ins: `discover_capability`, `check_discovery`.
- Unapproved tool → `trust_blocked`. Approve/revoke are **never** MCP tools — agents propose, humans authorize.
- Discovery needs a human → the agent gets `needs-human` + the console URL. It relays; it cannot resolve.
- Client-agnostic, proven: `scripts/mcp-raw-client.mjs` (~95 lines, no SDK) — transcript in evidence.

## Demo

[docs/DEMO.md](docs/DEMO.md) — six queries, run verbatim: replay success, business outcome,
error history, teach a tool live, escalation (pauses before clicking Transfer), MCP.
Setup details: [docs/SETUP.md](docs/SETUP.md).

## Results

| Result | Meaning |
|---|---|
| `SUCCESS` | outputs extracted + validated (may include `recovered: true`) |
| `BUSINESS_OUTCOME` | a real answer, e.g. `MEMBER_NOT_FOUND` — not an error |
| `INVALID_INPUT` | rejected pre-flight, no browser opened |
| `HARD_FAILURE` | stopped loudly: step, expected vs observed, candidate scores |
| `ESCALATED` | a human's authority was required and used |

The rule, both layers: **escalate when the system works and a human must decide; fail loudly when it doesn't.** The seeded Runs page covers every row.

## How to read the repo

| Path | What |
|---|---|
| `src/discovery/` | the LLM loop: observe → decide → act, recorder, self-replay gate, risky-action escalation |
| `src/replay/` | the deterministic engine: resolve → act → verify, margin gate, error recovery |
| `src/surface/` | the perceive/act seam (accessibility tree) + weighted property scoring |
| `src/schema/` | the artifact and result contracts (Zod) — start here to understand the data |
| `src/guardrails/` | policy allowlist, trust store, vocabulary overlays, risky-verb list |
| `src/escalation/` | channel seam + verified handback |
| `src/mcp/` · `src/console-ui/` | the two entry points: agent-facing server, human-facing console |
| `mock-console/` | the target app — quarantined, zero imports to/from `src/` |
| `capabilities/` | the artifacts + `trust.json` (who approved what) |
| `errors/` · `config/` | per-app error libraries · surfaces + risky verbs |
| `evidence/` · `docs/` · `test/` · `scripts/` | proof · guides · tests · seed / bench / raw MCP client |

Suggested reading order: an artifact in `capabilities/` → `src/schema/artifact.ts` → `src/replay/engine.ts` → `src/discovery/agent.ts`.

## Tests & evidence

```bash
npm test                                          # 212 tests, offline, no key
docker build -t cuas . && docker run --rm cuas    # same suite, clean room
```

- Element identity validated on a **frozen benchmark set**: weighted scorer resolves **97%** standard / **95%** dense pages (vs 85% / 49% before).
- Portability proven: fresh clone in Docker with `--network none`, following SETUP.md literally.
- [evidence/README.md](evidence/README.md) — one folder per claim: discovery (compiled · gate-rejected · dead-end · escalated), replay across the full taxonomy, overlay proof, raw MCP transcript. Journals are real executions; reports are generated, never authored.
- [REPORT.md](REPORT.md) — design write-up: architecture, schema, determinism, escalation, safety, cuts.
