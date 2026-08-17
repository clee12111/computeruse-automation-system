#!/usr/bin/env node
// scripts/margin-report.mjs — Margin telemetry summary from replay journals.
// Usage: node scripts/margin-report.mjs [evidence/runs]
// Reads every */journal.jsonl, collects scoring_result events, prints the
// distribution + warning-band summary as a markdown section ready to paste
// into docs/live-reliability-v2.md. No dependencies.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? join('evidence', 'runs');
const LOW = 0.15;

const margins = [];   // { margin, topScore, stepId, run }
let warnings = 0;

for (const dir of readdirSync(root)) {
  const p = join(root, dir, 'journal.jsonl');
  if (!existsSync(p) || !statSync(p).isFile()) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev.event === 'scoring_result' && typeof ev.margin === 'number') {
      margins.push({ margin: ev.margin, topScore: ev.topScore, stepId: ev.stepId, run: dir });
    }
    if (ev.event === 'low_margin_warning') warnings++;
  }
}

if (margins.length === 0) {
  console.log(`No scoring_result events found under ${root}.`);
  process.exit(1);
}

margins.sort((a, b) => a.margin - b.margin);
const q = (f) => margins[Math.min(margins.length - 1, Math.floor(margins.length * f))].margin;
const inBand = margins.filter(m => m.margin < LOW);
const byStep = {};
for (const m of inBand) byStep[m.stepId] = (byStep[m.stepId] ?? 0) + 1;
const closest = margins[0];
const fmt = (x) => x.toFixed(4);

console.log(`## Margin telemetry (from ${root})

| Metric | Value |
|---|---|
| Scored resolutions | ${margins.length} |
| Min margin | ${fmt(closest.margin)} |
| p25 / median / p75 | ${fmt(q(0.25))} / ${fmt(q(0.5))} / ${fmt(q(0.75))} |
| Max margin | ${fmt(margins[margins.length - 1].margin)} |
| In warning band (< ${LOW}) | ${inBand.length} (${(100 * inBand.length / margins.length).toFixed(1)}%) |
| low_margin_warning events emitted | ${warnings} |
| Closest call | ${fmt(closest.margin)} — ${closest.stepId} in ${closest.run} |

Low-margin events by step: ${Object.entries(byStep).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}: ${n}`).join(', ') || 'none'}

Reading: margins near θ (0.05) are thin wins — the elements drift will flip first.
The warning band is the early-warning zone; a growing count here over time is the
re-discovery signal for a capability.`);
