#!/usr/bin/env node
// scripts/mcp-raw-client.mjs — Minimal MCP client using ONLY Node standard library.
// No MCP SDK, no Anthropic packages, no framework.
// Proves protocol-level client agnosticism.
//
// Usage:
//   npm run cli -- approve lookup-dense-savings --version 1.1.0
//   node scripts/mcp-raw-client.mjs
//
// Requires: CONSOLE_USER + CONSOLE_PASS in env or .env, mock console on :3000.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// ── JSON-RPC over stdio ────────────────────────────────────────

let nextId = 0;
let proc;
let rl;
const pending = new Map(); // id → { resolve, reject }

function send(method, params = {}) {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  proc.stdin.write(msg + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }
    }, 60000);
  });
}

function notify(method, params = {}) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  proc.stdin.write(msg + '\n');
}

function handleLine(line) {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`RPC error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }
  } catch { /* ignore non-JSON stderr leakage */ }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('=== MCP Raw Client (no SDK) ===\n');

  // Spawn the MCP server
  proc = spawn('npx', ['tsx', 'src/mcp/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  // Read stdout line by line
  rl = createInterface({ input: proc.stdout });
  rl.on('line', handleLine);

  // Swallow stderr (server logs)
  const stderrChunks = [];
  proc.stderr.on('data', d => stderrChunks.push(d.toString()));

  // Wait for server to be ready
  await new Promise(r => setTimeout(r, 3000));

  try {
    // 1. Initialize handshake
    console.log('1. INITIALIZE');
    const initResult = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'raw-client', version: '1.0.0' },
    });
    console.log(`   Server: ${initResult.serverInfo?.name} v${initResult.serverInfo?.version}`);
    console.log(`   Protocol: ${initResult.protocolVersion}`);

    // Send initialized notification
    notify('notifications/initialized');

    // 2. List tools
    console.log('\n2. TOOLS/LIST');
    const toolsResult = await send('tools/list', {});
    const tools = toolsResult.tools || [];
    console.log(`   ${tools.length} tools available:`);
    for (const t of tools) {
      console.log(`   - ${t.name}: ${t.description?.substring(0, 80)}`);
    }

    // 3. Call a capability tool
    const capTool = tools.find(t => t.name !== 'discover_capability' && t.name !== 'check_discovery');
    if (!capTool) {
      console.log('\n   No capability tools available. Approve one first:');
      console.log('   npm run cli -- approve lookup-dense-savings --version 1.1.0');
      process.exit(1);
    }

    console.log(`\n3. TOOLS/CALL → ${capTool.name}`);
    const callResult = await send('tools/call', {
      name: capTool.name,
      arguments: { memberId: '60020' },
    });

    const content = callResult.content?.[0];
    if (content?.type === 'text') {
      const envelope = JSON.parse(content.text);
      console.log(`   Result: ${envelope.result}`);
      if (envelope.outputs) console.log(`   Outputs: ${JSON.stringify(envelope.outputs)}`);
      if (envelope.summary) console.log(`   Summary: ${envelope.summary}`);
      console.log(`   Duration: ${envelope.durationMs}ms`);
      console.log(`   Report: ${envelope.reportPath || '(see journal)'}`);
    } else {
      console.log('   Unexpected response:', JSON.stringify(callResult));
    }

    console.log('\n=== PASS: All steps completed ===');
  } catch (e) {
    console.error(`\n=== FAIL: ${e.message} ===`);
    process.exit(1);
  } finally {
    proc.kill();
  }
}

main();
