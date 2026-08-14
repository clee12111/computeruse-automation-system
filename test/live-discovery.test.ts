// test/live-discovery.test.ts — Live LLM discovery test.
// SKIPPED unless RUN_LIVE=1 AND OPENAI_API_KEY are set.
// CI stays token-free. When enabled: live discovery + replay round trip.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { OpenAIClient, loadEnvFile } from '../src/discovery/openai-client.js';
import { discover, type DiscoveryContract } from '../src/discovery/agent.js';
import { RunJournal } from '../src/evidence/journal.js';
import { loadArtifact } from '../src/schema/loader.js';
import { replay } from '../src/replay/engine.js';
import type { Policy } from '../src/surface/surface.js';

// Load .env for API key check
loadEnvFile(resolve(process.cwd(), '.env'));

const SHOULD_RUN = process.env.RUN_LIVE === '1' && !!process.env.OPENAI_API_KEY;

const PORT = 3463;
const BASE = `http://localhost:${PORT}`;
const PREFIX = '/t/cascade-cu';
let server: ChildProcess;

const policy: Policy = {
  allowedOrigins: [BASE], allowedRoutes: ['/t/*'],
  allowedVerbs: ['click', 'type', 'select', 'read', 'navigate'],
};

async function waitForServer(maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { await fetch(`${BASE}${PREFIX}/login`); return; }
    catch { await new Promise(r => setTimeout(r, 150)); }
  }
  throw new Error('Mock console did not start');
}

describe.skipIf(!SHOULD_RUN)('Live LLM Discovery', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    server = spawn('node', ['mock-console/server.js'], {
      env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe', cwd: process.cwd(),
    });
    await waitForServer();
  }, 30000);

  afterAll(() => { server?.kill(); });

  it('live discovery → compiled artifact → replay SUCCESS', async () => {
    const contract: DiscoveryContract = {
      name: 'live-lookup-balance',
      goal: 'Log in to the operator console, look up member 12345, and read their savings account balance',
      app: 'cascade-cu-console',
      startPath: '/login',
      inputs: {
        memberId: { type: 'string', pattern: '^[0-9]{5}$', sensitive: false, exampleValue: '12345' },
        username: { type: 'string', sensitive: true, exampleValue: process.env.CONSOLE_USER || 'operator' },
        password: { type: 'string', sensitive: true, exampleValue: process.env.CONSOLE_PASS || 'demo123' },
      },
      outputs: { savingsBalance: { type: 'money', sensitive: true } },
    };

    const llmClient = new OpenAIClient({
      onUsage: (turn, u) => console.log(`  [turn ${turn}] ${u.totalTokens} tokens`),
    });

    const surface = new BrowserSurface({ baseUrl: BASE, tenantPrefix: PREFIX, policy, headed: false });
    const tempArtifact = {
      name: contract.name, version: '0.0.0', app: { id: contract.app, startPath: contract.startPath },
      inputs: Object.fromEntries(Object.entries(contract.inputs).map(([k, v]) => [k, { type: v.type, pattern: v.pattern, sensitive: v.sensitive }])),
      outputs: Object.fromEntries(Object.entries(contract.outputs).map(([k, v]) => [k, { type: v.type as any, sensitive: v.sensitive }])),
      businessOutcomes: {}, steps: [{ id: 's0', intent: '', action: { verb: 'navigate' as const }, target: { chain: [{ by: 'structural' as const, note: 'x' }], reasoning: '' }, risk: 'safe' as const, expect: { textPresent: '' } }],
    };
    const journalInputs = Object.fromEntries(Object.entries(contract.inputs).map(([k, v]) => [k, v.exampleValue]));
    const journal = new RunJournal(resolve('evidence/runs'), tempArtifact as any, journalInputs);
    (surface as any).config.screenshotDir = journal.runDir;

    await surface.launch();
    try {
      const result = await discover({ surface, llmClient, contract, journal, capabilitiesDir: resolve('capabilities') });
      console.log('Discovery result:', result.status, result.reason);
      console.log('Total tokens:', llmClient.getTotalUsage());
      expect(result.status).toBe('compiled');

      // Replay the compiled artifact
      const artifact = loadArtifact(result.artifactPath!);
      await surface.close();

      const surface2 = new BrowserSurface({ baseUrl: BASE, tenantPrefix: PREFIX, policy, headed: false });
      const replayJournal = new RunJournal(resolve('evidence/runs'), artifact, {
        memberId: '12345', username: process.env.CONSOLE_USER || 'operator', password: process.env.CONSOLE_PASS || 'demo123',
      });
      (surface2 as any).config.screenshotDir = replayJournal.runDir;
      await surface2.launch();
      try {
        const replayResult = await replay({
          surface: surface2, artifact,
          inputs: { memberId: '12345', username: process.env.CONSOLE_USER || 'operator', password: process.env.CONSOLE_PASS || 'demo123' },
          journal: replayJournal, stepTimeoutMs: 15000, tickMs: 200,
        });
        expect(replayResult.status).toBe('SUCCESS');
        if (replayResult.status === 'SUCCESS') {
          expect(replayResult.outputs.savingsBalance).toBe(4320.1);
        }
      } finally {
        await surface2.close();
      }
    } finally {
      try { await surface.close(); } catch {}
    }
  });
});
