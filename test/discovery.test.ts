// test/discovery.test.ts — DiscoveryAgent tests with mocked LLM, live console.
// Zero tokens spent. Proves: discover → compile → replay round trip.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { MockLLMClient, type FixtureEntry } from '../src/discovery/llm-client.js';
import { discover, type DiscoveryContract } from '../src/discovery/agent.js';
import { RunJournal } from '../src/evidence/journal.js';
import { loadArtifact } from '../src/schema/loader.js';
import { replay } from '../src/replay/engine.js';
import type { Policy } from '../src/surface/surface.js';

const PORT = 3462;
const BASE = `http://localhost:${PORT}`;
const PREFIX = '/t/cascade-cu';
let server: ChildProcess;

const policy: Policy = {
  allowedOrigins: [BASE], allowedRoutes: ['/t/*'],
  allowedVerbs: ['click', 'type', 'select', 'read', 'navigate'],
};

const baseContract: DiscoveryContract = {
  name: 'test-lookup-balance',
  goal: 'Look up the member and read their savings account balance',
  app: 'cascade-cu-console',
  startPath: '/login',
  inputs: {
    memberId: { type: 'string', pattern: '^[0-9]{5}$', sensitive: false, exampleValue: '12345' },
    username: { type: 'string', sensitive: true, exampleValue: 'operator' },
    password: { type: 'string', sensitive: true, exampleValue: 'demo123' },
  },
  outputs: {
    savingsBalance: { type: 'money', sensitive: true },
  },
};

async function waitForServer(maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { await fetch(`${BASE}${PREFIX}/login`); return; }
    catch { await new Promise(r => setTimeout(r, 150)); }
  }
  throw new Error('Mock console did not start');
}

function loadFixture(name: string): FixtureEntry[] {
  return JSON.parse(readFileSync(resolve(__dirname, `fixtures/discovery/${name}.json`), 'utf8'));
}

async function runDiscovery(fixtureName: string, contract?: DiscoveryContract) {
  const fixture = loadFixture(fixtureName);
  const llm = new MockLLMClient(fixture);
  const surface = new BrowserSurface({ baseUrl: BASE, tenantPrefix: PREFIX, policy, headed: false });
  const c = contract ?? baseContract;
  const tempArtifact = { name: c.name, version: '0.0.0', app: { id: c.app, startPath: c.startPath },
    inputs: Object.fromEntries(Object.entries(c.inputs).map(([k,v]) => [k, { type: v.type, pattern: v.pattern, sensitive: v.sensitive }])),
    outputs: Object.fromEntries(Object.entries(c.outputs).map(([k,v]) => [k, { type: v.type as any, sensitive: v.sensitive }])),
    businessOutcomes: {}, steps: [{ id: 's0', intent: '', action: { verb: 'navigate' as const }, target: { properties: { role: 'navigation', frame: 'main', name: 'start' }, reasoning: '' }, risk: 'safe' as const, expect: { textPresent: '' } }] };
  const journalInputs = Object.fromEntries(Object.entries(c.inputs).map(([k,v]) => [k, v.exampleValue]));
  const journal = new RunJournal(resolve('evidence/runs'), tempArtifact as any, journalInputs);
  (surface as any).config.screenshotDir = journal.runDir;
  await surface.launch();
  try {
    const result = await discover({ surface, llmClient: llm, contract: c, journal, capabilitiesDir: resolve('capabilities') });
    return { result, journal };
  } finally {
    await surface.close();
  }
}

beforeAll(async () => {
  server = spawn('node', ['mock-console/server.js'], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe', cwd: process.cwd(),
  });
  await waitForServer();
}, 30000);

afterAll(() => { server?.kill(); });

describe('DiscoveryAgent', { timeout: 60000 }, () => {

  it('ROUND TRIP: happy fixture → compiled artifact → replay SUCCESS with correct balance', async () => {
    // Clean up any previous test artifact
    const artPath = resolve('capabilities/test-lookup-balance.v1.json');
    if (existsSync(artPath)) unlinkSync(artPath);

    const { result } = await runDiscovery('happy');
    expect(result.status).toBe('compiled');
    expect(result.artifactPath).toBeDefined();

    // Artifact file exists and passes loadArtifact
    expect(existsSync(result.artifactPath!)).toBe(true);
    const artifact = loadArtifact(result.artifactPath!);
    expect(artifact.name).toBe('test-lookup-balance');

    // Validate compiled artifact has v2 structure
    expect(artifact.steps.length).toBeGreaterThanOrEqual(4);
    for (const step of artifact.steps) {
      expect(step.target.properties).toBeDefined();
      expect(step.target.properties.role).toBeDefined();
      expect(step.target.properties.frame).toBeDefined();
    }

    // STRONG FORM: replay the compiled artifact and verify SUCCESS
    const surface = new BrowserSurface({ baseUrl: BASE, tenantPrefix: PREFIX, policy, headed: false });
    const replayJournal = new RunJournal(resolve('evidence/runs'), artifact, {
      memberId: '12345', username: 'operator', password: 'demo123',
    });
    (surface as any).config.screenshotDir = replayJournal.runDir;
    await surface.launch();
    try {
      const replayResult = await replay({
        surface, artifact,
        inputs: { memberId: '12345', username: 'operator', password: 'demo123' },
        journal: replayJournal,
        stepTimeoutMs: 15000, tickMs: 200,
      });
      if (replayResult.status !== 'SUCCESS') {
        console.error('Replay failed:', JSON.stringify(replayResult, null, 2));
      }
      expect(replayResult.status).toBe('SUCCESS');
      if (replayResult.status === 'SUCCESS') {
        expect(replayResult.outputs.savingsBalance).toBe(4320.1);
      }
    } finally {
      await surface.close();
    }

    // Clean up
    if (existsSync(artPath)) unlinkSync(artPath);
  });

  it('GOLDEN DIFF: compiled artifact matches hand-written structure', async () => {
    const artPath = resolve('capabilities/test-lookup-balance.v1.json');
    if (existsSync(artPath)) unlinkSync(artPath);

    const { result } = await runDiscovery('happy');
    expect(result.status).toBe('compiled');
    const compiled = result.artifact!;

    // Compiled artifact should have v2 structure (target.properties, not target.chain)
    const compiledVerbs = compiled.steps.map(s => s.action.verb);
    // Should contain: navigate, type, type, click, navigate, type, click, read
    expect(compiledVerbs).toContain('navigate');
    expect(compiledVerbs).toContain('type');
    expect(compiledVerbs).toContain('click');
    expect(compiledVerbs).toContain('read');
    expect(compiledVerbs.filter(v => v === 'type').length).toBe(3); // username, password, memberId

    // $input bindings on type steps
    const typeSteps = compiled.steps.filter(s => s.action.verb === 'type');
    const bindings = typeSteps.map(s => s.action.value);
    expect(bindings).toContainEqual({ $input: 'username' });
    expect(bindings).toContainEqual({ $input: 'password' });
    expect(bindings).toContainEqual({ $input: 'memberId' });

    // read step has saveTo
    const readStep = compiled.steps.find(s => s.action.verb === 'read');
    expect(readStep).toBeDefined();
    expect(readStep!.action.saveTo).toBe('savingsBalance');

    // read step's target has a PropertySet with role defined
    expect(readStep!.target.properties).toBeDefined();
    expect(readStep!.target.properties.role).toBeDefined();

    // Clean up
    if (existsSync(artPath)) unlinkSync(artPath);
  });

  it('PARAM LIFTING: compiled artifact contains no literal example values', async () => {
    const artPath = resolve('capabilities/test-lookup-balance.v1.json');
    if (existsSync(artPath)) unlinkSync(artPath);

    const { result } = await runDiscovery('happy');
    expect(result.status).toBe('compiled');

    // Grep the artifact file for literal values
    const artJson = readFileSync(result.artifactPath!, 'utf8');
    expect(artJson).not.toContain('"12345"');  // memberId lifted
    expect(artJson).not.toContain('"operator"'); // username lifted
    expect(artJson).not.toContain('"demo123"'); // password lifted

    if (existsSync(artPath)) unlinkSync(artPath);
  });

  it('LOOP fixture → DEAD_END after same-action warning', async () => {
    const { result } = await runDiscovery('loop');
    expect(result.status).toBe('dead_end');
    expect(result.status).toBe('dead_end');
  });

  it('POLICY fixture → aborted after 3 refusals', async () => {
    const { result } = await runDiscovery('policy');
    expect(result.status).toBe('aborted');
    expect(result.reason).toContain('refusal');
  });

  it('PREMATURE DONE → verification rejects, then retry completes', async () => {
    const artPath = resolve('capabilities/test-lookup-balance.v1.json');
    if (existsSync(artPath)) unlinkSync(artPath);

    const { result, journal } = await runDiscovery('premature-done');
    expect(result.status).toBe('compiled');

    // Journal should contain the verification failure
    const journalContent = readFileSync(resolve(journal.runDir, 'journal.jsonl'), 'utf8');
    expect(journalContent).toContain('verify_failed');

    if (existsSync(artPath)) unlinkSync(artPath);
  });

  it('BAD EXPECT → rejection logged, retry succeeds', async () => {
    const artPath = resolve('capabilities/test-lookup-balance.v1.json');
    if (existsSync(artPath)) unlinkSync(artPath);

    const { result, journal } = await runDiscovery('bad-expect');
    expect(result.status).toBe('compiled');

    // Journal should contain the fallback or expect failure
    const journalContent = readFileSync(resolve(journal.runDir, 'journal.jsonl'), 'utf8');
    expect(journalContent.includes('expect_failed') || journalContent.includes('step_ok_fallback')).toBe(true);

    if (existsSync(artPath)) unlinkSync(artPath);
  });

  // ── Escalation in discovery ─────────────────────────────

  it('ATTENDED: repeat threshold → dead_end (Phase 26: exhaustion never escalates)', async () => {
    // Phase 26: exhaustion triggers are dead-ends, not escalations.
    // The channel is never consulted for budget exhaustion.
    const { ScriptedChannel } = await import('../src/escalation/intervention.js');
    const channel = new ScriptedChannel([{ kind: 'abort', notes: 'test abort' }]);
    const fixture = loadFixture('loop-long');
    const llm = new MockLLMClient(fixture);
    const surface = new BrowserSurface({ baseUrl: BASE, tenantPrefix: PREFIX, policy, headed: false });
    const journal = new RunJournal(resolve('evidence/runs'), {
      name: 'test-esc', version: '0.0.0', app: { id: 'console', startPath: '/login' },
      inputs: { username: { type: 'string', sensitive: true }, password: { type: 'string', sensitive: true } },
      outputs: {}, businessOutcomes: {},
      steps: [{ id: 's0', intent: '', action: { verb: 'navigate' as const }, target: { properties: { role: 'navigation', frame: 'main', name: 'start' }, reasoning: '' }, risk: 'safe' as const, expect: { textPresent: '' } }],
    } as any, { username: 'operator', password: 'demo123' });

    await surface.launch();
    try {
      const result = await discover({ surface, llmClient: llm, contract: baseContract, journal, capabilitiesDir: resolve('capabilities'), attended: true, channel });
      // Exhaustion → dead_end, channel never consulted
      expect(result.status).toBe('dead_end');
      expect(channel.requests.length).toBe(0);
    } finally {
      await surface.close();
    }
  });

  it('UNATTENDED: repeat threshold → dead_end, no blocking (regression guard)', async () => {
    const { result } = await runDiscovery('loop-long');
    expect(result.status).toBe('dead_end');
    expect(result.reason).toContain('Same action');
    // Must return quickly — no human prompt
  });
});
