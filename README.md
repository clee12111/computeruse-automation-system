# ComputerUse Automation System

An LLM figures out a legacy bank console **once**. What it learned is saved as a
typed, versioned **capability**. AI agents then call that capability through
**deterministic replay** — no model in the loop, ~1 second. Humans approve
what's callable.

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
- **:3000** — the **mock bank console** (the app being automated). Two banks, one product:
  - [localhost:3000/t/cascade-cu/login](http://localhost:3000/t/cascade-cu/login) — **Cascade Credit Union** (says "member")
  - [localhost:3000/t/harborview/login](http://localhost:3000/t/harborview/login) — **Harborview Community Bank** (says "customer")
- The OpenAI key is needed **only** for teaching new tools. Everything else — replay, seeding, tests — runs without it.
- Secrets live in `.env` only (gitignored). They never appear in saved files or logs — logs show `•••`.

## The operator console

| Tab | What it does |
|---|---|
| **Ask** | Type a sentence → it's matched to an approved tool and shown to you before you click Run. **After Run, no AI is involved at any point.** |
| **Sites** | One card per bank: its tools in plain language, and **Teach a new tool** (a goal + a site, that's it). |
| **Runs** | Everything that ever ran, however it was started. Open any run to see step by step what happened, screenshots, and — on failure — exactly which step broke and why. If a run is paused waiting for a person, this is where you take over: you drive the same live browser session (`click 3`, `type 2 "60020"`), and when you hand back, the system checks the screen to confirm you did what you claimed. |

Approving and revoking tools happens on each tool's Trust tab — and only there.

## MCP server — how an AI agent uses this

**The point of the MCP server: an AI agent (Claude Desktop, or any MCP client)
can call the replay loop to run an approved tool, and call the discovery loop
to propose a new one.** Ask for a balance, get an answer in a second — no
browser, no model reasoning about the UI.

```bash
npm run mcp:config     # prints the config block for Claude Desktop
```

Paste it in ([docs/mcp-setup.md](docs/mcp-setup.md)), restart, ask *"What's member 60020's savings balance?"*

The rules, enforced by the server:

- Every approved tool is callable, plus two built-ins that let the agent **propose** new tools: `discover_capability` and `check_discovery`.
- Calling an unapproved tool is refused. Approving one is impossible from an agent — that only happens in the console. Agents propose; humans authorize.
- If a discovery needs a person, the agent is told so and given the console link. It cannot answer for you.
- Credentials are never sent by the agent — the server reads them from its own environment.
- Works with any MCP client, proven: `scripts/mcp-raw-client.mjs` is a bare client with no SDK that connects and runs a tool. Transcript in evidence.

## What a run can end as

| Result | Meaning |
|---|---|
| `SUCCESS` | got the answer, checked against the expected format |
| `BUSINESS_OUTCOME` | a real answer like "no such member" — not an error |
| `INVALID_INPUT` | bad input, rejected before a browser even opens |
| `HARD_FAILURE` | stopped loudly: which step broke, what it expected, what it saw |
| `ESCALATED` | a person was needed and stepped in |

The one rule behind all of it: **if the system is working but a person must
decide, it stops and asks. If the system is broken, it stops and explains.**
It never guesses, and it never fails silently. The Runs page ships with a real
example of every result above.

## How to read the repo

| Path | What |
|---|---|
| `src/discovery/` | the LLM exploring the app and recording what it learns; a tool is only saved if the system can replay the recording itself and get the same answer |
| `src/replay/` | the engine that runs saved tools: find the element, act, verify — and refuse rather than guess when two elements look alike |
| `src/surface/` | how the system sees a page and clicks/types on it |
| `src/schema/` | the data shapes: what a saved tool and a result look like — **start here** |
| `src/guardrails/` | what's allowed: the allowlist, the approval store, per-bank word mappings |
| `src/escalation/` | pausing for a human, and checking their work before resuming |
| `src/mcp/` · `src/console-ui/` | the two front doors: one for agents, one for people |
| `mock-console/` | the fake bank being automated — fully separate from the system's code |
| `capabilities/` | the saved tools + who approved what |
| `evidence/` · `docs/` · `test/` · `scripts/` | proof · guides · tests · helper scripts |

Suggested reading order: a saved tool in `capabilities/` → `src/schema/artifact.ts` → `src/replay/engine.ts` → `src/discovery/agent.ts`.

## Tests & evidence

```bash
npm test                                          # full suite, offline, no key
docker build -t cuas . && docker run --rm cuas    # same suite, in a clean container
```

- Element-finding is validated against a frozen set of captured hard pages, so improvements measure against fixed ground truth: **97%** on standard pages, **95%** on the hardest dense-table pages (up from 85% / 49% before the rewrite).
- Portability proven: fresh clone inside Docker with **no network**, following [docs/SETUP.md](docs/SETUP.md) word for word.
- [evidence/README.md](evidence/README.md) — one folder per claim: real discovery runs (succeeded, rejected, dead-ended, escalated), real replays of every result type, the two-bank reuse proof, and the bare MCP client transcript. Every log is a real execution — none were written by hand.
- [REPORT.md](REPORT.md) — the design write-up: architecture, the saved-tool format, determinism, escalation, safety, and cuts.
