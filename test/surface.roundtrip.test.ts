// test/surface.roundtrip.test.ts — Surface roundtrip tests against the live mock.
// observe → find → describe → resolve → assert same element (roundtrip).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import type { PropertySet } from '../src/schema/artifact.js';
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
    expect(chain[0].role).toBe('button');

    const result = await surface.resolve(chain);
    expect(result.kind).toBe('match');
  });

  it('login username input: roundtrip (labelProximity or structural)', async () => {
    await surface.navigate('/login');
    const obs = await surface.observe();
    // The username input has nearbyText "Username" from the adjacent TD
    const input = findEl(obs, e => e.role === 'textbox' && !!(e.nearbyText?.includes('Username')));
    expect(input).toBeDefined();

    const chain = await surface.describe(input!.ref);
    expect(chain.length).toBeGreaterThan(0);
    // Should have a role and frame at minimum (v2 property set)
    expect(chain[0].role).toBeDefined();
    expect(chain[0].frame).toBeDefined();

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
    expect(btnChain[0]?.role).toBe('button');
    const btnResult = await surface.resolve(btnChain);
    expect(btnResult.kind).toBe('match');
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

    // Observe first to get the element's actual properties for scoring
    const obs = await surface.observe();
    const targetCell = obs.elements.find(e => e.name?.includes('4,320') && e.frame !== 'main');
    expect(targetCell).toBeDefined();
    // Use describe() to get the element's property set, then resolve it
    const chain = await surface.describe(targetCell!.ref);
    const result = await surface.resolve(chain);
    expect(result.kind).toBe('match');

    // Verify describe() generates a PropertySet with columnHeader
    const obs2 = await surface.observe();
    const balanceCell = obs2.elements.find(e => e.name?.includes('4,320') && e.frame !== 'main');
    if (balanceCell) {
      const descChain = await surface.describe(balanceCell.ref);
      expect(descChain[0].role).toBe('cell');
      expect(descChain[0].columnHeader).toBeDefined();
    }
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

    // Observe to find the actual frame name for the iframe
    const obs23 = await surface.observe();
    const savingsCells = obs23.elements.filter(e => e.name === 'Savings' && e.frame !== 'main');
    expect(savingsCells.length).toBeGreaterThanOrEqual(2); // member 23456 has 2+ Savings
    const frameName = savingsCells[0].frame;
    const chain: PropertySet[] = [
      { role: 'cell', frame: frameName, name: 'Savings', columnHeader: 'Type' },
    ];
    const result = await surface.resolve(chain);
    expect(result.kind).toBe('ambiguous');
  });

  // ── NotFound ────────────────────────────────────────────

  it('notFound: descriptor for non-existent element returns notFound', async () => {
    await surface.navigate('/search');
    const page = (surface as any).page;
    await page.waitForLoadState('load');

    // Use a role that doesn't exist on the page at all
    const chain: PropertySet[] = [
      { role: 'slider', frame: 'main', name: 'Totally Nonexistent XYZ', attrName: 'zzz_nope' },
    ];
    const result = await surface.resolve(chain);
    expect(result.kind).toBe('notFound');
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
