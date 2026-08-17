# Setup Guide

Step-by-step instructions for running the system from a fresh clone.
Every command in this document has been verified.

## Prerequisites

- **Node.js 20 or later** (tested with v24.14.1)
- **npm** (comes with Node)
- **Git**

## 1. Clone and install

```bash
git clone <repo-url>
cd computeruse-automation-system
npm install
npx playwright install chromium
```

## 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set the values:

| Variable | Required | What it is |
|----------|----------|-----------|
| `CONSOLE_USER` | Yes | Login username for the mock console. Default: `operator` |
| `CONSOLE_PASS` | Yes | Login password for the mock console. Default: `demo123` |
| `OPENAI_API_KEY` | For discovery only | Your OpenAI API key. Replay works without it. |
| `OPENAI_MODEL` | No | Model to use for discovery. Default: `gpt-5.6-luna` |

The CLI and MCP server load `.env` automatically. You do not need to export
variables manually.

## 3. Verify the setup

Start the mock console in one terminal:

```bash
npm run mock
```

In another terminal, run the preflight check:

```bash
npm run doctor
```

All checks should pass. If "Mock console reachable" fails, make sure
`npm run mock` is running.

## 4. Run the tests

```bash
npm test
```

npm test — full suite, offline, no key.

## 5. Replay a capability

Capabilities start unapproved. Approve one first:

```bash
npm run cli -- approve lookup-dense-savings --version 1.1.0
```

Then replay it:

```bash
npm run cli -- replay lookup-dense-savings --memberId 60020
```

Expected output: SUCCESS with `savingsBalance: 10426.23`.

Try a nonexistent member (business outcome, not an error):

```bash
npm run cli -- replay lookup-dense-savings --memberId 99999
```

Expected output: BUSINESS_OUTCOME — MEMBER_NOT_FOUND.

Try invalid input (pre-flight rejection, no browser launched):

```bash
npm run cli -- replay lookup-dense-savings --memberId ABC
```

Expected output: INVALID_INPUT — does not match pattern `^[0-9]{5}$`.

## 6. Revoke approval

```bash
npm run cli -- revoke lookup-dense-savings --version 1.1.0
```

## 7. Connect an MCP client

The system exposes capabilities as MCP tools over stdio.

**Claude Code** (project-scoped): The `.mcp.json` at the repo root
configures the server automatically. Start Claude Code from the project
directory. Set `CONSOLE_USER` and `CONSOLE_PASS` in your shell first:

```bash
# bash/zsh
export CONSOLE_USER=operator CONSOLE_PASS=demo123
claude

# PowerShell
$env:CONSOLE_USER="operator"; $env:CONSOLE_PASS="demo123"; claude
```

**Claude Desktop**: Run `npm run mcp-config` to generate the config block
for your OS, then paste it into your Claude Desktop config file.

**Raw MCP client** (no SDK): `node scripts/mcp-raw-client.mjs` performs the
full protocol handshake and calls a tool. See §E below.

## 8. Run a discovery

Discovery requires `OPENAI_API_KEY` in `.env`. It costs real tokens (~50K
per run, about $0.10–$0.30 depending on the model).

```bash
npm run cli -- discover --name my-lookup \
  --goal "look up a member's savings balance" \
  --app vendor-console --tenant cascade-cu --start /search \
  --input memberId=60020 --input-type "memberId:string:^[0-9]{5}$" \
  --output savingsBalance:money
```

Add `--headed` to watch the browser. Add `--attended` for human-assisted
mode (the browser opens and you can intervene when the agent gets stuck).

A compiled artifact goes through a **self-replay gate**: it is written to
`capabilities/` only if the replay engine can reproduce the outputs.

### Windows / Git Bash note

Git Bash converts POSIX-looking arguments to Windows paths. `--start /search`
becomes `--start C:/Program Files/Git/search`. Fix with either:

```bash
MSYS_NO_PATHCONV=1 npm run cli -- discover ... --start /search
# or use double-slash:
npm run cli -- discover ... --start //search
```

## 9. Operator console

```bash
npm run console
```

Opens at http://localhost:4000. Three screens:
- **Home** — ask a question, find a capability
- **Sites** — browse configured surfaces, teach new tools
- **Runs** — every execution with full step-by-step reports

## 10. Multi-tenant replay

The same capability artifact works across tenants. Pass `--tenant` to
target a different one:

```bash
npm run cli -- approve v2-harborview-savings --version 1.0.0
npm run cli -- replay v2-harborview-savings --memberId 60020 --tenant harborview
# => SUCCESS, balance: 10426.23
npm run cli -- revoke v2-harborview-savings --version 1.0.0
```

## Third-party surfaces

ParaBank and Altoro Mutual are configured in `config/mcp-surfaces.json` but
**not exercised in this deliverable**. They are wired for demonstration of
the multi-surface architecture, not for production use.

To enable them:

1. Set credentials in `.env`:
   ```
   PARABANK_USER=<your parabank username>
   PARABANK_PASS=<your parabank password>
   ALTORO_USER=<your altoro username>
   ALTORO_PASS=<your altoro password>
   ```
   - ParaBank: register at https://parabank.parasoft.com
   - Altoro Mutual: credentials are shown on the login page at http://demo.testfire.net

2. Run discovery against them:
   ```bash
   npm run cli -- discover --name pb-overview \
     --goal "view account overview" \
     --app parabank --tenant none --start /login.htm \
     --output totalBalance:money
   ```

**These surfaces are CONFIGURED BUT UNTESTED.** The artifacts in
`capabilities/v2-parabank-*.json` and `capabilities/v2-altoro-*.json` were
hand-crafted for schema demonstration and have not been replayed against
live sites. Do not assume they work.
