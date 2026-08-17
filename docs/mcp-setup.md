# MCP Server Setup

## Prerequisites

1. Mock console running: `npm run mock`
2. Capabilities discovered and saved in `capabilities/`
3. Node.js 20+

## Claude Desktop Configuration

Add to `~/AppData/Roaming/Claude/claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "computeruse-automation": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/path/to/computeruse-automation-system",
      "env": {
        "CONSOLE_USER": "operator",
        "CONSOLE_PASS": "demo123"
      }
    }
  }
}
```

## Demo Script (3 steps)

### Step 1: Approve a capability (the human step)

```bash
npm run cli -- approve lookup-dense-savings --version 2.0.0 --note "Demo approved"
```

### Step 2: Ask Claude to look up a balance

> "What is the savings balance for member 60020?"

Claude will call the `lookup-dense-savings` tool and return:
```
The savings balance for member 60020 is $10,426.23.
```

### Step 3: Ask Claude about a nonexistent member

> "What is the savings balance for member 99999?"

Claude will call the tool and report the business outcome:
```
Member 99999 was not found in the system.
```

## How It Works

- The MCP server reads `capabilities/*.json` on each `tools/list` request
- Only capabilities with `approved` status in `capabilities/trust.json` are exposed
- Sensitive inputs (username, password) come from env vars, never from Claude
- Each tool call runs the replay engine headless against the configured surface
- Results include: status, outputs (if success), outcome (if business outcome), journal path, duration
