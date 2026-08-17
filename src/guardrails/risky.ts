// src/guardrails/risky.ts — Deterministic risky-action classifier.
// Loads the verb list from config/risky-verbs.json.
// Word-boundary matched, case-insensitive.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

let riskyPatterns: RegExp[] | null = null;

function loadPatterns(): RegExp[] {
  if (riskyPatterns) return riskyPatterns;
  const path = resolve('config/risky-verbs.json');
  if (!existsSync(path)) { riskyPatterns = []; return riskyPatterns; }
  const { verbs } = JSON.parse(readFileSync(path, 'utf8'));
  riskyPatterns = (verbs as string[]).map(v =>
    new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  );
  return riskyPatterns;
}

/** Returns true if the target name matches any risky verb pattern. */
export function isRiskyTarget(name: string): boolean {
  if (!name) return false;
  return loadPatterns().some(p => p.test(name));
}
