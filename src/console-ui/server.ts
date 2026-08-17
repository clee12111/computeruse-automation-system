// src/console-ui/server.ts — Operator console.
// Three screens: ASK (home), SITES (what we automate), RUNS (what happened).
// THIN FACE: imports existing modules, zero new core logic.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnvFile } from '../discovery/openai-client.js';
import { approveCapability, loadTrust, trustKey, revokeCapability } from '../guardrails/trust.js';
import { describeReplayResult } from '../schema/describe-result.js';
import { ConsoleChannel } from '../escalation/intervention.js';
import type { InterventionRequest } from '../schema/results.js';

loadEnvFile(resolve(process.cwd(), '.env'));
const PORT = parseInt(process.env.CONSOLE_UI_PORT || '4000', 10);
const ROOT = process.cwd();

// ── Active discovery runs (in-process, not subprocess) ──────
interface ActiveRun {
  name: string;
  goal: string;
  site: string;
  runDir: string;
  channel: ConsoleChannel;
  status: 'running' | 'paused' | 'done';
  startedAt: number;
  surface?: import('../surface/surface.js').Surface;
  journal?: import('../evidence/journal.js').RunJournal;
}
const activeRuns = new Map<string, ActiveRun>();

/** Get the single paused run (if any). */
function getPausedRun(): ActiveRun | null {
  for (const r of activeRuns.values()) {
    if (r.status === 'paused') return r;
  }
  return null;
}

/** Count paused runs for badge. */
function pausedCount(): number {
  let n = 0;
  for (const r of activeRuns.values()) if (r.status === 'paused') n++;
  return n;
}

// ── Data ─────────────────────────────────────────────────────

function loadArtifacts() {
  const dir = resolve(ROOT, 'capabilities');
  if (!existsSync(dir)) return [];
  const trust = loadTrust();
  const results: any[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'trust.json') continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!raw.name || !raw.version || raw.steps?.[0]?.target?.chain) continue;
      const key = trustKey(raw.name, raw.version);
      results.push({ ...raw, _file: f, _trust: trust[key] ?? { status: 'manual' } });
    } catch { /* skip */ }
  }
  return results.sort((a: any, b: any) => a.name.localeCompare(b.name));
}

function loadSurfaces(): Record<string, any> {
  const p = resolve(ROOT, 'config/mcp-surfaces.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')).surfaces ?? {}; } catch { return {}; }
}

function loadRuns(filter?: string) {
  const dir = resolve(ROOT, 'evidence/runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(d => {
    if (!statSync(join(dir, d)).isDirectory()) return false;
    return !filter || d.includes(filter);
  }).sort().reverse().slice(0, 100).map(d => {
    const rPath = join(dir, d, 'result.json');
    let result: any = null;
    if (existsSync(rPath)) {
      try {
        const raw = readFileSync(rPath, 'utf8').replace(/•••/g, '"[redacted]"');
        result = JSON.parse(raw);
      } catch {}
    }
    // Infer status from journal when result.json is missing or empty
    if (!result) {
      const jPath = join(dir, d, 'journal.jsonl');
      if (existsSync(jPath)) {
        const jText = readFileSync(jPath, 'utf8');
        const lines = jText.split('\n').filter(Boolean);
        // Scan ALL lines for terminal events (not just tail — order matters)
        const allText = jText;
        const hasCompiled = allText.includes('"event":"compiled"');
        const hasDeadEnd = allText.includes('"event":"dead_end"');
        const hasAborted = allText.includes('"event":"aborted"');
        const hasTokenSummary = allText.includes('"event":"token_summary"');
        const hasDiscoveryStart = allText.includes('"event":"discovery_start"');
        const isDiscovery = hasDiscoveryStart;

        if (hasCompiled) {
          result = { status: 'COMPILED' };
        } else if (hasDeadEnd) {
          const m = allText.match(/"event":"dead_end"[^}]*"reason":"([^"]+)"/);
          result = { status: 'DEAD_END', reason: m?.[1] || 'unknown' };
        } else if (hasAborted) {
          const m = allText.match(/"event":"aborted"[^}]*"reason":"([^"]+)"/);
          result = { status: 'ABORTED', reason: m?.[1] || 'unknown' };
        } else if (!isDiscovery) {
          // Replay-specific statuses
          const tail = lines.slice(-10).join(' ');
          if (tail.includes('"outcome_detected"')) {
            const m = tail.match(/"code":"([^"]+)"/);
            result = { status: 'BUSINESS_OUTCOME', code: m?.[1] };
          } else if (tail.includes('"handback"') && tail.includes('"abort"')) {
            result = { status: 'ESCALATED' };
          }
        }

        // Discovery with token_summary but no terminal event = dead_end (old runs before fix)
        if (!result && isDiscovery && hasTokenSummary) {
          result = { status: 'DEAD_END', reason: 'finished without compiling (pre-fix run)' };
        }

        // If still no result and has content — check age
        if (!result && lines.length > 0) {
          const age = Date.now() - new Date(d.substring(0, 19).replace(/-/g, (m: string, i: number) => i > 6 ? ':' : '-').replace('T', 'T')).getTime();
          if (age > 120000) { // 2 minutes — discovery rarely takes longer
            result = { status: isDiscovery ? 'DEAD_END' : 'INCOMPLETE', reason: 'no terminal event (likely crashed or killed)' };
          }
        }
      }
    }
    // Check for recovery events
    let recovered = false;
    const jPath2 = join(dir, d, 'journal.jsonl');
    if (existsSync(jPath2)) {
      const jText2 = readFileSync(jPath2, 'utf8');
      if (jText2.includes('"recovery_complete"')) recovered = true;
    }
    return { dir: d, capability: d.split('-').slice(7).join('-') || d, result, recovered };
  });
}

function loadJournal(runDir: string) {
  const p = resolve(ROOT, 'evidence/runs', runDir, 'journal.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return { event: 'parse_error' }; }
  });
}

// Find which surface an artifact runs on
function surfaceFor(art: any) {
  const surfaces = loadSurfaces();
  const s = surfaces[art.app?.id];
  return s ?? { label: art.app?.id, baseUrl: '', description: '' };
}

// Plain-english tool description
function toolSentence(art: any): string {
  const inputs = Object.keys(art.inputs).filter((k: string) => k !== 'username' && k !== 'password');
  const outputs = Object.keys(art.outputs).map((k: string) => k.replace(/([A-Z])/g, ' $1').toLowerCase().trim());
  const outcomes = Object.keys(art.businessOutcomes || {}).map((k: string) => k.replace(/_/g, ' ').toLowerCase());
  let s = '';
  if (inputs.length) s += `needs a ${inputs.join(' and ')} · `;
  s += `returns ${outputs.join(' and ')}`;
  if (outcomes.length) s += ` · knows about: ${outcomes.join(', ')}`;
  return s;
}

// Match a query to a capability (simple keyword match — no LLM needed for demo)
function matchQuery(query: string, siteFilter?: string) {
  const q = query.toLowerCase();
  let arts = loadArtifacts();
  if (siteFilter) arts = arts.filter((a: any) => a.app.id === siteFilter);
  // Score each artifact by keyword overlap with the query
  let best: any = null, bestScore = 0;
  for (const a of arts) {
    let score = 0;
    const words = [a.name, ...Object.keys(a.inputs), ...Object.keys(a.outputs),
      ...Object.keys(a.businessOutcomes || {}), a.app?.id].join(' ').toLowerCase();
    for (const w of q.split(/\s+/)) { if (words.includes(w)) score++; }
    // Check for member ID pattern in query
    const idMatch = q.match(/\b(\d{5})\b/);
    if (idMatch && a.inputs.memberId) score += 3;
    if (q.includes('savings') && a.name.includes('savings')) score += 5;
    if (q.includes('checking') && a.name.includes('checking')) score += 5;
    if (q.includes('loan') && a.name.includes('loan')) score += 5;
    if (q.includes('balance')) score += 2;
    if (q.includes('dense') && a.name.includes('dense')) score += 3;
    if (q.includes('harborview') && a.name.includes('harborview')) score += 5;
    if (q.includes('parabank') && a.name.includes('parabank')) score += 5;
    if (q.includes('altoro') && a.name.includes('altoro')) score += 5;
    if (q.includes('bill') && a.name.includes('bill')) score += 5;
    if (q.includes('overview') && a.name.includes('overview')) score += 5;
    if (score > bestScore) { best = a; bestScore = score; }
  }
  if (bestScore < 2) return null;
  // Extract params from query
  const params: Record<string, string> = {};
  const idMatch = q.match(/\b(\d{5})\b/);
  if (idMatch && best.inputs.memberId) params.memberId = idMatch[1];
  return { artifact: best, params, score: bestScore };
}

// ── HTML ─────────────────────────────────────────────────────

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'SF Mono',Consolas,monospace;background:#f0ece4;color:#1a1a1a;min-height:100vh}
a{color:#1a1a1a}
.top{background:#1a1a1a;color:#f0ece4;padding:10px 24px;display:flex;align-items:center;gap:20px;font-size:12px}
.top h1{font-size:14px;font-weight:700;letter-spacing:1px;margin-right:8px}
.top a{color:#aac;text-decoration:none;padding:4px 8px;border-radius:3px}
.top a.active{color:#fff;background:rgba(255,255,255,.1)}
.top .right{margin-left:auto;font-size:11px;opacity:.5}
.wrap{max-width:900px;margin:0 auto;padding:24px}
.wrap.wide{max-width:1100px}
/* ASK */
.ask-box{text-align:center;padding:60px 0 40px}
.ask-box h2{font-size:22px;font-weight:400;margin-bottom:20px;color:#555}
.ask-input{width:100%;max-width:600px;padding:14px 20px;font-family:inherit;font-size:15px;border:2px solid #ccc;border-radius:6px;outline:none;transition:border-color .2s}
.ask-input:focus{border-color:#1a1a1a}
.match-card{max-width:600px;margin:24px auto;text-align:left}
.stage{border:1px solid #d4d0c8;border-radius:6px;overflow:hidden;margin-bottom:2px}
.stage-header{padding:10px 16px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.stage-body{padding:16px;font-size:13px;line-height:1.7}
.stage.interpret{background:#fff}.stage.interpret .stage-header{background:#f8f6f2;color:#666}
.stage.execute{background:#f0f7f0}.stage.execute .stage-header{background:#e0efe0;color:#2e7d32}
.divider{text-align:center;padding:6px;font-size:10px;color:#888;letter-spacing:.5px}
.no-match{max-width:600px;margin:24px auto;padding:20px;background:#fff;border:1px solid #d4d0c8;border-radius:6px;text-align:left}
/* Cards */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.site-card{background:#fff;border:1px solid #d4d0c8;padding:20px;border-radius:6px;text-decoration:none;display:block;transition:box-shadow .2s}
.site-card:hover{box-shadow:0 2px 8px rgba(0,0,0,.08)}
.site-card h3{font-size:15px;margin-bottom:4px}
.site-card .desc{font-size:12px;color:#666;margin-bottom:10px}
.site-card .stats{font-size:11px;color:#888}
/* Tools */
.tool-row{padding:14px 16px;background:#fff;border:1px solid #d4d0c8;margin-bottom:-1px;font-size:13px;display:flex;align-items:center;gap:12px}
.tool-row:first-child{border-radius:6px 6px 0 0}.tool-row:last-child{border-radius:0 0 6px 6px;margin-bottom:0}
.tool-row .name{font-weight:700;min-width:120px}
.tool-row .sentence{flex:1;color:#555;font-size:12px}
.tool-row .badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px}
.tool-row .badge.approved{background:#c8e6c9;color:#2e7d32}
.tool-row .badge.manual{background:#fff3cd;color:#7c6f00}
/* Steps */
.step{padding:14px 16px;background:#fff;border:1px solid #d4d0c8;margin-bottom:-1px;font-size:13px;position:relative;padding-left:40px}
.step:first-child{border-radius:6px 6px 0 0}.step:last-child{border-radius:0 0 6px 6px}
.step .num{position:absolute;left:14px;top:14px;font-weight:700;color:#bbb;font-size:14px}
.step .human{font-weight:600}
.step .detail{font-size:11px;color:#888;margin-top:4px}
.step .risky{color:#c44;font-size:10px;font-weight:700}
.step.ok{border-left:4px solid #4caf50}.step.fail{border-left:4px solid #c44}
.step.recovered{border-left:4px solid #ff9800}.step.dim{opacity:.4}
.step .margin{float:right;font-size:10px;padding:1px 6px;border-radius:2px;background:#e8f5e9;color:#2e7d32}
.step .margin.warn{background:#fff3cd;color:#7c6f00}
/* Runs */
.run-row{padding:12px 16px;margin:6px 0;border:1px solid #d4d0c8;border-radius:6px;background:#fff;font-size:12px;display:flex;align-items:center;gap:12px;text-decoration:none;color:#1a1a1a;box-shadow:0 1px 3px rgba(0,0,0,0.06)}
.run-row:hover{background:#f0ede8;border-color:#b0a89c}
.run-row .status{min-width:110px;font-size:11px;font-weight:600}
.run-row .cap{flex:1;font-weight:600;color:#2c2c2c}.run-row .site{color:#555;font-size:11px;font-weight:500;background:#f5f3ef;padding:2px 8px;border-radius:3px}
.run-row .time{color:#888;font-size:10px;min-width:110px;text-align:right}
/* Result */
.result{padding:16px;border-radius:6px;margin:16px 0;font-size:14px;font-weight:600}
.result.SUCCESS{background:#e8f5e9;border:1px solid #4caf50;color:#2e7d32}
.result.BUSINESS_OUTCOME{background:#e3f2fd;border:1px solid #2196f3;color:#0d47a1}
.result.HARD_FAILURE{background:#ffebee;border:1px solid #c44;color:#b71c1c}
.result.ESCALATED{background:#fff3cd;border:1px solid #ff9800;color:#7c6f00}
.result pre{font-weight:400;font-size:12px;margin-top:8px}
/* Misc */
.recovery-event{background:#fff8e1;border:1px solid #ffc107;padding:8px 16px;margin:4px 0;border-radius:4px;font-size:11px}
.escalation-event{background:#fce4ec;border:1px solid #e91e63;padding:8px 16px;margin:4px 0;border-radius:4px;font-size:11px}
.section{margin:24px 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#888}
.btn{display:inline-block;font-family:inherit;font-size:12px;padding:6px 16px;border:1px solid #999;background:#fff;cursor:pointer;text-decoration:none;color:#1a1a1a;border-radius:3px}
.btn:hover{background:#f0ece4}
.btn.primary{background:#1a1a1a;color:#f0ece4;border-color:#1a1a1a}
.btn.danger{border-color:#c44;color:#c44}
.form-row{margin-bottom:12px}
.form-row label{display:block;font-size:12px;font-weight:700;margin-bottom:4px}
.form-row input,.form-row select,.form-row textarea{width:100%;padding:8px 12px;border:1px solid #ccc;border-radius:4px;font-family:inherit;font-size:13px}
details summary{cursor:pointer;font-size:11px;color:#888}
pre{background:#f8f6f2;padding:12px;border-radius:4px;overflow-x:auto;font-size:11px;white-space:pre-wrap;word-break:break-all}
.footer{text-align:center;padding:24px;font-size:10px;color:#bbb;margin-top:40px}
`;

function shell(title: string, body: string, active: string) {
  const pc = pausedCount();
  const badge = pc > 0 ? `<a href="/intervention" style="background:#ff5722;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;text-decoration:none;margin-left:8px;animation:pulse 2s infinite">${pc} needs you</a>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>${CSS}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}</style></head><body>
<div class="top">
  <h1>CONSOLE</h1>
  <a href="/" class="${active === 'ask' ? 'active' : ''}">Ask</a>
  <a href="/sites" class="${active === 'sites' ? 'active' : ''}">Sites</a>
  <a href="/runs" class="${active === 'runs' ? 'active' : ''}">Runs</a>
  ${badge}
  <span class="right">no auth · local demo</span>
</div>
<div class="wrap${active === 'sites' || active === 'runs' ? ' wide' : ''}">${body}</div>
<div class="footer">Single-operator demo tool. No authentication. Runs locally beside the credentials.</div>
${active === 'sites' || active === 'runs' ? '<script>setTimeout(()=>location.reload(),10000)</script>' : ''}
</body></html>`;
}

// ── ASK ──────────────────────────────────────────────────────

function renderAsk(query?: string, siteFilter?: string) {
  let response = '';
  if (query && query.trim()) {
    const match = matchQuery(query, siteFilter);
    if (match) {
      const a = match.artifact;
      const s = surfaceFor(a);
      const paramLines = Object.entries(match.params).map(([k, v]) => `<strong>${k}</strong> = ${v}`).join('<br>');
      const trustLine = a._trust.status === 'approved'
        ? `<span style="color:#2e7d32">✓ approved${a._trust.approvedBy ? ` by ${a._trust.approvedBy}` : ''}${a._trust.approvedAt ? ` · ${a._trust.approvedAt.substring(0, 10)}` : ''}</span>`
        : `<span style="color:#c44">⚠ not approved for production</span>`;

      if (a._trust.status === 'approved') {
        response = `<div class="match-card">
          <div class="stage interpret">
            <div class="stage-header">interpreting — an LLM chose the tool and filled the params</div>
            <div class="stage-body">
              <strong>matched</strong> <a href="/tool/${a._file}">${a.name}@${a.version}</a><br>
              <strong>site</strong> ${s.label || a.app.id}<br>
              ${paramLines ? paramLines + '<br>' : ''}
              ${trustLine}
              <div style="margin-top:12px">
                <form method="POST" action="/ask/run" style="display:inline">
                  <input type="hidden" name="artifact" value="${a._file}">
                  ${Object.entries(match.params).map(([k, v]) => `<input type="hidden" name="p_${k}" value="${v}">`).join('')}
                  <button class="btn primary" type="submit">Run</button>
                </form>
                <a class="btn" href="/tool/${a._file}" style="margin-left:8px">View script</a>
              </div>
            </div>
          </div>
          <div class="divider">↓ from here: no AI. deterministic replay.</div>
          <div class="stage execute">
            <div class="stage-header">executing — step-by-step, no model in the path</div>
            <div class="stage-body" style="color:#555">
              ${a.steps.length} steps: login → navigate → find element → read value → return result
            </div>
          </div>
        </div>`;
      } else {
        response = `<div class="no-match">
          <strong>${a.name}@${a.version}</strong> could do this, but no one has approved it.<br>
          <a class="btn" href="/tool/${a._file}" style="margin-top:10px;display:inline-block">Review & approve →</a>
        </div>`;
      }
    } else {
      // No match — offer to teach
      const surfaces = loadSurfaces();
      const siteOptions = Object.entries(surfaces).map(([k, v]: any) =>
        `<option value="${k}">${v.label || k}</option>`).join('');
      const teachSite = siteFilter ? `&site=${encodeURIComponent(siteFilter)}` : '';
      response = `<div class="no-match">
        <p>No capability covers that yet${siteFilter ? ` on ${(surfaces as any)[siteFilter]?.label || siteFilter}` : ''}.</p>
        <p style="margin-top:12px"><a class="btn primary" href="/teach?goal=${encodeURIComponent(query)}${teachSite}">Teach it →</a></p>
        <p style="font-size:11px;color:#888;margin-top:8px">The failed query becomes the discovery goal. An AI will explore the app and record a reusable script.</p>
      </div>`;
    }
  }

  const surfaces = loadSurfaces();
  const siteOptions = Object.entries(surfaces).map(([k, v]: any) =>
    `<option value="${k}" ${k === siteFilter ? 'selected' : ''}>${v.label || k}</option>`).join('');

  return shell('Ask', `
    <div class="ask-box">
      <h2>What do you need?</h2>
      <form method="GET" action="/" style="display:flex;gap:8px;justify-content:center;align-items:center;max-width:700px;margin:0 auto">
        <select name="site" style="padding:12px;font-family:inherit;font-size:13px;border:2px solid #ccc;border-radius:6px;background:#fff;min-width:180px">
          <option value="">Any site</option>
          ${siteOptions}
        </select>
        <input class="ask-input" name="q" placeholder="e.g. what's member 60020's savings balance" value="${(query || '').replace(/"/g, '&quot;')}" autofocus style="flex:1">
      </form>
    </div>
    ${response}`, 'ask');
}

// ── SITES ────────────────────────────────────────────────────

function renderSites() {
  const surfaces = loadSurfaces();
  const arts = loadArtifacts();
  const runs = loadRuns();
  let cards = '';
  for (const [id, s] of Object.entries(surfaces) as any[]) {
    const siteArts = arts.filter((a: any) => a.app.id === id);
    const approved = siteArts.filter((a: any) => a._trust.status === 'approved').length;
    const siteRuns = runs.filter((r: any) => siteArts.some((a: any) => r.capability.includes(a.name)));
    const lastRun = siteRuns[0];
    const lastStatus = lastRun?.result?.status;
    const lastLabel = lastStatus === 'SUCCESS' ? '✓' : lastStatus === 'HARD_FAILURE' ? '✗' : lastStatus ? '~' : '';

    cards += `<a class="site-card" href="/site/${id}">
      <h3>${s.label || id}</h3>
      <div class="desc">${s.description || ''}</div>
      <div class="stats">
        ${siteArts.length} tools · ${approved} approved
        ${lastRun ? ` · last run ${lastLabel}` : ''}
      </div>
    </a>`;
  }
  return shell('Sites', `
    <h2 style="margin-bottom:16px">What we automate</h2>
    <div class="cards">${cards || '<p style="color:#888">No sites configured.</p>'}</div>`, 'sites');
}

function renderSite(siteId: string) {
  const surfaces = loadSurfaces();
  const s = (surfaces as any)[siteId];
  if (!s) return shell('Not Found', '<p>Site not found.</p>', 'sites');
  const arts = loadArtifacts().filter((a: any) => a.app.id === siteId);
  const runs = loadRuns().filter((r: any) => arts.some((a: any) => r.capability.includes(a.name))).slice(0, 10);
  const errLib = resolve(ROOT, 'errors', `${siteId}.json`);
  let errEntries: any = {};
  if (existsSync(errLib)) { try { errEntries = JSON.parse(readFileSync(errLib, 'utf8')); } catch {} }

  let tools = '';
  for (const a of arts) {
    const badge = a._trust.status === 'approved' ? '<span class="badge approved">approved</span>' : '<span class="badge manual">awaiting approval</span>';
    tools += `<div class="tool-row">
      <a class="name" href="/tool/${a._file}">${a.name}</a>
      <span class="sentence">${toolSentence(a)}</span>
      ${badge}
    </div>`;
  }

  let recentRuns = runs.map((r: any) => {
    const st = r.result?.status;
    const icon = st === 'SUCCESS' ? '✅' : st === 'BUSINESS_OUTCOME' ? '📋' : st === 'HARD_FAILURE' ? '❌' : '⏳';
    return `<a class="run-row" href="/run/${r.dir}">
      <span class="status">${icon} ${st || 'running'}</span>
      <span class="cap">${r.capability}</span>
      <span class="time">${r.dir.substring(0, 19).replace('T', ' ')}</span>
    </a>`;
  }).join('');

  let errSection = '';
  if (Object.keys(errEntries).length > 0) {
    errSection = Object.entries(errEntries).map(([name, e]: any) => {
      const detect = e.detect?.textPresent ? `looks for "${e.detect.textPresent}"` : JSON.stringify(e.detect);
      return `<div style="font-size:12px;margin:4px 0">⚡ <strong>${name.replace(/_/g, ' ')}</strong> — ${detect} → ${e.recovery.length} recovery steps, retry once</div>`;
    }).join('');
  }

  // Check for overlays
  const overlayDir = resolve(ROOT, 'capabilities/overlays');
  let overlayInfo = '';
  if (existsSync(overlayDir)) {
    const overlays = readdirSync(overlayDir).filter(f => f.includes(s.tenant || siteId));
    if (overlays.length > 0) overlayInfo = `<div style="font-size:12px;color:#666;margin-top:8px">${overlays.length} vocabulary overlay(s) — maps terms like "Member" → "Customer" so the same scripts work across tenants</div>`;
  }

  return shell(s.label || siteId, `
    <div style="margin-bottom:12px"><a href="/sites" style="font-size:12px;color:#666">← Sites</a></div>
    <h2>${s.label || siteId}</h2>
    <p style="font-size:13px;color:#666;margin-bottom:20px">${s.description || ''} · ${s.baseUrl}${s.tenant ? ` · tenant: ${s.tenant}` : ''}</p>

    <div class="section">Tools (${arts.length})</div>
    ${tools || '<p style="font-size:12px;color:#888">No tools for this site yet.</p>'}
    <div style="margin-top:12px"><a class="btn" href="/teach?site=${siteId}">Teach a new tool</a></div>

    ${recentRuns ? `<div class="section">Recent runs</div>${recentRuns}` : ''}

    <div class="section">How this site is handled</div>
    <div style="font-size:12px;color:#666;background:#fff;padding:12px;border:1px solid #d4d0c8;border-radius:6px">
      <strong>Base URL:</strong> ${s.baseUrl}<br>
      ${s.tenant ? `<strong>Tenant:</strong> ${s.tenant}<br>` : ''}
      <strong>Credentials:</strong> from environment (CONSOLE_USER, CONSOLE_PASS)<br>
      ${errSection || '<div style="margin-top:4px;color:#888">No error recovery rules configured.</div>'}
      ${overlayInfo}
    </div>`, 'sites');
}

// ── TOOL (artifact) ──────────────────────────────────────────

function renderTool(file: string) {
  const fPath = resolve(ROOT, 'capabilities', file);
  if (!existsSync(fPath)) return shell('Not Found', '<p>Tool not found.</p>', 'sites');
  const art = JSON.parse(readFileSync(fPath, 'utf8'));
  const t = loadTrust()[trustKey(art.name, art.version)] ?? { status: 'manual' };
  const s = surfaceFor(art);

  // Build step list in plain English
  let steps = '';
  for (let i = 0; i < art.steps.length; i++) {
    const step = art.steps[i];
    const v = step.action.verb;
    const val = step.action.value;
    const props = step.target.properties;

    // Human-readable action
    let human = '';
    if (v === 'navigate') human = `Go to <code>${val}</code>`;
    else if (v === 'type') {
      const what = val && typeof val === 'object' && val.$input ? val.$input : `"${val}"`;
      const where = props.name ? `"${props.name}"` : props.attrName ? `form field ${props.attrName}` : 'a field';
      human = `Type the <strong>${what}</strong> into ${where}`;
    }
    else if (v === 'click') { human = `Click <strong>${props.name || 'a button'}</strong>`; }
    else if (v === 'select') { human = `Select "${val}" from a dropdown`; }
    else if (v === 'read') {
      const col = props.columnHeader ? ` in the "${props.columnHeader}" column` : '';
      human = `Read the value${col} and save it as <strong>${step.action.saveTo}</strong>`;
    }

    // Proof
    let proof = '';
    const ex = step.expect;
    if (ex.textPresent) proof = `page shows "${ex.textPresent}"`;
    else if (ex.elementValue) proof = 'the field contains what was typed';
    else if (ex.outputPopulated) proof = `${ex.outputPopulated} now has a value`;
    else if (ex.anyOf) proof = 'one of the expected conditions is met';

    const risky = step.risk === 'risky' ? ' <span class="risky">⚠ irreversible</span>' : '';
    const outcomes = JSON.stringify(ex).includes('$outcome')
      ? Object.keys(art.businessOutcomes || {}).map((c: string) =>
        `<div class="detail" style="color:#2196f3">↗ possible answer: "${c.replace(/_/g, ' ').toLowerCase()}"</div>`).join('') : '';

    steps += `<div class="step">
      <span class="num">${i + 1}</span>
      <span class="human">${human}</span>${risky}
      <div class="detail">✓ ${proof || '—'}</div>
      ${outcomes}
      <details><summary>how it finds the element</summary>
      <pre>${JSON.stringify(props, null, 2)}</pre></details>
    </div>`;
  }

  // Inputs / outputs in plain language
  const inputs = Object.entries(art.inputs)
    .filter(([k]) => k !== 'username' && k !== 'password')
    .map(([k, v]: any) => `<strong>${k}</strong> — ${v.type}${v.pattern ? ` (${v.pattern})` : ''}`).join('<br>');
  const secrets = Object.entries(art.inputs).filter(([, v]: any) => v.sensitive).map(([k]) => k);
  const outputs = Object.entries(art.outputs).map(([k, v]: any) => `<strong>${k}</strong> — ${v.type}`).join('<br>');
  const outcomes = Object.keys(art.businessOutcomes || {});
  const badge = t.status === 'approved' ? '<span class="badge approved">approved</span>' : '<span class="badge manual">awaiting approval</span>';

  return shell(art.name, `
    <div style="margin-bottom:12px"><a href="/site/${art.app.id}" style="font-size:12px;color:#666">← ${s.label || art.app.id}</a></div>
    <h2 style="display:flex;align-items:center;gap:10px">${art.name} <span style="font-size:12px;color:#999;font-weight:400">v${art.version}</span> ${badge}</h2>
    <p style="font-size:13px;color:#666;margin:8px 0 20px">
      ${toolSentence(art)} · runs on ${s.label || art.app.id}
    </p>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:24px;background:#fff;padding:16px;border:1px solid #d4d0c8;border-radius:6px">
      <div><div class="section" style="margin-top:0">It needs</div>
        ${inputs || '<span style="font-size:12px;color:#888">nothing besides credentials</span>'}
        ${secrets.length ? `<div style="font-size:10px;color:#888;margin-top:6px">🔒 ${secrets.join(', ')} from environment</div>` : ''}</div>
      <div><div class="section" style="margin-top:0">It returns</div><span style="font-size:12px">${outputs}</span></div>
      <div>${outcomes.length ? `<div class="section" style="margin-top:0">Known answers</div><span style="font-size:12px">${outcomes.map(o => '"' + o.replace(/_/g, ' ') + '"').join(', ')}</span><div style="font-size:10px;color:#888;margin-top:4px">reported as data, not errors</div>` : ''}</div>
    </div>

    <div class="section">The script — ${art.steps.length} steps, no AI involved</div>
    ${steps}

    <div style="margin-top:20px;display:flex;gap:8px;align-items:center">
      ${t.status === 'approved'
        ? `<form method="POST" action="/revoke"><input type="hidden" name="name" value="${art.name}"><input type="hidden" name="version" value="${art.version}"><button class="btn danger" type="submit">Revoke approval</button></form>`
        : `<form method="POST" action="/approve" style="display:flex;gap:6px;align-items:center">
            <input type="hidden" name="name" value="${art.name}"><input type="hidden" name="version" value="${art.version}">
            <input name="note" placeholder="Reason (optional)" style="padding:6px 10px;border:1px solid #ccc;border-radius:3px;font-family:inherit;font-size:12px">
            <button class="btn primary" type="submit">Approve for production</button></form>`}
    </div>

    <details style="margin-top:24px"><summary>raw artifact JSON</summary><pre>${JSON.stringify(art, null, 2)}</pre></details>`, 'sites');
}

// ── TEACH ────────────────────────────────────────────────────

function renderTeach(goal?: string, siteId?: string) {
  const surfaces = loadSurfaces();
  const siteOptions = Object.entries(surfaces).map(([k, v]: any) =>
    `<option value="${k}" ${k === siteId ? 'selected' : ''}>${v.label || k}</option>`).join('');

  return shell('Teach', `
    <div style="margin-bottom:12px"><a href="/sites" style="font-size:12px;color:#666">← Sites</a></div>
    <h2>Teach a new tool</h2>
    <p style="font-size:13px;color:#666;margin-bottom:20px">Tell the system what to learn. An AI will explore the site and record a reusable script.</p>

    <div style="max-width:500px">
      <form method="POST" action="/teach/start">
        <div class="form-row">
          <label>What should it learn to do?</label>
          <input name="goal" required placeholder="e.g. look up a member's checking balance" value="${(goal || '').replace(/"/g, '&quot;')}">
        </div>
        <div class="form-row">
          <label>On which site?</label>
          <select name="site" required>${siteOptions}</select>
        </div>
        <button class="btn primary" type="submit">Start discovery</button>
      </form>
    </div>`, 'sites');
}

// ── RUNS ─────────────────────────────────────────────────────

function renderRuns(nameFilter?: string, siteFilter?: string, statusFilter?: string, typeFilter?: string) {
  let allRuns = loadRuns(nameFilter);
  const surfaces = loadSurfaces();
  const arts = loadArtifacts();
  const icons: Record<string, string> = { SUCCESS: '✅', BUSINESS_OUTCOME: '📋', HARD_FAILURE: '❌', ESCALATED: '🤝', COMPILED: '🔧', DEAD_END: '🚫', ABORTED: '⛔', INCOMPLETE: '⚪' };

  // Enrich runs with site info — try artifact match first, then journal URL
  const enriched = allRuns.map(r => {
    let art = arts.find((a: any) => r.capability === a.name);
    if (!art) art = arts.find((a: any) => r.capability.includes(a.name));
    let siteId = art?.app?.id || '';
    let siteLabel = art ? (surfaceFor(art).label || siteId) : '';

    // Fallback: infer site from the journal's first navigate URL
    if (!siteId) {
      const jPath = join(resolve(ROOT, 'evidence/runs'), r.dir, 'journal.jsonl');
      if (existsSync(jPath)) {
        const firstLines = readFileSync(jPath, 'utf8').substring(0, 2000);
        for (const [sid, s] of Object.entries(surfaces) as any[]) {
          if (firstLines.includes(s.baseUrl) || (s.tenant && firstLines.includes(s.tenant))) {
            siteId = sid; siteLabel = s.label || sid; break;
          }
        }
      }
    }

    const st = r.result?.status || 'running';
    // Detect run type from journal
    const jPath2 = join(resolve(ROOT, 'evidence/runs'), r.dir, 'journal.jsonl');
    let runType: 'discovery' | 'replay' = 'replay';
    if (existsSync(jPath2)) {
      const first500 = readFileSync(jPath2, 'utf8').substring(0, 500);
      if (first500.includes('"discovery_start"')) runType = 'discovery';
    }
    return { ...r, siteId, siteLabel, st, runType };
  });

  // Apply filters
  let filtered = enriched;
  if (typeFilter) filtered = filtered.filter(r => r.runType === typeFilter);
  if (siteFilter) filtered = filtered.filter(r => r.siteId === siteFilter);
  if (statusFilter) filtered = filtered.filter(r => r.st === statusFilter);

  let rows = filtered.map(r => {
    const icon = icons[r.st] || '⏳';
    const recoveredTag = r.recovered ? ' <span style="font-size:9px;padding:1px 5px;background:#e8f5e9;border:1px solid #4caf50;border-radius:3px;color:#2e7d32;margin-left:2px">↻ recovered</span>' : '';
    const outcome = r.result?.code ? ` — ${r.result.code.replace(/_/g, ' ').toLowerCase()}`
      : r.result?.reason ? ` — ${r.result.reason}` : '';
    const typeBadge = r.runType === 'discovery'
      ? '<span style="font-size:9px;padding:1px 5px;background:#fff3e0;border:1px solid #e65100;border-radius:3px;color:#e65100;margin-right:4px">DISCOVER</span>'
      : '<span style="font-size:9px;padding:1px 5px;background:#e3f2fd;border:1px solid #1565c0;border-radius:3px;color:#1565c0;margin-right:4px">REPLAY</span>';
    return `<a class="run-row" href="/run/${r.dir}">
      <span class="status">${typeBadge}${icon} ${r.st}${recoveredTag}${outcome}</span>
      <span class="cap">${r.capability}</span>
      <span class="site">${r.siteLabel}</span>
      <span class="time">${r.dir.substring(0, 19).replace('T', ' ')}</span>
    </a>`;
  }).join('');

  // Build filter controls
  const siteOptions = Object.entries(surfaces).map(([k, v]: any) =>
    `<option value="${k}" ${k === siteFilter ? 'selected' : ''}>${v.label || k}</option>`).join('');

  const statusLabels: Record<string, string> = { COMPILED: 'Discovery compiled', DEAD_END: 'Discovery dead end', ABORTED: 'Discovery aborted', INCOMPLETE: 'Incomplete', running: 'Running' };
  const statusOptions = ['SUCCESS', 'BUSINESS_OUTCOME', 'HARD_FAILURE', 'ESCALATED', 'COMPILED', 'DEAD_END', 'ABORTED', 'INCOMPLETE', 'running'].map(s =>
    `<option value="${s}" ${s === statusFilter ? 'selected' : ''}>${icons[s] || '⏳'} ${statusLabels[s] || s}</option>`).join('');

  const hasFilters = nameFilter || siteFilter || statusFilter || typeFilter;

  // Counts for summary
  const counts: Record<string, number> = {};
  for (const r of enriched) counts[r.st] = (counts[r.st] || 0) + 1;
  const countBadges = Object.entries(counts).map(([st, n]) =>
    `<span style="font-size:11px;margin-right:8px;${st === statusFilter ? 'font-weight:700' : 'opacity:.6'}">${icons[st] || '⏳'} ${n}</span>`).join('');

  return shell('Runs', `
    <h2>What happened</h2>
    <p style="font-size:13px;color:#666;margin-bottom:8px">Every execution — CLI, MCP, or console — is journaled here.</p>
    <div style="margin-bottom:12px">${countBadges}</div>
    <form style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select name="type" style="padding:6px 10px;border:1px solid #ccc;border-radius:3px;font-family:inherit;font-size:12px">
        <option value="">All types</option>
        <option value="discovery" ${typeFilter === 'discovery' ? 'selected' : ''}>🔍 Discovery</option>
        <option value="replay" ${typeFilter === 'replay' ? 'selected' : ''}>▶ Replay</option>
      </select>
      <select name="site" style="padding:6px 10px;border:1px solid #ccc;border-radius:3px;font-family:inherit;font-size:12px">
        <option value="">All sites</option>
        ${siteOptions}
      </select>
      <select name="status" style="padding:6px 10px;border:1px solid #ccc;border-radius:3px;font-family:inherit;font-size:12px">
        <option value="">All outcomes</option>
        ${statusOptions}
      </select>
      <input name="q" placeholder="Capability name..." value="${nameFilter ?? ''}" style="padding:6px 10px;border:1px solid #ccc;border-radius:3px;font-family:inherit;font-size:12px;width:200px">
      <button class="btn" type="submit">Filter</button>
      ${hasFilters ? '<a class="btn" href="/runs">Clear all</a>' : ''}
    </form>
    <div>${rows || '<p style="color:#888">No runs match these filters.</p>'}</div>`, 'runs');
}

function mdToHtml(md: string): string {
  // Minimal markdown→HTML for report rendering (no deps)
  return md
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^\|(.+)\|$/gm, (_, row) => {
      const cells = row.split('|').map((c: string) => c.trim());
      if (cells.every((c: string) => /^-+$/.test(c))) return '';  // separator row
      return '<tr>' + cells.map((c: string) => `<td style="padding:6px 10px;border:1px solid #d4d0c8">${c}</td>`).join('') + '</tr>';
    })
    .replace(/((?:<tr>.*<\/tr>\n?)+)/g, '<table style="border-collapse:collapse;font-size:12px;margin:12px 0;background:#fafaf8;border-radius:4px;overflow:hidden">$1</table>')
    .replace(/^- \[ \] (.+)$/gm, '<div style="margin:2px 0"><input type="checkbox" disabled> $1</div>')
    .replace(/^- (.+)$/gm, '<div style="margin:2px 0;padding-left:12px">• $1</div>')
    .replace(/^\d+\. (.+)$/gm, '<div style="margin:2px 0;padding-left:12px">$1</div>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:#f5f5f5;padding:1px 4px;border-radius:2px">$1</code>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '\n');
}

function renderRun(runDir: string) {
  // Check for report.md first — the canonical human-facing document
  const reportPath = resolve(ROOT, 'evidence/runs', runDir, 'report.md');
  if (existsSync(reportPath)) {
    const reportMd = readFileSync(reportPath, 'utf8');
    const capName = runDir.split('-').slice(7).join('-');
    return shell(`Run: ${capName}`, `
      <div style="margin-bottom:12px"><a href="/runs" style="font-size:12px;color:#666">← Runs</a></div>
      <div style="background:#fff;border:1px solid #d4d0c8;border-radius:8px;padding:24px 32px;margin:12px 0;max-width:850px;box-shadow:0 2px 8px rgba(0,0,0,0.06);font-family:inherit;line-height:1.7">${mdToHtml(reportMd)}</div>
      <details style="margin-top:16px"><summary style="cursor:pointer;font-size:11px;color:#888">Raw journal (${loadJournal(runDir).length} events)</summary>
        <pre style="font-size:9px;margin-top:4px;color:#666;max-height:400px;overflow:auto;background:#fff;border:1px solid #ddd;border-radius:4px;padding:12px">${loadJournal(runDir).map((e: any) => JSON.stringify(e)).join('\n')}</pre>
      </details>`, 'runs');
  }

  // Fallback: bespoke rendering for old runs without report.md
  const events = loadJournal(runDir);
  const rPath = resolve(ROOT, 'evidence/runs', runDir, 'result.json');
  let result: any = null;
  if (existsSync(rPath)) { try { result = JSON.parse(readFileSync(rPath, 'utf8')); } catch {} }
  const capName = runDir.split('-').slice(7).join('-');
  const allArts = loadArtifacts();
  let art = allArts.find((a: any) => a.name === capName) || allArts.find((a: any) => capName.includes(a.name));
  let site = art ? surfaceFor(art) : { label: '', baseUrl: '' };
  // Fallback: infer site from journal URL
  if (!site.label) {
    const surfaces = loadSurfaces();
    const jFirst = events.slice(0, 5).map((e: any) => JSON.stringify(e)).join(' ');
    for (const [, s] of Object.entries(surfaces) as any[]) {
      if (jFirst.includes(s.baseUrl) || (s.tenant && jFirst.includes(s.tenant))) { site = s; break; }
    }
  }

  // Result box — uses the canonical describer (one source, three surfaces)
  let resultHtml = '';
  if (result) {
    const described = describeReplayResult(result, { capabilityName: capName, recovered: result.recovered });
    const st = result.status;
    const outputs = result.outputs ? `<pre>${JSON.stringify(result.outputs, null, 2)}</pre>` : '';
    resultHtml = `<div class="result ${st}">
      <div>${described.summary}</div>
      ${described.detail ? `<div style="font-size:12px;font-weight:400;margin-top:6px">${described.detail}</div>` : ''}
      ${outputs}
      ${described.nextActions.length ? `<div style="font-size:11px;font-weight:400;margin-top:8px;color:#555">${described.nextActions.map(a => `→ ${a}`).join('<br>')}</div>` : ''}
    </div>`;
  }

  // Recovery/escalation events
  let timeline = '';
  for (const ev of events) {
    if (ev.event === 'error_detected') timeline += `<div class="recovery-event">⚡ Error detected: <strong>${ev.error}</strong> at ${ev.stepId}</div>`;
    if (ev.event === 'recovery_step') timeline += `<div class="recovery-event">↻ Recovery: ${ev.verb} (${ev.stepId})</div>`;
    if (ev.event === 'recovery_complete') timeline += `<div class="recovery-event">✓ Recovery complete — retrying</div>`;
    if (ev.event === 'control_transfer') timeline += `<div class="escalation-event">🤝 Control → ${ev.to === 'human' ? '<strong>HUMAN</strong>' : '<strong>MACHINE</strong>'}${ev.reason ? `: ${ev.reason}` : ''}</div>`;
    if (ev.event === 'window_before') timeline += `<div class="escalation-event" style="background:#f3e5f5;border-color:#9c27b0">📸 Before: ${ev.url} · ${ev.elements} elements${(ev.headings as string[])?.length ? ` · headings: ${(ev.headings as string[]).join(', ')}` : ''}</div>`;
    if (ev.event === 'human_actions') {
      const sum = (ev.summary as string) || 'no observable change';
      const style = sum === 'no observable change' ? 'background:#fff3cd;border-color:#ff9800' : 'background:#e8f5e9;border-color:#4caf50';
      timeline += `<div class="escalation-event" style="${style}">👤 What changed: <strong>${sum}</strong></div>`;
    }
    if (ev.event === 'window_after') timeline += `<div class="escalation-event" style="background:#f3e5f5;border-color:#9c27b0">📸 After: ${ev.url} · ${ev.elements} elements</div>`;
    if (ev.event === 'handback') timeline += `<div class="escalation-event">↩ Handback: <strong>${ev.claim}</strong>${ev.notes ? ` — ${ev.notes}` : ''}</div>`;
    if (ev.event === 'handback_rejected') timeline += `<div class="escalation-event" style="background:#ffebee;border-color:#c44">❌ Claim rejected: ${ev.claim} — ${ev.reason}</div>`;
    if (ev.event === 'outcome_detected') timeline += `<div style="padding:8px 16px;margin:4px 0;background:#e3f2fd;border:1px solid #2196f3;border-radius:4px;font-size:11px">📋 Business answer: <strong>${ev.code}</strong></div>`;
  }

  // ── Detect run type: replay (has step_start events) vs discovery (has observed events) ──
  const isReplay = events.some((e: any) => e.event === 'step_start');
  const isDiscovery = !isReplay && events.some((e: any) => e.event === 'discovery_start');

  let steps = '';

  if (isReplay) {
    // Replay run — group by step_start
    const stepStarts = events.filter((e: any) => e.event === 'step_start');
    const passed = new Set(events.filter((e: any) => e.event === 'expect_passed').map((e: any) => e.stepId));
    const scoring = events.filter((e: any) => e.event === 'scoring_result');
    const recovered = new Set(events.filter((e: any) => e.event === 'recovery_complete').map((e: any) => e.stepId));

    const stepEvents: Record<string, any[]> = {};
    let currentStepId = '';
    for (const ev of events) {
      if (ev.event === 'step_start') { currentStepId = ev.stepId; stepEvents[currentStepId] = []; }
      if (currentStepId && stepEvents[currentStepId]) stepEvents[currentStepId].push(ev);
    }

    const artSteps = art?.steps || [];

    steps = stepStarts.map((ss: any, i: number) => {
      const cls = recovered.has(ss.stepId) ? 'recovered' : passed.has(ss.stepId) ? 'ok' : (result?.stepId === ss.stepId ? 'fail' : 'dim');
      const sc = scoring.find((s: any) => s.stepId === ss.stepId);
      let marginHtml = '';
      if (sc && typeof sc.margin === 'number') {
        const warn = sc.margin < 0.15 ? ' warn' : '';
        marginHtml = `<span class="margin${warn}">margin ${sc.margin.toFixed(3)}${warn ? ' ← thin win' : ''}</span>`;
      }

      const evs = stepEvents[ss.stepId] || [];
      const acted = evs.find((e: any) => e.event === 'acted');
      const observed = evs.find((e: any) => e.event === 'observed');
      const navigate = evs.find((e: any) => e.event === 'navigate');

      let detailParts: string[] = [];
      if (acted) detailParts.push(`<strong>${acted.verb}</strong>`);
      if (navigate) detailParts.push(`→ ${navigate.path}`);
      if (observed) detailParts.push(`${observed.elements} elements on page`);
      if (sc) detailParts.push(`score: ${sc.topScore?.toFixed(1)} · role: ${sc.matchedRole}`);
      const detailLine = detailParts.length ? `<div class="detail">${detailParts.join(' · ')}</div>` : '';

      const artStep = artSteps.find((s: any) => s.id === ss.stepId);
      let schemaDropdown = '';
      if (artStep) {
        schemaDropdown = `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:10px;color:#888">Schema</summary>
          <pre style="font-size:10px;margin-top:4px">${JSON.stringify({ action: artStep.action, target: artStep.target?.properties, expect: artStep.expect, risk: artStep.risk }, null, 2)}</pre></details>`;
      }

      const transcriptLines = evs.filter((e: any) => e.event !== 'step_start').map((e: any) => {
        const ts = e.timestamp ? e.timestamp.substring(11, 19) : '';
        return `${ts} ${e.event}${e.verb ? ' verb=' + e.verb : ''}${e.margin != null ? ' margin=' + Number(e.margin).toFixed(3) : ''}${e.error ? ' error=' + e.error : ''}${e.claim ? ' claim=' + e.claim : ''}`;
      }).join('\n');

      let transcriptDropdown = '';
      if (transcriptLines) {
        transcriptDropdown = `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:10px;color:#888">Transcript (${evs.length - 1} events)</summary>
          <pre style="font-size:9px;margin-top:4px;color:#666">${transcriptLines}</pre></details>`;
      }

      return `<div class="step ${cls}"><span class="num">${i + 1}</span>${marginHtml}<strong>${ss.stepId}</strong> — ${ss.intent || ''}${detailLine}${schemaDropdown}${transcriptDropdown}</div>`;
    }).join('');

  } else if (isDiscovery) {
    // Discovery run — group by observed events
    const dStart = events.find((e: any) => e.event === 'discovery_start');
    const goalStr = dStart?.goal || '';
    const tokenSum = events.find((e: any) => e.event === 'token_summary');
    const compiled = events.find((e: any) => e.event === 'compiled');

    // Infer status from journal
    const deadEnd = events.find((e: any) => e.event === 'dead_end');
    const aborted = events.find((e: any) => e.event === 'aborted');
    const statusStr = compiled ? 'COMPILED' : deadEnd ? 'DEAD END' : aborted ? 'ABORTED' : (tokenSum ? 'FINISHED' : 'RUNNING');
    const statusCls = compiled ? 'ok' : 'fail';

    if (!result) {
      resultHtml = `<div class="result ${statusCls}" style="margin-bottom:16px">
        <div><strong>Discovery ${statusStr}</strong>${goalStr ? ` — "${goalStr}"` : ''}</div>
        ${deadEnd ? `<div style="font-size:12px;font-weight:400;margin-top:4px">Reason: ${deadEnd.reason || 'unknown'}</div>` : ''}
        ${aborted ? `<div style="font-size:12px;font-weight:400;margin-top:4px">Reason: ${aborted.reason || 'unknown'}</div>` : ''}
        ${compiled ? `<div style="font-size:12px;font-weight:400;margin-top:4px">Artifact saved: ${compiled.path}</div>` : ''}
        ${tokenSum ? `<div style="font-size:11px;font-weight:400;margin-top:4px;color:#888">Tokens: ${tokenSum.totalTokens} (prompt: ${tokenSum.promptTokens}, completion: ${tokenSum.completionTokens})</div>` : ''}
      </div>`;
    }

    // Build step trace from observed/decision/step_ok events — full observe→decide→act
    const observedEvs = events.filter((e: any) => e.event === 'observed');
    steps = observedEvs.map((obs: any, i: number) => {
      const stepNum = obs.step;
      const obsIdx = events.indexOf(obs);
      const nextObsIdx = i + 1 < observedEvs.length ? events.indexOf(observedEvs[i + 1]) : events.length;
      const stepEvs = events.slice(obsIdx, nextObsIdx);

      const decision = stepEvs.find((e: any) => e.event === 'decision');
      const acted = stepEvs.find((e: any) => e.event === 'step_ok' || e.event === 'step_ok_fallback');
      const nav = stepEvs.find((e: any) => e.event === 'navigate');
      const warn = stepEvs.find((e: any) => e.event === 'same_action_warning');
      const refused = stepEvs.find((e: any) => e.event === 'refusal');
      const resolveFail = stepEvs.find((e: any) => e.event === 'resolve_failed');
      const resolveOk = stepEvs.find((e: any) => e.event === 'resolve_result');
      const actResult = stepEvs.find((e: any) => e.event === 'act_result');
      const actError = stepEvs.find((e: any) => e.event === 'act_error');
      const expectFail = stepEvs.find((e: any) => e.event === 'expect_failed');

      // Derive verb/target from decision (new runs) or fallback to act_result/warn (old runs)
      const verb = decision?.verb || actResult?.verb || acted?.verb || nav?.verb || '?';
      const targetName = decision?.targetName || (warn?.verbTarget?.split(':')[1]) || '';
      const intent = decision?.intent || nav?.intent || '';

      const cls = refused || resolveFail || actError || expectFail ? 'fail' : acted ? 'ok' : 'dim';

      // OBSERVE
      let html = `<div class="detail" style="margin-top:8px;padding:6px 8px;background:#e3f2fd;border-left:3px solid #1565c0"><strong>OBSERVE</strong> — what the agent saw</div>`;
      html += `<div class="detail" style="padding-left:12px"><code>${obs.url}</code></div>`;
      html += `<div class="detail" style="padding-left:12px">${obs.elements} elements on page${obs.iframeElements ? ` (${obs.iframeElements} in iframes)` : ''}</div>`;
      if (obs.headings?.length) html += `<div class="detail" style="padding-left:12px">Headings: <strong>${(obs.headings as string[]).join('</strong>, <strong>')}</strong></div>`;
      if (obs.fields?.length) html += `<div class="detail" style="padding-left:12px">Form fields: ${(obs.fields as string[]).join(', ')}</div>`;
      if (obs.buttons?.length) html += `<div class="detail" style="padding-left:12px">Clickable: ${(obs.buttons as string[]).slice(0, 8).join(', ')}${(obs.buttons as string[]).length > 8 ? ` (+${(obs.buttons as string[]).length - 8} more)` : ''}</div>`;

      // DECIDE
      html += `<div class="detail" style="margin-top:8px;padding:6px 8px;background:#fff3e0;border-left:3px solid #e65100"><strong>DECIDE</strong> — what the LLM chose</div>`;
      if (decision?.tool === 'done') {
        html += `<div class="detail" style="padding-left:12px">→ <strong>done</strong>${decision.summary ? `: "${decision.summary}"` : ''}</div>`;
      } else {
        html += `<div class="detail" style="padding-left:12px">Action: <strong>${verb}</strong>${targetName ? ` on "<strong>${targetName}</strong>"` : ''}${decision?.value ? ` with value "${decision.value}"` : ''}</div>`;
        if (intent) html += `<div class="detail" style="padding-left:12px;font-style:italic;color:#555">"${intent}"</div>`;
        if (decision?.outputName) html += `<div class="detail" style="padding-left:12px">Save result to: <strong>${decision.outputName}</strong></div>`;
        if (decision?.targetRole) html += `<div class="detail" style="padding-left:12px;color:#888">Target role: ${decision.targetRole}</div>`;
      }

      // ACT
      html += `<div class="detail" style="margin-top:8px;padding:6px 8px;background:#e8f5e9;border-left:3px solid #2e7d32"><strong>ACT</strong> — what happened</div>`;
      if (nav) html += `<div class="detail" style="padding-left:12px">Navigated to <code>${nav.path}</code></div>`;
      if (resolveOk) html += `<div class="detail" style="padding-left:12px">Element found: ✓ ${resolveOk.kind}${resolveOk.chainLen ? ` (${resolveOk.chainLen} properties matched)` : ''}</div>`;
      if (resolveFail) html += `<div class="detail" style="padding-left:12px;color:#c44">Element NOT found: ✗ ${resolveFail.kind}</div>`;
      if (actResult) {
        html += `<div class="detail" style="padding-left:12px">${actResult.ok ? '✓' : '✗'} Executed <strong>${actResult.verb}</strong>`;
        if (actResult.readValue != null) html += ` → read: <code>"${String(actResult.readValue).substring(0, 120)}"</code>`;
        html += `</div>`;
      }
      if (actError) html += `<div class="detail" style="padding-left:12px;color:#c44">✗ Failed: ${actError.error}</div>`;
      if (refused) html += `<div class="detail" style="padding-left:12px;color:#c44">✗ Blocked by policy rule: <code>${refused.rule}</code></div>`;
      if (warn) html += `<div class="detail" style="padding-left:12px;color:#ff9800">⚠ Same action repeated: ${warn.verbTarget}</div>`;

      // RESULT
      if (acted) {
        const fb = acted.fallbackExpect ? ` (fallback condition: ${JSON.stringify(acted.fallbackExpect)})` : '';
        html += `<div class="detail" style="padding-left:12px;color:#2e7d32;font-weight:bold">✓ Step passed${fb}</div>`;
      } else if (expectFail) {
        html += `<div class="detail" style="padding-left:12px;color:#c44;font-weight:bold">✗ Expected page state not reached</div>`;
      }

      // Raw transcript — full JSON per event, not abbreviated
      const transcriptLines = stepEvs.map((e: any) => JSON.stringify(e, null, 0)).join('\n');
      html += `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:10px;color:#888">Full event log (${stepEvs.length} events)</summary>
        <pre style="font-size:9px;margin-top:4px;color:#666;white-space:pre-wrap;word-break:break-all">${transcriptLines}</pre></details>`;

      // Step header
      const stepTitle = intent ? `${verb} — ${intent}` : (targetName ? `${verb} on "${targetName}"` : verb);
      return `<div class="step ${cls}"><span class="num">${stepNum}</span><strong>${stepTitle}</strong>${html}</div>`;
    }).join('');

    // If compiled, show link to the artifact
    if (compiled) {
      const artFile = compiled.path ? compiled.path.split('/').pop() || compiled.path.split('\\').pop() : '';
      steps += `<div style="margin-top:16px;padding:12px;background:#e8f5e9;border:1px solid #4caf50;border-radius:4px">
        ✓ Compiled to artifact. <a href="/tool/${artFile}">Review and approve →</a></div>`;
    }
  }

  return shell(`Run: ${capName}`, `
    <div style="margin-bottom:12px"><a href="/runs" style="font-size:12px;color:#666">← Runs</a></div>
    <h2>${capName}</h2>
    <p style="font-size:12px;color:#666;margin-bottom:4px">
      ${site.label ? `<strong>${site.label}</strong> · ` : ''}${runDir.substring(0, 19).replace('T', ' ')}
    </p>
    ${resultHtml}${timeline}
    <div class="section">Step by step</div>
    <p style="font-size:11px;color:#888;margin-bottom:8px">
      <span style="display:inline-block;width:8px;height:8px;background:#4caf50;border-radius:50%"></span> passed
      <span style="display:inline-block;width:8px;height:8px;background:#c44;border-radius:50%;margin-left:8px"></span> failed
      <span style="display:inline-block;width:8px;height:8px;background:#ff9800;border-radius:50%;margin-left:8px"></span> recovered
      · margin = confidence in element match (yellow = close call)
    </p>
    ${steps || '<p style="color:#888">No steps recorded.</p>'}`, 'runs');
}

// ── Routing ──────────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise(resolve => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const p: Record<string, string> = {};
      for (const pair of body.split('&')) {
        const [k, ...rest] = pair.split('=');
        p[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(rest.join('=').replace(/\+/g, ' '));
      }
      resolve(p);
    });
  });
}

function send(res: ServerResponse, code: number, html: string) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // ASK
    if (path === '/') { send(res, 200, renderAsk(url.searchParams.get('q') ?? undefined, url.searchParams.get('site') ?? undefined)); return; }

    if (path === '/ask/run' && req.method === 'POST') {
      const body = await parseBody(req);
      const file = body.artifact;
      const art = JSON.parse(readFileSync(resolve(ROOT, 'capabilities', file), 'utf8'));
      const args: string[] = ['replay', art.name];
      for (const [k, v] of Object.entries(body)) {
        if (k.startsWith('p_')) args.push(`--${k.substring(2)}`, v);
      }
      const tenant = surfaceFor(art).tenant;
      if (tenant) args.push('--tenant', tenant);
      const child = spawn('npm', ['run', 'cli', '--', ...args], {
        cwd: ROOT, shell: true, env: { ...process.env }, stdio: 'pipe',
      });
      child.on('close', () => {
        const runs = loadRuns(art.name);
        res.writeHead(302, { Location: runs[0] ? `/run/${runs[0].dir}` : '/runs' });
        res.end();
      });
      return;
    }

    // SITES
    if (path === '/sites') { send(res, 200, renderSites()); return; }
    if (path.startsWith('/site/')) { send(res, 200, renderSite(path.substring(6))); return; }

    // TOOL
    if (path.startsWith('/tool/')) { send(res, 200, renderTool(path.substring(6))); return; }

    // TEACH
    if (path === '/teach') {
      send(res, 200, renderTeach(url.searchParams.get('goal') ?? undefined, url.searchParams.get('site') ?? undefined));
      return;
    }
    if (path === '/teach/start' && req.method === 'POST') {
      const body = await parseBody(req);
      const surfaces = loadSurfaces();
      const s = (surfaces as any)[body.site];
      const name = body.goal.replace(/[^a-z0-9]+/gi, '-').toLowerCase().substring(0, 40);
      // Run discovery IN-PROCESS (not as a subprocess) so ConsoleChannel can reach it.
      const channel = new ConsoleChannel();
      const runEntry: ActiveRun = { name, goal: body.goal, site: s?.label || body.site, runDir: '', channel, status: 'running', startedAt: Date.now() };

      // Wrap the channel to track pause/resume
      const wrappedChannel: import('../escalation/intervention.js').EscalationChannel = {
        async request(req: InterventionRequest) {
          runEntry.status = 'paused';
          const claim = await channel.request(req);
          runEntry.status = 'running';
          return claim;
        },
      };

      activeRuns.set(name, runEntry);

      // Fire-and-forget the async discovery — errors become terminal states
      (async () => {
        try {
          const { BrowserSurface } = await import('../surface/browser-surface.js');
          const { discover } = await import('../discovery/agent.js');
          const { OpenAIClient } = await import('../discovery/openai-client.js');
          const { MockLLMClient } = await import('../discovery/llm-client.js');
          const { RunJournal } = await import('../evidence/journal.js');
          const { loadPolicy } = await import('../guardrails/policy.js');

          const baseUrl = process.env.CONSOLE_URL || process.env.MOCK_CONSOLE_URL || 'http://localhost:3000';
          const tenantRaw = s?.tenant || '';
          const tenantPrefix = tenantRaw ? `/t/${tenantRaw}` : '';
          const basePolicy = loadPolicy(resolve('policy.json'));
          const policy = { ...basePolicy, allowedOrigins: [...basePolicy.allowedOrigins, baseUrl] };
          const surface = new BrowserSurface({ baseUrl, tenantPrefix, policy, headed: false });

          // Build contract
          const contract: any = {
            name, goal: body.goal, app: body.site,
            appDescription: s?.description,
            startPath: s?.startPath || '/search',
            inputs: {}, outputs: {},
          };
          // Implicit credentials
          if (process.env.CONSOLE_USER) contract.inputs.username = { type: 'string', sensitive: true, exampleValue: process.env.CONSOLE_USER };
          if (process.env.CONSOLE_PASS) contract.inputs.password = { type: 'string', sensitive: true, exampleValue: process.env.CONSOLE_PASS };

          // LLM client
          let llmClient;
          if (process.env.OPENAI_API_KEY) {
            llmClient = new OpenAIClient({ appDescription: s?.description });
          } else {
            // No LLM key — discovery can't proceed
            runEntry.status = 'done';
            activeRuns.delete(name);
            return;
          }

          // Journal
          const tempArt = {
            name, version: '0.0.0', app: { id: body.site, startPath: s?.startPath || '/search' },
            inputs: Object.fromEntries(Object.entries(contract.inputs).map(([k, v]: [string, any]) => [k, { type: v.type, sensitive: v.sensitive }])),
            outputs: {}, businessOutcomes: {},
            steps: [{ id: 's0', intent: '', action: { verb: 'navigate' as const }, target: { properties: { role: 'navigation', frame: 'main' }, reasoning: '' }, risk: 'safe' as const, expect: { textPresent: '' } }],
          };
          const journalInputs = Object.fromEntries(Object.entries(contract.inputs).map(([k, v]: [string, any]) => [k, v.exampleValue || '']));
          const journal = new RunJournal(resolve('evidence/runs'), tempArt as any, journalInputs);
          (surface as any).config.screenshotDir = journal.runDir;
          runEntry.runDir = journal.runDir;
          runEntry.surface = surface;
          runEntry.journal = journal;

          await surface.launch();
          try {
            const result = await discover({
              surface, llmClient, contract, journal,
              capabilitiesDir: resolve('capabilities'),
              attended: true, channel: wrappedChannel,
            });

            // Write token summary if available
            if ('getTotalUsage' in llmClient) {
              journal.event('token_summary', (llmClient as any).getTotalUsage());
            }

            // Write report
            const compiledArt = result.artifactPath
              ? JSON.parse(readFileSync(resolve(result.artifactPath), 'utf8'))
              : null;
            journal.writeDiscoveryReport(compiledArt);
          } finally {
            await surface.close();
          }
        } catch (e) {
          console.error(`[console] discovery "${name}" crashed:`, (e as Error).message);
        } finally {
          runEntry.status = 'done';
          activeRuns.delete(name);
        }
      })();

      send(res, 200, shell('Teaching...', `
        <h2>Teaching: ${body.goal}</h2>
        <p style="color:#666">The AI is exploring ${s?.label || body.site}. This page polls for progress.</p>
        <div id="st" style="padding:16px;background:#fff3cd;border:1px solid #ffc107;border-radius:6px;margin:16px 0">Starting...</div>
        <script>setInterval(async()=>{try{
          const r=await fetch('/api/run-status/${encodeURIComponent(name)}');
          const j=await r.json();
          const el=document.getElementById('st');
          if(j.status==='paused'){el.innerHTML='<a href="/intervention" class="btn" style="background:#ff5722;color:#fff">⚠ Needs you — intervene →</a>';}
          else if(j.status==='done'||j.runDir){
            const r2=await fetch('/runs?q=${encodeURIComponent(name)}');const h=await r2.text();
            const m=h.match(/href="\\/run\\/([^"]+)"/);
            if(m){el.innerHTML='<a href="/run/'+m[1]+'" class="btn primary">View result →</a>';}
            else{el.textContent='Finished. Check runs.';}
          }else{el.textContent='Step '+((j.step||0))+'...';}
        }catch{}},2000)</script>`, 'sites'));
      return;
    }

    // ── API: run status (JSON, for polling) ────────────────
    if (path.startsWith('/api/run-status/')) {
      const runName = decodeURIComponent(path.substring('/api/run-status/'.length));
      const active = activeRuns.get(runName);
      const jData: Record<string, unknown> = { name: runName };
      if (active) {
        jData.status = active.status;
        jData.runDir = active.runDir;
        const pending = active.channel.getPending();
        if (pending) jData.intervention = { stepId: pending.stepId, reason: pending.reason };
      } else {
        jData.status = 'done';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jData));
      return;
    }

    // ── API: intervention (JSON) ─────────────────────────
    if (path === '/api/intervention' && req.method === 'GET') {
      const paused = getPausedRun();
      if (!paused) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ paused: false }));
        return;
      }
      const pending = paused.channel.getPending();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        paused: true,
        name: paused.name,
        goal: paused.goal,
        site: paused.site,
        runDir: paused.runDir,
        intervention: pending ? {
          capability: pending.capability,
          version: pending.version,
          stepId: pending.stepId,
          intent: pending.intent,
          reason: pending.reason,
          expected: pending.expected,
          observed: pending.observed,
          screenshotRef: pending.screenshotRef,
        } : null,
      }));
      return;
    }

    // ── Intervention page (HTML) — text-based operator surface ──
    if (path === '/intervention') {
      const paused = getPausedRun();
      if (!paused) {
        send(res, 200, shell('No intervention', '<p>No runs are paused right now.</p>', 'runs'));
        return;
      }
      const pending = paused.channel.getPending();
      if (!pending) {
        send(res, 200, shell('Intervention', '<p>Run is active but no intervention is pending.</p>', 'runs'));
        return;
      }

      // Observe the live page for the text view
      let pageView = '';
      if (paused.surface) {
        try {
          const obs = await paused.surface.observe();
          const { isRiskyTarget: isRisky } = await import('../guardrails/risky.js');
          const elRows = obs.elements.slice(0, 60).map((e, i) => {
            const risky = (e.role === 'button' || e.role === 'link') && isRisky(e.name || '');
            return `<tr style="background:${risky ? '#fff3e0' : i % 2 === 0 ? '#fff' : '#fafaf8'}">
              <td style="padding:3px 6px;border:1px solid #ddd;font-family:monospace;font-size:11px;color:#888">${i}</td>
              <td style="padding:3px 6px;border:1px solid #ddd;font-size:11px">${e.role}</td>
              <td style="padding:3px 6px;border:1px solid #ddd;font-size:11px;font-weight:${e.name ? '600' : '400'}">${e.name || ''}</td>
              <td style="padding:3px 6px;border:1px solid #ddd;font-size:10px;color:#888">${e.frame}</td>
              ${risky ? '<td style="padding:3px 6px;border:1px solid #ddd;color:#ff5722;font-size:10px">⚠ risky</td>' : '<td style="padding:3px 6px;border:1px solid #ddd"></td>'}
            </tr>`;
          }).join('');
          pageView = `
            <div style="background:#fff;border:1px solid #d4d0c8;border-radius:6px;padding:12px;margin-bottom:16px">
              <div style="font-size:11px;color:#888;margin-bottom:4px">CONTROL: <strong style="color:#ff5722">HUMAN</strong> · URL: <code>${obs.url}</code> · ${obs.elements.length} elements</div>
              <details open><summary style="cursor:pointer;font-size:11px;color:#555;margin-bottom:4px">Page elements (${Math.min(obs.elements.length, 60)} shown)</summary>
              <table style="border-collapse:collapse;width:100%;margin-top:4px">
                <tr style="background:#f0ede8"><th style="padding:3px 6px;border:1px solid #ddd;font-size:10px">#</th><th style="padding:3px 6px;border:1px solid #ddd;font-size:10px">Role</th><th style="padding:3px 6px;border:1px solid #ddd;font-size:10px">Name</th><th style="padding:3px 6px;border:1px solid #ddd;font-size:10px">Frame</th><th style="padding:3px 6px;border:1px solid #ddd;font-size:10px">Flag</th></tr>
                ${elRows}
              </table></details>
            </div>`;
        } catch (e) {
          pageView = `<div style="color:#c44;margin-bottom:12px">Could not observe page: ${(e as Error).message}</div>`;
        }
      }

      send(res, 200, shell('Intervention Required', `
        <div style="margin-bottom:12px"><a href="/runs" style="font-size:12px;color:#666">← Runs</a></div>
        <h2 style="color:#ff5722">Intervention Required</h2>
        <div style="background:#fff3e0;border:1px solid #ff9800;border-radius:6px;padding:16px;margin-bottom:16px">
          <div style="font-size:13px;color:#666;margin-bottom:8px"><strong>${paused.name}</strong> — ${paused.goal} on ${paused.site}</div>
          <div style="margin-bottom:8px"><strong>Step:</strong> ${pending.stepId} — ${pending.intent}</div>
          <div style="margin-bottom:8px"><strong>Reason:</strong> ${pending.reason}</div>
          <div style="margin-bottom:8px"><strong>Expected:</strong> <code>${pending.expected}</code></div>
          <div style="margin-bottom:8px"><strong>Observed:</strong> <code>${pending.observed}</code></div>
        </div>

        ${pageView}

        <div style="background:#fff;border:1px solid #d4d0c8;border-radius:6px;padding:16px;margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;margin-bottom:8px">Operator Actions</div>
          <form method="POST" action="/intervention/act" style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
            <input name="command" placeholder='click 3 · type 5 "hello" · navigate /search · read 7' style="flex:1;padding:8px 12px;border:1px solid #ccc;border-radius:4px;font-family:monospace;font-size:12px">
            <button class="btn" type="submit">Execute</button>
          </form>
          <div style="font-size:10px;color:#888">
            Commands: <code>click &lt;n&gt;</code> · <code>type &lt;n&gt; "text"</code> · <code>select &lt;n&gt; "value"</code> · <code>navigate &lt;path&gt;</code> · <code>read &lt;n&gt;</code>
          </div>
        </div>

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:16px">
          <form method="POST" action="/intervention/respond"><input type="hidden" name="claim" value="retry">
            <button class="btn primary" type="submit">Retry this step</button></form>
          <form method="POST" action="/intervention/respond"><input type="hidden" name="claim" value="skip">
            <button class="btn" type="submit" title="Checked against the live screen — rejected if nothing changed">Resume (verified handback)</button></form>
          <form method="POST" action="/intervention/respond"><input type="hidden" name="claim" value="approve">
            <button class="btn" type="submit" style="background:#4caf50;color:#fff">Approve action</button></form>
          <form method="POST" action="/intervention/respond" style="display:flex;gap:4px;align-items:center">
            <input type="hidden" name="claim" value="abort">
            <input name="notes" placeholder="Reason..." style="padding:6px 10px;border:1px solid #ccc;border-radius:3px;font-size:12px;width:160px">
            <button class="btn danger" type="submit">Abort</button></form>
        </div>
        <script>
        setInterval(async()=>{
          try{const r=await fetch('/api/intervention');const j=await r.json();
          if(!j.paused){location.href='/runs';}
          }catch{}
        },3000);
        </script>`, 'runs'));
      return;
    }

    // ── Operator action during intervention ────────────────
    if (path === '/intervention/act' && req.method === 'POST') {
      const body = await parseBody(req);
      const paused = getPausedRun();
      if (!paused?.surface) { res.writeHead(302, { Location: '/intervention' }); res.end(); return; }

      const cmd = (body.command || '').trim();
      const surface = paused.surface;

      try {
        // Parse command: click <n>, type <n> "text", select <n> "value", navigate <path>, read <n>
        const clickM = cmd.match(/^click\s+(\d+)$/i);
        const typeM = cmd.match(/^type\s+(\d+)\s+"([^"]*)"$/i);
        const selectM = cmd.match(/^select\s+(\d+)\s+"([^"]*)"$/i);
        const navM = cmd.match(/^navigate\s+(.+)$/i);
        const readM = cmd.match(/^read\s+(\d+)$/i);

        const obs = await surface.observe();

        if (clickM) {
          const n = parseInt(clickM[1]);
          const el = obs.elements[n];
          if (!el) throw new Error(`Element ${n} not found (${obs.elements.length} on page)`);
          const result = await surface.act({ verb: 'click', ref: el.ref });
          if (paused.journal) paused.journal.event('human_action', { verb: 'click', element: n, name: el.name, result: result.ok });
        } else if (typeM) {
          const n = parseInt(typeM[1]);
          const text = typeM[2];
          const el = obs.elements[n];
          if (!el) throw new Error(`Element ${n} not found`);
          const result = await surface.act({ verb: 'type', value: text, ref: el.ref });
          if (paused.journal) paused.journal.event('human_action', { verb: 'type', element: n, name: el.name, value: text, result: result.ok });
        } else if (selectM) {
          const n = parseInt(selectM[1]);
          const val = selectM[2];
          const el = obs.elements[n];
          if (!el) throw new Error(`Element ${n} not found`);
          const result = await surface.act({ verb: 'select', value: val, ref: el.ref });
          if (paused.journal) paused.journal.event('human_action', { verb: 'select', element: n, value: val, result: result.ok });
        } else if (navM) {
          const path = navM[1].trim();
          const result = await surface.navigate(path);
          if (paused.journal) paused.journal.event('human_action', { verb: 'navigate', path, result: result.ok });
        } else if (readM) {
          const n = parseInt(readM[1]);
          const el = obs.elements[n];
          if (!el) throw new Error(`Element ${n} not found`);
          const result = await surface.act({ verb: 'read', ref: el.ref });
          if (paused.journal) paused.journal.event('human_action', { verb: 'read', element: n, name: el.name, readValue: (result as any).readValue });
        } else {
          throw new Error(`Unknown command. Use: click <n>, type <n> "text", navigate <path>, read <n>`);
        }
      } catch (e) {
        // Show error on the intervention page via a query param
      }

      // Redirect back to intervention page (re-observe will show updated state)
      res.writeHead(302, { Location: '/intervention' }); res.end();
      return;
    }

    // ── Intervention response (POST) ─────────────────────
    if (path === '/intervention/respond' && req.method === 'POST') {
      const body = await parseBody(req);
      const paused = getPausedRun();
      if (!paused) {
        res.writeHead(302, { Location: '/runs' }); res.end(); return;
      }
      const claim = body.claim;
      if (claim === 'retry') {
        paused.channel.respond({ kind: 'retry' });
      } else if (claim === 'skip') {
        paused.channel.respond({ kind: 'skip' });
      } else if (claim === 'approve') {
        paused.channel.respond({ kind: 'approve' });
      } else if (claim === 'abort') {
        paused.channel.respond({ kind: 'abort', notes: body.notes || undefined });
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Invalid claim'); return;
      }
      // Brief pause to let the channel resolve before redirect
      await new Promise(r => setTimeout(r, 500));
      // Check if still paused (skip might have been rejected)
      const stillPaused = getPausedRun();
      if (stillPaused && stillPaused.name === paused.name) {
        // Skip was likely rejected — redirect back to intervention
        res.writeHead(302, { Location: '/intervention' }); res.end();
      } else {
        res.writeHead(302, { Location: '/runs' }); res.end();
      }
      return;
    }

    // APPROVE / REVOKE
    if (path === '/approve' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.name) { send(res, 400, shell('Error', '<p>Name required.</p>', 'sites')); return; }
      approveCapability(body.name, body.version || '1.0.0', body.note || undefined);
      res.writeHead(302, { Location: req.headers.referer || '/' }); res.end(); return;
    }
    if (path === '/revoke' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.name) { send(res, 400, shell('Error', '<p>Name required.</p>', 'sites')); return; }
      revokeCapability(body.name, body.version || '1.0.0');
      res.writeHead(302, { Location: req.headers.referer || '/' }); res.end(); return;
    }

    // RUNS
    if (path === '/runs') {
      send(res, 200, renderRuns(
        url.searchParams.get('q') ?? undefined,
        url.searchParams.get('site') ?? undefined,
        url.searchParams.get('status') ?? undefined,
        url.searchParams.get('type') ?? undefined,
      )); return;
    }
    if (path.startsWith('/run/')) { send(res, 200, renderRun(path.substring(5))); return; }

    // Screenshots
    if (path.startsWith('/screenshot/')) {
      const fPath = resolve(ROOT, 'evidence/runs', path.substring(12));
      if (!existsSync(fPath)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(readFileSync(fPath)); return;
    }

    send(res, 404, shell('Not Found', '<p>Page not found.</p>', 'ask'));
  } catch (e) {
    send(res, 500, shell('Error', `<pre>${(e as Error).message}</pre>`, 'ask'));
  }
});

server.listen(PORT, () => { console.log(`Console on http://localhost:${PORT}`); });
