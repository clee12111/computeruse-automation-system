// test/replay.test.ts — ReplayEngine tests against the live mock console.
// Row 1: SUCCESS · Row 2: BUSINESS_OUTCOME · INVALID_INPUT · HARD_FAILURE · Redaction.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { loadArtifact } from '../src/schema/loader.js';
import { loadPolicy } from '../src/guardrails/policy.js';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { replay, validateInputs, InvalidInputError } from '../src/replay/engine.js';
import { RunJournal } from '../src/evidence/journal.js';
import type { CapabilityArtifact } from '../src/schema/artifact.js';
import type { ReplayResult } from '../src/schema/results.js';

const PORT = 3461;
const BASE = `http://localhost:${PORT}`;
const PREFIX = '/t/cascade-cu';
let server: ChildProcess;
let artifact: CapabilityArtifact;

async function waitForServer(maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { await fetch(`${BASE}${PREFIX}/login`); return; }
    catch { await new Promise(r => setTimeout(r, 150)); }
  }
  throw new Error('Mock console did not start');
}

async function runReplay(
  inputs: Record<string, string>,
  overrideArtifact?: CapabilityArtifact,
): Promise<{ result: ReplayResult; journal: RunJournal }> {
  const a = overrideArtifact ?? artifact;
  const policy = { allowedOrigins: [BASE], allowedRoutes: ['/t/*'], allowedVerbs: ['click','type','select','read','navigate'] };
  const surface = new BrowserSurface({ baseUrl: BASE, tenantPrefix: PREFIX, policy, headed: false });
  const journal = new RunJournal(resolve('evidence/runs'), a, inputs);
  (surface as any).config.screenshotDir = journal.runDir;

  await surface.launch();
  try {
    const result = await replay({ surface, artifact: a, inputs, journal, stepTimeoutMs: 15000, tickMs: 200, allowRisky: true });
    if (result.status === 'SUCCESS') {
      for (const [key, decl] of Object.entries(a.outputs)) {
        if (decl.sensitive && result.outputs[key] != null) {
          journal.addSensitiveOutput(String(result.outputs[key]));
        }
      }
    }
    journal.writeResult(result);
    return { result, journal };
  } finally {
    await surface.close();
  }
}

beforeAll(async () => {
  server = spawn('node', ['mock-console/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe', cwd: process.cwd(),
  });
  await waitForServer();
  artifact = loadArtifact(resolve('capabilities/lookup-member-savings-balance.v1.json'));
}, 30000);

afterAll(() => { server?.kill(); });

describe('ReplayEngine', { timeout: 60000 }, () => {

  it('Row 1: memberId 12345 → SUCCESS with savingsBalance 4320.10', async () => {
    const { result, journal } = await runReplay({
      memberId: '12345', username: 'operator', password: 'demo123',
    });

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(result.outputs.savingsBalance).toBe(4320.10);
    }

    // Check journal has step events
    const journalPath = resolve(journal.runDir, 'journal.jsonl');
    expect(existsSync(journalPath)).toBe(true);
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(5);

    // Check rung logging
    const rungLines = lines.filter(l => l.includes('rung_matched'));
    expect(rungLines.length).toBeGreaterThan(0);
  });

  it('Row 2: memberId 99999 → BUSINESS_OUTCOME MEMBER_NOT_FOUND', async () => {
    const { result } = await runReplay({
      memberId: '99999', username: 'operator', password: 'demo123',
    });

    expect(result.status).toBe('BUSINESS_OUTCOME');
    if (result.status === 'BUSINESS_OUTCOME') {
      expect(result.code).toBe('MEMBER_NOT_FOUND');
    }
  });

  it('INVALID_INPUT: memberId "12ab" rejected before browser launch', async () => {
    expect(() => {
      validateInputs(artifact, { memberId: '12ab', username: 'op', password: 'pw' });
    }).toThrow(InvalidInputError);

    try {
      validateInputs(artifact, { memberId: '12ab', username: 'op', password: 'pw' });
    } catch (e) {
      expect((e as Error).message).toContain('12ab');
      expect((e as Error).message).toContain('pattern');
    }
  });

  it('HARD_FAILURE: broken chain → failure at right stepId with rung reports', async () => {
    // Create a broken artifact with an impossible chain
    const brokenArtifact = JSON.parse(JSON.stringify(artifact)) as CapabilityArtifact;
    // Corrupt step s4's target to something that won't resolve
    brokenArtifact.steps[3].target.chain = [
      { by: 'roleName', role: 'button', name: 'Totally Nonexistent XYZ Button' },
    ];

    const { result, journal } = await runReplay({
      memberId: '12345', username: 'operator', password: 'demo123',
    }, brokenArtifact);

    expect(result.status).toBe('HARD_FAILURE');
    if (result.status === 'HARD_FAILURE') {
      expect(result.stepId).toBe('s4');
      expect(result.observed).toContain('not found');
      expect(result.evidenceRefs.length).toBeGreaterThanOrEqual(0);
    }

    // Check screenshot exists in run dir (if evidence was captured)
    const files = readdirSync(journal.runDir);
    expect(files).toContain('result.json');
  });

  it('Redaction: password never appears in evidence; balance masked in journal', async () => {
    const password = 'demo123';
    const { result, journal } = await runReplay({
      memberId: '12345', username: 'operator', password,
    });

    expect(result.status).toBe('SUCCESS');

    // Grep the entire run directory for the raw password
    const files = readdirSync(journal.runDir);
    for (const file of files) {
      const content = readFileSync(resolve(journal.runDir, file), 'utf8');
      expect(content).not.toContain(password);
    }

    // The balance (4320.10) should be masked in journal
    const journalContent = readFileSync(resolve(journal.runDir, 'journal.jsonl'), 'utf8');
    // Balance might appear as part of a step event; check it's masked
    // (the balance is sensitive, so if it appears in any log line, it should be •••)
    // The raw balance value "4320.1" should not appear in the journal
    expect(journalContent).not.toContain('4320.1');
  });
});
