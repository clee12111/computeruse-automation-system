// test/parabank.test.ts — ParaBank third-party verification.
// SKIPPED unless RUN_PARABANK=1 AND PARABANK_USER set.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { replay } from '../src/replay/engine.js';
import { loadArtifact } from '../src/schema/loader.js';
import { RunJournal } from '../src/evidence/journal.js';
import { loadEnvFile } from '../src/discovery/openai-client.js';
import type { Policy } from '../src/surface/surface.js';

loadEnvFile(resolve(process.cwd(), '.env'));
const SHOULD_RUN = process.env.RUN_PARABANK === '1' && !!process.env.PARABANK_USER;

describe.skipIf(!SHOULD_RUN)('ParaBank', { timeout: 120_000 }, () => {

  it('replay parabank-account-balance → SUCCESS', async () => {
    const artifact = loadArtifact(resolve('capabilities/parabank-account-balance.v1.json'));
    const baseUrl = 'https://parabank.parasoft.com';
    const policy: Policy = {
      allowedOrigins: [baseUrl], allowedRoutes: ['/parabank/*'],
      allowedVerbs: ['click', 'type', 'select', 'read', 'navigate'],
    };
    const surface = new BrowserSurface({ baseUrl, tenantPrefix: '', policy, headed: false });
    const inputs = {
      username: process.env.PARABANK_USER!,
      password: process.env.PARABANK_PASS!,
    };
    const journal = new RunJournal(resolve('evidence/runs'), artifact, inputs);
    (surface as any).config.screenshotDir = journal.runDir;
    await surface.launch();
    try {
      const result = await replay({ surface, artifact, inputs, journal, stepTimeoutMs: 30000, tickMs: 500 });
      journal.writeResult(result);

      expect(result.status).toBe('SUCCESS');
      if (result.status === 'SUCCESS') {
        expect(result.outputs.balance).toBeDefined();
        console.log('ParaBank balance:', result.outputs.balance);
      }

      // Redaction: creds absent
      const files = readdirSync(journal.runDir);
      for (const f of files) {
        const content = readFileSync(resolve(journal.runDir, f), 'utf8');
        expect(content).not.toContain(process.env.PARABANK_PASS!);
      }
    } finally {
      await surface.close();
    }
  });
});
