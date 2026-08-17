// test/helpers/capture-properties.ts — One-time script to capture real element
// PropertySets from the mock console for building v2 test artifacts.
//
// Prerequisites: mock console running on localhost:3000
// Run: npx tsx test/helpers/capture-properties.ts

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { BrowserSurface } from '../../src/surface/browser-surface.js';
import type { SurfaceConfig } from '../../src/surface/surface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config: SurfaceConfig = {
  baseUrl: 'http://localhost:3000',
  tenantPrefix: '/t/cascade-cu',
  headed: false,
  policy: {
    allowedOrigins: ['http://localhost:3000'],
    allowedRoutes: ['/t/cascade-cu/*'],
    allowedVerbs: ['click', 'type', 'select', 'read', 'navigate'],
  },
};

async function main() {
  const surface = new BrowserSurface(config);
  await surface.launch();

  try {
    // ── Page 1: Login ────────────────────────────────────────
    console.log('=== LOGIN PAGE ===');
    await surface.navigate('/login');
    let obs = await surface.observe();

    // Username textbox (name="f1", label "Username")
    const usernameEl = obs.elements.find(
      e => e.role === 'textbox' && e.attrName === 'f1',
    );
    if (usernameEl) {
      const props = await surface.describe(usernameEl.ref);
      console.log('Username textbox:', JSON.stringify(props[0], null, 2));
    } else {
      console.error('Username textbox not found');
    }

    // Password textbox (name="f2", label "Password")
    const passwordEl = obs.elements.find(
      e => e.role === 'textbox' && e.attrName === 'f2',
    );
    if (passwordEl) {
      const props = await surface.describe(passwordEl.ref);
      console.log('Password textbox:', JSON.stringify(props[0], null, 2));
    } else {
      console.error('Password textbox not found');
    }

    // Sign In button
    const signInEl = obs.elements.find(
      e => e.role === 'button' && e.name.includes('Sign In'),
    );
    if (signInEl) {
      const props = await surface.describe(signInEl.ref);
      console.log('Sign In button:', JSON.stringify(props[0], null, 2));
    } else {
      console.error('Sign In button not found');
    }

    // ── Perform login ────────────────────────────────────────
    // Type credentials and submit
    if (usernameEl) {
      const resolveU = await surface.resolve(await surface.describe(usernameEl.ref));
      if (resolveU.kind === 'match') {
        await surface.act({ verb: 'type', ref: resolveU.ref, value: 'operator' });
      }
    }
    if (passwordEl) {
      const resolveP = await surface.resolve(await surface.describe(passwordEl.ref));
      if (resolveP.kind === 'match') {
        await surface.act({ verb: 'type', ref: resolveP.ref, value: 'demo123' });
      }
    }
    if (signInEl) {
      const resolveS = await surface.resolve(await surface.describe(signInEl.ref));
      if (resolveS.kind === 'match') {
        await surface.act({ verb: 'click', ref: resolveS.ref });
      }
    }

    // ── Page 2: Search ───────────────────────────────────────
    console.log('\n=== SEARCH PAGE ===');
    await surface.navigate('/search');
    obs = await surface.observe();

    // Member Number textbox (name="f1")
    const memberNumEl = obs.elements.find(
      e => e.role === 'textbox' && e.attrName === 'f1',
    );
    if (memberNumEl) {
      const props = await surface.describe(memberNumEl.ref);
      console.log('Member Number textbox:', JSON.stringify(props[0], null, 2));
    } else {
      console.error('Member Number textbox not found');
    }

    // Member Search button
    const searchBtnEl = obs.elements.find(
      e => e.role === 'button' && e.name.includes('Search'),
    );
    if (searchBtnEl) {
      const props = await surface.describe(searchBtnEl.ref);
      console.log('Member Search button:', JSON.stringify(props[0], null, 2));
    } else {
      console.error('Member Search button not found');
    }

    // ── Perform search ───────────────────────────────────────
    if (memberNumEl) {
      const resolveM = await surface.resolve(await surface.describe(memberNumEl.ref));
      if (resolveM.kind === 'match') {
        await surface.act({ verb: 'type', ref: resolveM.ref, value: '12345' });
      }
    }
    if (searchBtnEl) {
      const resolveSB = await surface.resolve(await surface.describe(searchBtnEl.ref));
      if (resolveSB.kind === 'match') {
        await surface.act({ verb: 'click', ref: resolveSB.ref });
      }
    }

    // ── Page 3: Member Detail ────────────────────────────────
    console.log('\n=== MEMBER DETAIL PAGE ===');
    // Wait a moment for navigation to settle
    await new Promise(r => setTimeout(r, 1000));
    obs = await surface.observe();

    // Savings balance cell in the accounts iframe
    // The accounts iframe has columns: Share ID | Account # | Type | Balance
    // We need the Balance cell for the Savings row.
    // Strategy: find the "Savings" type cell first, then find the balance cell
    // in the same row (same nearbyText pattern or adjacent position).

    // First, find all iframe cells and print them for visibility
    const iframeCells = obs.elements.filter(
      e => e.role === 'cell' && e.frame !== 'main',
    );
    console.log(`Found ${iframeCells.length} iframe cells total`);

    // Try to find the balance cell by column header "Balance"
    const balanceCells = iframeCells.filter(e => e.columnHeader === 'Balance');
    // Also find "Savings" type cells to correlate the row
    const savingsTypeCells = iframeCells.filter(
      e => e.name?.includes('Savings'),
    );

    // The savings balance is the balance cell whose name starts with "$"
    // and shares a row with a "Savings" type cell.
    // Since we can't directly match rows, use position: the savings row's
    // balance cell has the same y-coordinate as the savings type cell.
    let savingsBalanceEl = null;
    if (savingsTypeCells.length > 0 && balanceCells.length > 0) {
      const savingsY = savingsTypeCells[0].bounds?.y;
      if (savingsY != null) {
        savingsBalanceEl = balanceCells.find(
          e => e.bounds && Math.abs(e.bounds.y - savingsY) < 3,
        );
      }
    }

    if (savingsBalanceEl) {
      const props = await surface.describe(savingsBalanceEl.ref);
      console.log('Savings balance cell:', JSON.stringify(props[0], null, 2));
    } else {
      console.error('Savings balance cell not found via y-coordinate matching.');
    }

    // Always dump all iframe cells for reference
    console.log('\nAll iframe cells for reference:');
    for (const cell of iframeCells) {
      const props = await surface.describe(cell.ref);
      console.log(
        `  cell [name="${cell.name}", col="${cell.columnHeader}", nearby="${cell.nearbyText}"]:`,
        JSON.stringify(props[0], null, 2),
      );
    }

    console.log('\n=== DONE ===');
  } finally {
    await surface.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
