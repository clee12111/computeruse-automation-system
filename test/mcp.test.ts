// test/mcp.test.ts — MCP server tests via SDK client over stdio.

import './helpers/trust-sandbox.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { approveCapability, saveTrust } from '../src/guardrails/trust.js';
import { loadArtifact } from '../src/schema/loader.js';

const PORT = 3311;
let mockServer: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Mock console did not start');
}

async function createMcpClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp/server.ts'],
    cwd: process.cwd(),
    env: { ...process.env, CONSOLE_USER: 'operator', CONSOLE_PASS: 'demo123', CONSOLE_URL: `http://localhost:${PORT}` } as Record<string, string>,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('MCP Server', { timeout: 120_000, sequential: true }, () => {
  beforeAll(async () => {
    mockServer = spawn('node', ['mock-console/server.js'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'pipe', cwd: process.cwd(),
    });
    await waitForServer();
  });

  afterAll(() => {
    mockServer?.kill();
    saveTrust({}); // clean up trust state
  });

  // Each MCP test manages its own trust state — save clean before, restore after

  it('catalog: unapproved capabilities NOT listed (only discovery tools)', async () => {
    saveTrust({});
    const client = await createMcpClient();
    try {
      const { tools } = await client.listTools();
      // Only the 2 discovery tools — no capability tools
      expect(tools.length).toBe(2);
      expect(tools.every((t: any) => t.name === 'discover_capability' || t.name === 'check_discovery')).toBe(true);
    } finally {
      await client.close();
      saveTrust({});
    }
  });

  it('catalog: approved capability IS listed with correct schema', async () => {
    saveTrust({});
    const capDir = resolve('capabilities');
    const files = readdirSync(capDir).filter(f => f.endsWith('.json') && f !== 'trust.json');
    let approvedName = '';
    for (const f of files) {
      try {
        const art = loadArtifact(resolve(capDir, f));
        approveCapability(art.name, art.version, 'test');
        approvedName = art.name;
        break;
      } catch { continue; }
    }
    expect(approvedName).not.toBe('');

    const client = await createMcpClient();
    try {
      const { tools } = await client.listTools();
      // 2 discovery tools + 1 approved capability
      expect(tools.length).toBe(3);
      const capTool = tools.find((t: any) => t.name === approvedName.replace(/[^a-zA-Z0-9_-]/g, '_'));
      expect(capTool).toBeDefined();
      expect(capTool!.inputSchema).toBeDefined();
    } finally {
      await client.close();
      saveTrust({});
    }
  });

  it('trust_blocked: calling unapproved capability returns error', async () => {
    saveTrust({});
    const client = await createMcpClient();
    try {
      const result = await client.callTool({ name: 'lookup-dense-savings', arguments: { memberId: '60020' } });
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content as any)[0].text);
      expect(body.error).toMatch(/trust_blocked|unknown_capability/);
    } finally {
      await client.close();
    }
  });

  it('end-to-end: lookup-dense-savings → SUCCESS with balance', async () => {
    saveTrust({});
    const art = loadArtifact(resolve('capabilities/lookup-dense-savings.v1.json'));
    approveCapability(art.name, art.version, 'e2e test');

    const client = await createMcpClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(1);

      const result = await client.callTool({ name: 'lookup-dense-savings', arguments: { memberId: '60020' } });
      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content as any)[0].text);

      console.log('E2E SUCCESS result:', JSON.stringify(body, null, 2));

      expect(body.result).toBe('SUCCESS');
      expect(body.outputs.savingsBalance).toBe(10426.23);
      expect(body.durationMs).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('end-to-end: nonexistent member → BUSINESS_OUTCOME MEMBER_NOT_FOUND', async () => {
    saveTrust({});
    const art = loadArtifact(resolve('capabilities/lookup-dense-savings.v1.json'));
    approveCapability(art.name, art.version, 'e2e test');

    const client = await createMcpClient();
    try {
      const result = await client.callTool({ name: 'lookup-dense-savings', arguments: { memberId: '99999' } });
      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content as any)[0].text);

      console.log('E2E nonexistent member result:', JSON.stringify(body, null, 2));

      expect(body.result).toBe('BUSINESS_OUTCOME');
      expect(body.outcome).toBe('MEMBER_NOT_FOUND');
      // Must complete well under the old 31s timeout
      expect(body.durationMs).toBeLessThan(15000);
    } finally {
      await client.close();
    }
  });

  it('BOUNDARY: no approve/revoke tools exposed via MCP — ever', async () => {
    saveTrust({});
    const art = loadArtifact(resolve('capabilities/lookup-dense-savings.v1.json'));
    approveCapability(art.name, art.version, 'test');
    const client = await createMcpClient();
    try {
      const { tools } = await client.listTools();
      const toolNames = tools.map((t: any) => t.name.toLowerCase());
      expect(toolNames).not.toContain('approve');
      expect(toolNames).not.toContain('revoke');
      expect(toolNames).not.toContain('approve_capability');
      expect(toolNames).not.toContain('revoke_capability');
      // Only: discover_capability, check_discovery, and approved capability tools
      for (const t of tools) {
        expect(['discover_capability', 'check_discovery', art.name.replace(/[^a-zA-Z0-9_-]/g, '_')]).toContain(t.name);
      }
    } finally {
      await client.close();
      saveTrust({});
    }
  });
});
