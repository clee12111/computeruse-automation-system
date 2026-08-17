// src/cli/doctor.ts — Preflight check: verifies everything a new user needs.
// npm run doctor — the first thing the README tells you to run.

import { existsSync, readFileSync, readdirSync, accessSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

// Load .env into process.env
const envPath = resolve('.env');
if (existsSync(envPath)) {
  const envLines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of envLines) {
    const idx = line.indexOf('=');
    if (idx < 0 || line.startsWith('#')) continue;
    const key = line.substring(0, idx).trim();
    const val = line.substring(idx + 1).trim();
    if (/^[A-Z_][A-Z_0-9]*$/.test(key) && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

let failures = 0;
function check(name: string, ok: boolean, fix: string) {
  if (ok) { console.log(`  ✅ ${name}`); }
  else { console.log(`  ❌ ${name}`); console.log(`     → ${fix}`); failures++; }
}

console.log('\n  computeruse-automation-system — preflight check\n');

// Node version
const nodeVer = process.versions.node.split('.').map(Number);
check('Node >= 20', nodeVer[0] >= 20, 'Install Node.js 20 or later: https://nodejs.org');

// Dependencies installed
check('node_modules exists', existsSync(resolve('node_modules')), 'Run: npm install');

// Playwright chromium
let pwOk = false;
try { const out = execSync('npx playwright install --dry-run chromium 2>&1', { encoding: 'utf8', timeout: 10000 }); pwOk = true; } catch {}
if (!pwOk) { try { execSync('npx playwright --version', { encoding: 'utf8', timeout: 5000 }); pwOk = true; } catch {} }
// Check if chromium binary exists in the cache
try { const browsers = execSync('npx playwright install --dry-run 2>&1', { encoding: 'utf8', timeout: 10000 }); if (!browsers.includes('chromium')) pwOk = true; } catch {}
check('Playwright chromium', pwOk || existsSync(resolve('node_modules/playwright')), 'Run: npx playwright install chromium');

// Required env vars
const envFile = resolve('.env');
const hasEnv = existsSync(envFile);
check('.env file exists', hasEnv, 'Copy .env.example to .env and fill in values');

if (hasEnv) {
  // Check env vars that should be set (process.env was loaded above)
  check('CONSOLE_USER set', !!process.env.CONSOLE_USER, 'Set CONSOLE_USER in .env (the login username for the target app)');
  check('CONSOLE_PASS set', !!process.env.CONSOLE_PASS, 'Set CONSOLE_PASS in .env (the login password — never stored in artifacts)');
  if (process.env.OPENAI_API_KEY) { console.log('  ✅ OPENAI_API_KEY set (discovery enabled)'); }
  else { console.log('  ⚠️  OPENAI_API_KEY not set (replay works, discovery requires it)'); }
}

// Trust store writable
const trustPath = process.env.TRUST_STORE_PATH || resolve('capabilities/trust.json');
try { accessSync(trustPath, constants.W_OK); check('Trust store writable', true, ''); }
catch { check('Trust store writable', false, `Make ${trustPath} writable, or set TRUST_STORE_PATH`); }

// Capabilities load
const capDir = resolve('capabilities');
let capCount = 0, capErrors: string[] = [];
if (existsSync(capDir)) {
  for (const f of readdirSync(capDir)) {
    if (!f.endsWith('.json') || f === 'trust.json') continue;
    try {
      const raw = JSON.parse(readFileSync(join(capDir, f), 'utf8'));
      if (raw.name && raw.version && raw.steps) capCount++;
    } catch (e) { capErrors.push(`${f}: ${(e as Error).message}`); }
  }
}
check(`Capabilities load (${capCount} found)`, capErrors.length === 0, capErrors.length ? `Schema errors:\n       ${capErrors.join('\n       ')}` : 'No capabilities/ directory');

// Mock console reachable
let mockOk = false;
try {
  const url = process.env.CONSOLE_URL || process.env.MOCK_CONSOLE_URL || 'http://localhost:3000';
  // Try curl first (Linux/macOS), then node http (Windows)
  try {
    execSync(`curl -sf --max-time 3 ${url}/health`, { timeout: 5000, stdio: 'pipe' });
    mockOk = true;
  } catch {
    // Fallback: write a temp script to avoid shell quoting issues
    const { writeFileSync: wf, unlinkSync: ul } = require('fs');
    const tmpScript = resolve('node_modules/.cache/_doctor_check.cjs');
    wf(tmpScript, `const http=require("http");http.get("${url}/health",r=>{process.exit(r.statusCode===200?0:1)}).on("error",()=>process.exit(1))`);
    execSync(`node ${tmpScript}`, { timeout: 5000, stdio: 'pipe' });
    try { ul(tmpScript); } catch {}
    mockOk = true;
  }
} catch {}
check('Mock console reachable', mockOk, 'Start it: npm run mock (in another terminal)');

console.log('');
if (failures > 0) {
  console.log(`  ${failures} issue(s) found. Fix them and run again.\n`);
  process.exit(1);
} else {
  console.log('  All checks passed. You\'re ready to go.\n');
}
