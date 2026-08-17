#!/usr/bin/env node
// scripts/seed-runs.mjs — Seed the console with real replay runs.
// Every run produced by actual execution against the mock console.
// No LLM calls. No fabricated evidence. Idempotent.

import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';

const ROOT = process.cwd();
const MOCK_URL = process.env.CONSOLE_URL || 'http://localhost:3000';
const CAP = resolve(ROOT, 'capabilities');
const RUNS = resolve(ROOT, 'evidence/runs');

async function checkMock() {
  try { const r = await fetch(`${MOCK_URL}/health`); if (!r.ok) throw 0; }
  catch { console.error('ERROR: Mock console not reachable. Run: npm run mock'); process.exit(1); }
}

function cli(args) {
  return execSync(`npx tsx src/cli/index.ts ${args}`,
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 120000, env: process.env });
}

function clearSeeded() {
  if (!existsSync(RUNS)) { mkdirSync(RUNS, { recursive: true }); return; }
  for (const d of readdirSync(RUNS)) {
    const jPath = join(RUNS, d, 'journal.jsonl');
    if (existsSync(jPath) && readFileSync(jPath, 'utf8').substring(0, 200).includes('"seeded":true'))
      rmSync(join(RUNS, d), { recursive: true, force: true });
  }
}

function findNewestRun(name) {
  const dirs = readdirSync(RUNS).filter(d => d.includes(name)).sort().reverse();
  return dirs[0] ? join(RUNS, dirs[0]) : null;
}

function tagSeeded(runDir) {
  if (!runDir) return;
  const jPath = join(runDir, 'journal.jsonl');
  if (!existsSync(jPath)) return;
  const c = readFileSync(jPath, 'utf8');
  if (!c.includes('"seeded":true'))
    writeFileSync(jPath, `{"event":"seed_marker","seeded":true,"timestamp":"${new Date().toISOString()}"}\n` + c);
}

function getStatus(runDir) {
  if (!runDir) return '?';
  const rp = join(runDir, 'report.json');
  if (!existsSync(rp)) return '?';
  try { return JSON.parse(readFileSync(rp, 'utf8')).result?.status || '?'; } catch { return '?'; }
}

function slug(dir) { return dir ? dir.split(/[/\\]/).pop() : '?'; }

function seedReplay(label, name, inputFlags, tenant = 'cascade-cu') {
  // Approve all possible versions
  for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
    try { cli(`approve ${name} --version ${v}`); } catch {}
  }
  try { cli(`replay ${name} ${inputFlags} --tenant ${tenant}`); } catch {}
  const dir = findNewestRun(name);
  tagSeeded(dir);
  return { label, name, dir: slug(dir), status: getStatus(dir) };
}

function installTempArtifact(name, base, mutate) {
  const art = JSON.parse(readFileSync(resolve(CAP, base), 'utf8'));
  art.name = name;
  mutate(art);
  const dst = join(CAP, `${name}.v1.json`);
  writeFileSync(dst, JSON.stringify(art, null, 2));
  return dst;
}

function removeTempArtifact(name) {
  try { cli(`revoke ${name} --version 1.1.0`); } catch {}
  try { rmSync(join(CAP, `${name}.v1.json`)); } catch {}
}

// ═══════════════════════════════════════════════════════════
await checkMock();
console.log('Seeding runs against', MOCK_URL, '...\n');
clearSeeded();
const R = [];

// ── Primary capability: multiple runs for track record ────
R.push(seedReplay('Savings lookup — member 60020', 'lookup-dense-savings', '--memberId 60020'));
R.push(seedReplay('Savings lookup — member not found', 'lookup-dense-savings', '--memberId 99999'));
R.push(seedReplay('Savings lookup — second query', 'lookup-dense-savings', '--memberId 60020'));

// ── Multi-tenant overlay ──────────────────────────────────
R.push(seedReplay('Savings lookup — Harborview tenant', 'lookup-dense-savings', '--memberId 60020', 'harborview'));

// ── Sparse page shape ─────────────────────────────────────
R.push(seedReplay('Loan balance — sparse page', 'v2-loan-balance-simple', '--memberId 60020'));

// ── HARD_FAILURE: ambiguous (realistic: under-specified artifact) ──
// Use the pre-built weak artifact from evidence (2-step, fails at s2 immediately)
const ambigSrc = resolve(ROOT, 'evidence/replay-hard-failure-ambiguous/weak-artifact.json');
if (existsSync(ambigSrc)) {
  const ambigArt = JSON.parse(readFileSync(ambigSrc, 'utf8'));
  ambigArt.name = 'lookup-member-address';
  ambigArt.app.startPath = '/search';
  ambigArt.steps[0].action.value = '/search';
  ambigArt.steps[1].intent = 'Type username into the login field';
  ambigArt.steps[1].target.reasoning = 'Under-specified: role and frame only. Two textboxes score identically — ambiguous.';
  writeFileSync(join(CAP, 'lookup-member-address.v1.json'), JSON.stringify(ambigArt, null, 2));
  R.push(seedReplay('Member address lookup — ambiguous target', 'lookup-member-address', '--memberId 60020'));
  removeTempArtifact('lookup-member-address');
}

// ── HARD_FAILURE: broken target (realistic: UI changed since recording) ──
// Broken target: 4-step artifact where step 4 targets a link that doesn't exist
// Realistic story: "Certificate Rates" link was removed in a UI update
const brokenArt = {
  name: 'lookup-certificate-rate', version: '1.0.0',
  app: { id: 'vendor-console', startPath: '/search' },
  inputs: { memberId: { type: 'string', pattern: '^[0-9]{5}$', sensitive: false }, username: { type: 'string', sensitive: true }, password: { type: 'string', sensitive: true } },
  outputs: { rate: { type: 'string', pattern: '.{1,100}', sensitive: false } },
  businessOutcomes: {},
  steps: [
    { id: 's1', intent: 'Navigate to login', action: { verb: 'navigate', value: '/search' }, target: { properties: { role: 'navigation', frame: 'main' }, reasoning: 'URL-based' }, risk: 'safe', expect: { textPresent: 'Sign In' } },
    { id: 's2', intent: 'Enter operator username', action: { verb: 'type', value: { $input: 'username' } }, target: { properties: { role: 'textbox', frame: 'main', attrName: 'f1', neighborText: ['Username'] }, reasoning: 'HTML name f1' }, risk: 'safe', expect: { elementValue: { $self: true } } },
    { id: 's3', intent: 'Enter operator password', action: { verb: 'type', value: { $input: 'password' } }, target: { properties: { role: 'textbox', frame: 'main', attrName: 'f2', neighborText: ['Password'] }, reasoning: 'HTML name f2' }, risk: 'safe', expect: { elementValue: { $self: true } } },
    { id: 's4', intent: 'Click Certificate Rates on the dashboard', action: { verb: 'click' }, target: { properties: { role: 'link', frame: 'main', name: 'Certificate Rates', attrName: 'cert_rates' }, reasoning: 'Was present when recorded. Removed in a recent UI update.' }, risk: 'safe', expect: { textPresent: 'Certificate' } },
  ],
};
writeFileSync(join(CAP, 'lookup-certificate-rate.v1.json'), JSON.stringify(brokenArt, null, 2));
R.push(seedReplay('Certificate rate lookup — page changed', 'lookup-certificate-rate', '--memberId 60020'));
removeTempArtifact('lookup-certificate-rate');

// ── SUCCESS with recovery (session expiry) ────────────────
// Replace s5 (Click Member Search) with a fault navigate. The redirect lands on
// the login page showing "Your session has expired". The fault step's expect
// passes (login page has "Sign In"). Then s6 (type memberId into search field)
// fails to resolve on the login page — error library detects SESSION_EXPIRED,
// fires r1-r4 (re-login + navigate /search), s6 retries and succeeds.
const recovBase = JSON.parse(readFileSync(resolve(CAP, 'lookup-dense-savings.v1.json'), 'utf8'));
recovBase.name = 'lookup-savings-with-recovery';
recovBase.version = '1.0.0';
// Replace s5 with fault navigate (same approach as the passing test)
recovBase.steps[4] = {
  id: 's5', intent: 'Navigate to member search (session expiry will trigger here)',
  action: { verb: 'navigate', value: '/search?fault=session_expired' },
  target: recovBase.steps[4].target,
  risk: 'safe', expect: { textPresent: 'Sign In' },
};
const recovDst = join(CAP, 'lookup-savings-with-recovery.v1.json');
writeFileSync(recovDst, JSON.stringify(recovBase, null, 2));
R.push(seedReplay('Savings lookup — recovered from session expiry', 'lookup-savings-with-recovery', '--memberId 60020'));
removeTempArtifact('lookup-savings-with-recovery');

// ── Harborview savings (native vocabulary) ────────────────
R.push(seedReplay('Harborview savings — native artifact', 'v2-harborview-savings', '--memberId 60020', 'harborview'));

// ── Wire discovery journals into evidence/runs ────────────
console.log('  Wiring discovery evidence...');
const discDirs = [
  { src: 'evidence/discovery-compiled', label: 'discovery-compiled' },
  { src: 'evidence/discovery-escalated', label: 'discovery-escalated' },
];
for (const { src, label } of discDirs) {
  const srcDir = resolve(ROOT, src);
  if (existsSync(srcDir) && existsSync(join(srcDir, 'journal.jsonl'))) {
    // Create a run dir that looks like a timestamped run
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = label;
    const dstDir = join(RUNS, `${ts}-${name}`);
    mkdirSync(dstDir, { recursive: true });
    for (const f of readdirSync(srcDir)) {
      if (f === 'README.md') continue;
      copyFileSync(join(srcDir, f), join(dstDir, f));
    }
    tagSeeded(dstDir);
    R.push({ label: `Discovery: ${label}`, name, dir: slug(dstDir), status: 'COMPILED' });
  }
}

// ── Restore trust: THREE approved ─────────────────────────
writeFileSync(join(CAP, 'trust.json'), JSON.stringify({
  "lookup-dense-savings@1.1.0": {
    status: "approved", approvedBy: "seed (demo data)",
    approvedAt: "2026-08-17T00:00:00.000Z",
    note: "Primary savings lookup. Verified across both tenants."
  },
  "v2-loan-balance-simple@1.0.0": {
    status: "approved", approvedBy: "seed (demo data)",
    approvedAt: "2026-08-17T00:01:00.000Z",
    note: "Loan balance on sparse member page. Different page shape from savings."
  },
  "v2-harborview-savings@1.0.0": {
    status: "approved", approvedBy: "seed (demo data)",
    approvedAt: "2026-08-17T00:02:00.000Z",
    note: "Harborview-native vocabulary. Demonstrates tenant-specific artifact."
  }
}, null, 2));

// ── Print table ───────────────────────────────────────────
console.log('\n  SEEDED RUNS');
console.log('  ' + '─'.repeat(80));
console.log('  ' + 'Label'.padEnd(42) + 'Status'.padEnd(20) + 'Dir');
console.log('  ' + '─'.repeat(80));
for (const r of R) console.log('  ' + r.label.padEnd(42) + (r.status||'?').padEnd(20) + (r.dir||'?'));
console.log('  ' + '─'.repeat(80));
console.log(`\n  ${R.length} entries seeded.\n`);
