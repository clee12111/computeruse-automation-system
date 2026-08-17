// One-shot script: regenerate report.json + report.md for all curated evidence folders.
// Usage: npx tsx scripts/regen-reports.ts

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { generateReport, renderMarkdown } from '../src/evidence/report.js';

const evidenceDir = resolve('evidence');

// Process both curated evidence dirs and runs/
const allDirs: string[] = [];
for (const d of readdirSync(evidenceDir)) {
  const dir = join(evidenceDir, d);
  if (!statSync(dir).isDirectory()) continue;
  if (d === 'runs') {
    // Also process run directories
    for (const rd of readdirSync(dir)) {
      const runDir = join(dir, rd);
      if (statSync(runDir).isDirectory()) allDirs.push(runDir);
    }
  } else {
    allDirs.push(dir);
  }
}

for (const dir of allDirs) {
  if (!existsSync(join(dir, 'journal.jsonl'))) continue;
  const d = dir.split(/[/\\]/).pop() || dir;

  const journalText = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
  const events = journalText.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  // Find artifact: local file first, then capabilities dir
  let artifact: any = null;
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.json') && f !== 'result.json' && f !== 'report.json') {
      try {
        const a = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (a.steps) { artifact = a; break; }
      } catch { /* skip */ }
    }
  }
  if (!artifact) {
    try { artifact = JSON.parse(readFileSync(resolve('capabilities/lookup-dense-savings.v1.json'), 'utf8')); } catch { /* skip */ }
  }

  // Load result (handle redacted bullet chars)
  let result: any = null;
  const rp = join(dir, 'result.json');
  if (existsSync(rp)) {
    try {
      const raw = readFileSync(rp, 'utf8').replace(/•••/g, '"[redacted]"');
      result = JSON.parse(raw);
    } catch { /* skip */ }
  }

  const report = generateReport(events, artifact, result);
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, 'report.md'), renderMarkdown(report));
  console.log(`  ✓ ${d} → ${report.type}`);
}

console.log('\nDone.');
