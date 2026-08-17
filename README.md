# Computer-Use Automation System

An LLM discovers how to operate a legacy UI once, records a typed capability
artifact, and a deterministic replay engine executes it in production — no
model in the loop, human approval required, business outcomes as data.

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

## Documentation

- **[docs/SETUP.md](docs/SETUP.md)** — full setup, every command verified
- **[evidence/README.md](evidence/README.md)** — curated evidence index
- **REPORT.md** — forthcoming

## Tests

```bash
npm test   # 212 tests, ~60s
```
