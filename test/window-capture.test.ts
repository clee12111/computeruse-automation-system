// test/window-capture.test.ts — Tests for human intervention window capture.

import './helpers/trust-sandbox.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { replay } from '../src/replay/engine.js';
import { RunJournal } from '../src/evidence/journal.js';
import { ScriptedChannel } from '../src/escalation/intervention.js';
import { saveTrust } from '../src/guardrails/trust.js';
import { loadArtifact } from '../src/schema/loader.js';
import { snapshotObservation, diffSnapshots } from '../src/escalation/window-capture.js';
import type { Policy, Observation, ElementInfo } from '../src/surface/surface.js';

const PORT = 3377;
const BASE = `http://localhost:${PORT}`;
const PREFIX = '/t/cascade-cu';
const policy: Policy = {
  allowedOrigins: [BASE], allowedRoutes: ['/t/*'],
  allowedVerbs: ['click', 'type', 'select', 'read', 'navigate'],
};

let server: ChildProcess;

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Server did not start');
}

beforeAll(async () => {
  server = spawn('node', ['mock-console/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe', cwd: process.cwd(),
  });
  await waitForServer();
}, 30000);

afterAll(() => { server?.kill(); saveTrust({}); });

describe('Window capture', { timeout: 60_000 }, () => {

  it('unit: diffSnapshots detects URL change', () => {
    const before = { url: 'http://localhost/login', elementCount: 20, frameElementCounts: { main: 20 }, headings: ['Sign In'], dialogTexts: [], formFieldNames: ['f1', 'f2'] };
    const after = { url: 'http://localhost/dashboard', elementCount: 40, frameElementCounts: { main: 40 }, headings: ['Dashboard', 'Welcome'], dialogTexts: [], formFieldNames: ['search'] };
    const diff = diffSnapshots(before, after);
    expect(diff.urlChanged).toBe(true);
    expect(diff.summary).toContain('navigated');
    expect(diff.newHeadings).toContain('Dashboard');
    expect(diff.elementsAppeared).toBe(20);
  });

  it('unit: diffSnapshots reports "no observable change" when nothing changed', () => {
    const snap = { url: 'http://localhost/page', elementCount: 30, frameElementCounts: { main: 30 }, headings: ['Title'], dialogTexts: [], formFieldNames: ['f1'] };
    const diff = diffSnapshots(snap, snap);
    expect(diff.summary).toBe('no observable change');
    expect(diff.urlChanged).toBe(false);
    expect(diff.elementsAppeared).toBe(0);
  });

  it('unit: snapshotObservation masks sensitive field names', () => {
    const obs: Observation = {
      url: 'http://localhost/login', title: 'Login',
      elements: [
        { ref: 'e0', role: 'textbox', name: '', frame: 'main', attrName: 'username' },
        { ref: 'e1', role: 'textbox', name: '', frame: 'main', attrName: 'password' },
        { ref: 'e2', role: 'textbox', name: '', frame: 'main', attrName: 'search' },
      ],
    };
    const snap = snapshotObservation(obs, ['password']);
    expect(snap.formFieldNames).toContain('username');
    expect(snap.formFieldNames).toContain('password [sensitive]');
    expect(snap.formFieldNames).toContain('search');
  });

  it('replay breakage: HARD_FAILURE immediately, no window capture (Phase 22)', async () => {
    // Phase 22: breakage (broken target) → HARD_FAILURE immediately.
    // No channel consultation, no window capture events.
    const artifact = JSON.parse(JSON.stringify(loadArtifact(resolve('capabilities/lookup-dense-savings.v1.json'))));
    artifact.steps[3].target.properties = { role: 'slider', frame: 'bogus-frame', name: 'zzz_impossible_match', attrName: 'zzz_no_exist' };

    const channel = new ScriptedChannel([{ kind: 'abort', notes: 'testing window capture' }]);
    const surface = new BrowserSurface({ baseUrl: BASE, tenantPrefix: PREFIX, policy, headed: false });
    const inputs = { memberId: '12345', username: 'operator', password: 'demo123' };
    const journal = new RunJournal(resolve('evidence/runs'), artifact, inputs);

    await surface.launch();
    try {
      const result = await replay({
        surface, artifact, inputs, journal,
        stepTimeoutMs: 5000, tickMs: 250,
        attended: true, channel,
      });

      // Breakage → HARD_FAILURE, channel never consulted
      expect(result.status).toBe('HARD_FAILURE');

      // No window capture events — breakage skips the channel entirely
      const jText = readFileSync(resolve(journal.runDir, 'journal.jsonl'), 'utf8');
      expect(jText).not.toContain('control_transfer');
      expect(jText).not.toContain('window_before');
    } finally {
      await surface.close();
    }
  });
});
