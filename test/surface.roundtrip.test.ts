// test/surface.roundtrip.test.ts — Surface roundtrip tests against the live mock.
// observe → find → describe → resolve → assert same element (roundtrip).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import type { Descriptor } from '../src/schema/artifact.js';
import type { ElementInfo, Policy } from '../src/surface/surface.js';

const PORT = 3460;
const BASE = `http://localhost:${PORT}`;
const PREFIX = '/t/cascade-cu';
let server: ChildProcess;
let surface: BrowserSurface;

const testPolicy: Policy = {
  allowedOrigins: [`http://localhost:${PORT}`],
  allowedRoutes: ['/t/*'],
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

async function loginViaPage(): Promise<void> {
  const page = (surface as any).page;
  await surface.navigate('/login');
  await page.waitForLoadState('load');
  await page.fill('input[name="f1"]', 'operator');
  await page.fill('input[name="f2"]', 'demo123');
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 5000 });
}

function findEl(obs: { elements: ElementInfo[] }, pred: (e: ElementInfo) => boolean): ElementInfo | undefined {
  return obs.elements.find(pred);
}

beforeAll(async () => {
  server = spawn('node', ['mock-console/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe', cwd: process.cwd(),
  });
  await waitForServer();
  surface = new BrowserSurface({ baseUrl: BASE, tenantPrefix: PREFIX, policy: testPolicy, headed: false });
  await surface.launch();
}, 30000);

afterAll(async () => {
  await surface?.close();
  server?.kill();
});

describe('Surface roundtrip', { timeout: 15000 }, () => {

  it('login Sign In button: roundtrip via roleName', async () => {
    await surface.navigate('/login');
    const obs = await surface.observe();
    const btn = findEl(obs, e => e.role === 'button' && e.name.includes('Sign In'));
    expect(btn).toBeDefined();

    const chain = await surface.describe(btn!.ref);
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0].by).toBe('roleName');

    const result = await surface.resolve(chain);
    expect(result.kind).toBe('match');
    if (result.kind === 'match') expect(result.rungIndex).toBe(0);
  });

  it('login username input: roundtrip (labelProximity or structural)', async () => {
    await surface.navigate('/login');
    const obs = await surface.observe();
    // The username input has nearbyText "Username" from the adjacent TD
    const input = findEl(obs, e => e.role === 'textbox' && !!(e.nearbyText?.includes('Username')));
    expect(input).toBeDefined();

    const chain = await surface.describe(input!.ref);
    expect(chain.length).toBeGreaterThan(0);
    // Should have either labelProximity or structural (both are valid for hostile UIs)
    const hasUsableRung = chain.some(d => d.by === 'labelProximity' || d.by === 'structural');
    expect(hasUsableRung).toBe(true);

    const result = await surface.resolve(chain);
    expect(result.kind).toBe('match');
  });

  it('search member-number input + button: roundtrip', async () => {
    await loginViaPage();
    await surface.navigate('/search');
    const page = (surface as any).page;
    await page.waitForLoadState('load');

    const obs = await surface.observe();

    // Member Number input
    const input = findEl(obs, e => e.role === 'textbox' && !!(e.nearbyText?.includes('Member')));
    expect(input).toBeDefined();
    const inputChain = await surface.describe(input!.ref);
    const inputResult = await surface.resolve(inputChain);
    expect(inputResult.kind).toBe('match');

    // Search button
    const btn = findEl(obs, e => e.role === 'button' && e.name.includes('Search'));
    expect(btn).toBeDefined();
    const btnChain = await surface.describe(btn!.ref);
    expect(btnChain[0]?.by).toBe('roleName');
    const btnResult = await surface.resolve(btnChain);
    expect(btnResult.kind).toBe('match');
    if (btnResult.kind === 'match') expect(btnResult.rungIndex).toBe(0);
  });

  it('accounts iframe: Savings balance resolves via tableCell', async () => {
    const page = (surface as any).page;
    // Navigate to member 12345 detail
    await surface.navigate('/search');
    await page.waitForLoadState('load');
    await page.fill('input[name="f1"]', '12345');
    await page.click('button[type="submit"]');
    await page.waitForURL(/member/, { timeout: 5000 });
    // Wait for iframe to load
    await page.waitForTimeout(500);
    for (const frame of page.frames()) {
      try { await frame.waitForLoadState('load', { timeout: 2000 }); } catch {}
    }

    const chain: Descriptor[] = [
      { by: 'tableCell', column: 'Balance', rowContains: 'Savings' },
    ];
    const result = await surface.resolve(chain);
    expect(result.kind).toBe('match');
  });

  it('member detail: Transfer Funds + Open Sub-Account links roundtrip', async () => {
    // Already on member 12345 detail from previous test
    const obs = await surface.observe();

    const tfLink = findEl(obs, e => e.role === 'link' && e.name.includes('Transfer Funds'));
    expect(tfLink).toBeDefined();
    const tfChain = await surface.describe(tfLink!.ref);
    const tfResult = await surface.resolve(tfChain);
    expect(tfResult.kind).toBe('match');

    const osLink = findEl(obs, e => e.role === 'link' && e.name.includes('Open Sub-Account'));
    expect(osLink).toBeDefined();
    const osChain = await surface.describe(osLink!.ref);
    const osResult = await surface.resolve(osChain);
    expect(osResult.kind).toBe('match');
  });

  it('transfer form: selects + amount input roundtrip', async () => {
    await surface.navigate('/member/12345/transfer');
    const page = (surface as any).page;
    await page.waitForLoadState('load');

    const obs = await surface.observe();
    // Amount input
    const amountInput = findEl(obs, e => e.role === 'textbox' && !!(e.nearbyText?.includes('Amount')));
    expect(amountInput).toBeDefined();
    const chain = await surface.describe(amountInput!.ref);
    const result = await surface.resolve(chain);
    expect(result.kind).toBe('match');

    // From/To selects
    const selects = obs.elements.filter(e => e.role === 'combobox');
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });

  it('teller code-word input: roundtrip', async () => {
    const page = (surface as any).page;
    // Activate drawer
    await surface.navigate('/teller/drawer');
    await page.waitForLoadState('load');
    await page.click('button[type="submit"]');
    await page.waitForURL(/teller\/line/, { timeout: 5000 });
    // Enter member
    await page.waitForLoadState('load');
    await page.fill('input[name="f1"]', '12345');
    await page.click('button[type="submit"]');
    await page.waitForURL(/verify/, { timeout: 5000 });
    await page.waitForLoadState('load');

    const obs = await surface.observe();
    const input = findEl(obs, e => e.role === 'textbox' && !!(e.nearbyText?.includes('Code')));
    expect(input).toBeDefined();

    const chain = await surface.describe(input!.ref);
    const result = await surface.resolve(chain);
    expect(result.kind).toBe('match');
  });

  // ── Ambiguity ───────────────────────────────────────────

  it('ambiguity: tableCell Savings on member 23456 (two Savings) returns ambiguous', async () => {
    const page = (surface as any).page;
    await surface.navigate('/search');
    await page.waitForLoadState('load');
    await page.fill('input[name="f1"]', '23456');
    await page.click('button[type="submit"]');
    await page.waitForURL(/member/, { timeout: 5000 });
    // Handle compliance interstitial
    await page.waitForLoadState('load');
    const content = await page.content();
    if (content.includes('Compliance Notice')) {
      await page.check('input[name="ack"]');
      await page.click('button[type="submit"]');
      await page.waitForURL(/member/, { timeout: 5000 });
    }
    // Wait for iframe
    await page.waitForTimeout(500);
    for (const frame of page.frames()) {
      try { await frame.waitForLoadState('load', { timeout: 2000 }); } catch {}
    }

    const chain: Descriptor[] = [
      { by: 'tableCell', column: 'Balance', rowContains: 'Savings' },
    ];
    const result = await surface.resolve(chain);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.rungReports[0].count).toBeGreaterThan(1);
    }
  });

  // ── NotFound ────────────────────────────────────────────

  it('notFound: descriptor for non-existent element returns notFound', async () => {
    await surface.navigate('/search');
    const page = (surface as any).page;
    await page.waitForLoadState('load');

    const chain: Descriptor[] = [
      { by: 'roleName', role: 'button', name: 'Totally Nonexistent XYZ' },
    ];
    const result = await surface.resolve(chain);
    expect(result.kind).toBe('notFound');
    if (result.kind === 'notFound') {
      expect(result.rungReports[0].count).toBe(0);
      expect(result.rungReports[0].reason).toContain('not found');
    }
  });

  // ── Policy ──────────────────────────────────────────────

  it('policy: navigate to non-allowed origin is blocked', async () => {
    const result = await surface.navigate('http://evil.example.com/steal');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBeDefined();
      expect(result.blocked!.rule).toBe('origin');
    }
    // Verify no navigation occurred
    const page = (surface as any).page;
    expect(page.url()).not.toContain('evil.example.com');
  });

  // ── Tenant seam ─────────────────────────────────────────

  it('tenant seam: app-relative navigate uses tenantPrefix', async () => {
    const result = await surface.navigate('/search');
    expect(result.ok).toBe(true);
    const page = (surface as any).page;
    expect(page.url()).toContain('/t/cascade-cu/search');
  });

  // ── Predicate checks ───────────────────────────────────

  it('check: textPresent/textAbsent/anyOf predicates', async () => {
    await surface.navigate('/search');
    const page = (surface as any).page;
    await page.waitForLoadState('load');

    expect(await surface.check({ textPresent: 'Member Search' })).toBe(true);
    expect(await surface.check({ textAbsent: 'Nonexistent Text XYZ' })).toBe(true);
    expect(await surface.check({
      anyOf: [{ textPresent: 'Nonexistent' }, { textPresent: 'Member Search' }],
    })).toBe(true);
  });
});
