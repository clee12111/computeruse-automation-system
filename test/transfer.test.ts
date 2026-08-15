// test/transfer.test.ts — Transfer-funds capability + trust gate + side effects.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { replay } from '../src/replay/engine.js';
import { loadArtifact } from '../src/schema/loader.js';
import { RunJournal } from '../src/evidence/journal.js';
import { approveCapability, saveTrust } from '../src/guardrails/trust.js';
import type { CapabilityArtifact } from '../src/schema/artifact.js';
import type { Policy } from '../src/surface/surface.js';

const PORT = 3467;
const BASE = `http://localhost:${PORT}`;
const PREFIX = '/t/cascade-cu';
let server: ChildProcess;
let artifact: CapabilityArtifact;

const policy: Policy = {
  allowedOrigins: [BASE], allowedRoutes: ['/t/*'],
  allowedVerbs: ['click', 'type', 'select', 'read', 'navigate'],
};
const CREDS = { username: 'operator', password: 'demo123' };

async function waitForServer(maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { await fetch(`${BASE}${PREFIX}/login`); return; }
    catch { await new Promise(r => setTimeout(r, 150)); }
  }
  throw new Error('Mock console did not start');
}

async function runReplay(inputs: Record<string, string>, opts?: { attended?: boolean; channel?: any }) {
  const surface = new BrowserSurface({ baseUrl: BASE, tenantPrefix: PREFIX, policy, headed: false });
  const journal = new RunJournal(resolve('evidence/runs'), artifact, inputs);
  (surface as any).config.screenshotDir = journal.runDir;
  await surface.launch();
  try {
    const result = await replay({
      surface, artifact, inputs, journal,
      stepTimeoutMs: 15000, tickMs: 200,
      attended: opts?.attended, channel: opts?.channel,
    });
    journal.writeResult(result);
    return { result, journal, surface };
  } finally {
    await surface.close();
  }
}

beforeAll(async () => {
  server = spawn('node', ['mock-console/server.js'], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe', cwd: process.cwd(),
  });
  await waitForServer();
  artifact = loadArtifact(resolve('capabilities/transfer-funds.v1.json'));
}, 30000);

afterAll(() => { server?.kill(); });

beforeEach(() => {
  // Reset trust before each test
  saveTrust({});
});

describe('Transfer Funds — Trust Lifecycle', { timeout: 60000 }, () => {

  it('artifact has exactly one risky step (Execute Transfer, not password)', () => {
    const riskySteps = artifact.steps.filter(s => s.risk === 'risky');
    expect(riskySteps.length).toBe(1);
    expect(riskySteps[0].id).toBe('s13');
    expect(riskySteps[0].intent).toContain('Execute');
    // Password step is safe (sensitive ≠ risky)
    const pwStep = artifact.steps.find(s => s.intent.includes('password'));
    expect(pwStep?.risk).toBe('safe');
  });

  it('TRUST GATE: manual trust → stops AT risky step (balances unchanged)', async () => {
    // Trust is manual (default) — should stop before Execute Transfer
    const { result } = await runReplay({
      memberId: '12345', fromAccount: '12345-S1', toAccount: '12345-C1', amount: '50.00', ...CREDS,
    });

    expect(result.status).toBe('HARD_FAILURE');
    if (result.status === 'HARD_FAILURE') {
      expect(result.stepId).toBe('s13'); // stopped AT Execute Transfer
      expect(result.observed).toContain('not approved');
    }

    // Verify NO transfer occurred — check audit via HTTP
    const loginRes = await fetch(`${BASE}${PREFIX}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'f1=operator&f2=demo123', redirect: 'manual',
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
    const auditRes = await fetch(`${BASE}${PREFIX}/audit`, { headers: { cookie } });
    const auditBody = await auditRes.text();
    // No TRANSFER row should exist (only LOGIN from the replay + our check)
    expect(auditBody).not.toContain('TRANSFER');
  });

  it('APPROVE then replay → SUCCESS + side effects', async () => {
    // Approve the capability
    const entry = approveCapability('transfer-funds', '1.0.0', 'Test approval');
    expect(entry.status).toBe('approved');

    // Now replay — should proceed through the risky step
    const { result, journal } = await runReplay({
      memberId: '12345', fromAccount: '12345-S1', toAccount: '12345-C1', amount: '50.00', ...CREDS,
    });

    expect(result.status).toBe('SUCCESS');

    // Check journal has risky_step_executed event
    const journalContent = readFileSync(resolve(journal.runDir, 'journal.jsonl'), 'utf8');
    expect(journalContent).toContain('risky_step_executed');

    // Verify transfer side effects via HTTP
    const loginRes = await fetch(`${BASE}${PREFIX}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'f1=operator&f2=demo123', redirect: 'manual',
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
    const auditRes = await fetch(`${BASE}${PREFIX}/audit`, { headers: { cookie } });
    expect(await auditRes.text()).toContain('TRANSFER');
  });

  it('version bump resets trust', async () => {
    approveCapability('transfer-funds', '1.0.0', 'Approved');
    const { getTrustStatus } = await import('../src/guardrails/trust.js');
    expect(getTrustStatus('transfer-funds', '1.0.0').status).toBe('approved');
    // Different version → manual (not carried over)
    expect(getTrustStatus('transfer-funds', '1.1.0').status).toBe('manual');
  });

  it('REDACTION: credentials absent from transfer evidence', async () => {
    approveCapability('transfer-funds', '1.0.0');
    const { result, journal } = await runReplay({
      memberId: '12345', fromAccount: '12345-S1', toAccount: '12345-C1', amount: '5.00', ...CREDS,
    });

    if (result.status === 'SUCCESS') {
      const files = readdirSync(journal.runDir);
      for (const file of files) {
        const content = readFileSync(resolve(journal.runDir, file), 'utf8');
        expect(content).not.toContain('demo123');
      }
    }
  });
});
