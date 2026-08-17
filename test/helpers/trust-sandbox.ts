// test/helpers/trust-sandbox.ts — Gives each test file its own trust.json.
// Sets TRUST_STORE_PATH to a temp file and cleans up after.

import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const id = randomBytes(4).toString('hex');
const dir = resolve(tmpdir(), `trust-test-${id}`);
mkdirSync(dir, { recursive: true });
const trustPath = resolve(dir, 'trust.json');
writeFileSync(trustPath, '{}');
process.env.TRUST_STORE_PATH = trustPath;

export function cleanupTrustSandbox(): void {
  try { unlinkSync(trustPath); } catch {}
}
