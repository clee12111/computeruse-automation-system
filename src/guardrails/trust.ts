// src/guardrails/trust.ts — Trust lifecycle for risky capabilities.
// Artifacts stay immutable; trust is external governance metadata.
// capabilities/trust.json: { "name@version": { status, approvedBy, approvedAt, note } }

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { userInfo } from 'node:os';

export interface TrustEntry {
  status: 'manual' | 'approved';
  approvedBy?: string;
  approvedAt?: string;
  note?: string;
}

export interface TrustStore {
  [key: string]: TrustEntry; // key = "name@version"
}

const TRUST_PATH = resolve('capabilities/trust.json');

export function loadTrust(): TrustStore {
  if (!existsSync(TRUST_PATH)) return {};
  return JSON.parse(readFileSync(TRUST_PATH, 'utf8'));
}

export function saveTrust(store: TrustStore): void {
  writeFileSync(TRUST_PATH, JSON.stringify(store, null, 2) + '\n');
}

export function trustKey(name: string, version: string): string {
  return `${name}@${version}`;
}

export function getTrustStatus(name: string, version: string): TrustEntry {
  const store = loadTrust();
  return store[trustKey(name, version)] ?? { status: 'manual' };
}

export function approveCapability(name: string, version: string, note?: string): TrustEntry {
  const store = loadTrust();
  const key = trustKey(name, version);
  const entry: TrustEntry = {
    status: 'approved',
    approvedBy: userInfo().username,
    approvedAt: new Date().toISOString(),
    note,
  };
  store[key] = entry;
  saveTrust(store);
  return entry;
}

// ── Naive dossier (shape visible now; full computation is Phase 9.2) ──
export interface TrustDossier {
  runCount: number;
  successCount: number;
  interventionCount: number;
  successRate: string;
  note: string;
}

export function computeDossier(name: string, version: string): TrustDossier {
  const runsDir = resolve('evidence/runs');
  if (!existsSync(runsDir)) {
    return { runCount: 0, successCount: 0, interventionCount: 0, successRate: 'N/A', note: 'no runs recorded' };
  }

  let runs = 0, successes = 0, interventions = 0;
  try {
    const dirs = readdirSync(runsDir).filter(d => d.includes(name));
    for (const dir of dirs) {
      const resultPath = join(runsDir, dir, 'result.json');
      if (!existsSync(resultPath)) continue;
      try {
        const resultText = readFileSync(resultPath, 'utf8');
        runs++;
        if (resultText.includes('"SUCCESS"') || resultText.includes('"status":"SUCCESS"')) successes++;
        const journalPath = join(runsDir, dir, 'journal.jsonl');
        if (existsSync(journalPath)) {
          const journal = readFileSync(journalPath, 'utf8');
          if (journal.includes('control_transfer')) interventions++;
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* evidence dir not readable */ }

  const rate = runs > 0 ? `${Math.round(successes / runs * 100)}%` : 'N/A';
  return {
    runCount: runs,
    successCount: successes,
    interventionCount: interventions,
    successRate: rate,
    note: runs === 0 ? 'no runs recorded' : `${runs} runs, ${successes} successes`,
  };
}
