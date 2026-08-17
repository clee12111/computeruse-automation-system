// src/mcp/server.ts — MCP server exposing approved capabilities as tools.
// THIN FACE over the existing engine — imports and orchestrates src/ modules,
// adds ZERO new core logic.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnvFile } from '../discovery/openai-client.js';
import { loadArtifact, ArtifactValidationError } from '../schema/loader.js';
import { loadPolicy } from '../guardrails/policy.js';
import { loadTrust, trustKey, type TrustEntry } from '../guardrails/trust.js';
import { BrowserSurface } from '../surface/browser-surface.js';
import { replay, validateInputs, InvalidInputError } from '../replay/engine.js';
import { RunJournal } from '../evidence/journal.js';
import type { CapabilityArtifact } from '../schema/artifact.js';

// ── Load config ─────────────────────────────────────────────
loadEnvFile(resolve(process.cwd(), '.env'));

interface SurfaceConfig {
  baseUrl: string;
  tenant: string;
}

interface McpConfig {
  surfaces: Record<string, SurfaceConfig>;
  credentials: Record<string, string>;
}

function loadMcpConfig(): McpConfig {
  const configPath = resolve('config/mcp-surfaces.json');
  if (!existsSync(configPath)) {
    return { surfaces: {}, credentials: {} };
  }
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

// ── Capability catalog ──────────────────────────────────────

interface CatalogEntry {
  artifact: CapabilityArtifact;
  filePath: string;
  trustStatus: TrustEntry;
}

function buildCatalog(): Map<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  const capDir = resolve('capabilities');
  if (!existsSync(capDir)) return catalog;

  const trust = loadTrust();

  for (const file of readdirSync(capDir)) {
    if (!file.endsWith('.json') || file === 'trust.json') continue;
    const filePath = join(capDir, file);
    try {
      const artifact = loadArtifact(filePath);
      const key = trustKey(artifact.name, artifact.version);
      const status = trust[key] ?? { status: 'manual' as const };
      catalog.set(artifact.name, { artifact, filePath, trustStatus: status });
    } catch (e) {
      // Skip invalid artifacts (v1, malformed)
      if (!(e instanceof ArtifactValidationError)) {
        console.error(`[mcp] skipped ${file}: ${(e as Error).message}`);
      }
    }
  }

  return catalog;
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── Server ──────────────────────────────────────────────────

const server = new Server(
  { name: 'computeruse-automation', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const catalog = buildCatalog();
  const tools: any[] = [];

  for (const [name, entry] of catalog) {
    if (entry.trustStatus.status !== 'approved') continue;

    const art = entry.artifact;
    const toolName = sanitizeToolName(name);

    // Build input schema from artifact inputs (exclude sensitive — those come from env)
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const [inputName, decl] of Object.entries(art.inputs)) {
      if (decl.sensitive) continue; // sensitive inputs come from env
      properties[inputName] = {
        type: 'string',
        description: `${decl.type}${decl.pattern ? ` (pattern: ${decl.pattern})` : ''}`,
      };
      required.push(inputName);
    }

    // Build description from artifact identity + outcomes
    const outcomes = Object.keys(art.businessOutcomes);
    const outcomeNote = outcomes.length > 0
      ? ` Possible non-success outcomes: ${outcomes.join(', ')}.`
      : '';
    const outputNote = Object.entries(art.outputs)
      .map(([k, v]) => `${k} (${v.type})`)
      .join(', ');

    tools.push({
      name: toolName,
      description: `${art.name}: reads ${outputNote} from ${art.app.id}.${outcomeNote}`,
      inputSchema: {
        type: 'object',
        properties,
        required,
      },
    });
  }

  // Discovery tools — propose, never authorize
  const config = loadMcpConfig();
  const siteNames = Object.entries(config.surfaces).map(([k, v]: any) => v.label || k);
  tools.push({
    name: 'discover_capability',
    description: `Start learning a new capability on a target site. Returns immediately with a runId — discovery is asynchronous, takes ~30-60s, and may stall if the agent gets stuck. Stalling is a normal outcome, not an error. The resulting capability is born "manual" and is NOT callable until a human approves it. Available sites: ${siteNames.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What the capability should do, in plain language. e.g. "look up a member\'s checking balance"' },
        site: { type: 'string', description: `Which site to learn on. One of: ${Object.keys(config.surfaces).join(', ')}` },
      },
      required: ['goal', 'site'],
    },
  });
  tools.push({
    name: 'check_discovery',
    description: 'Check the progress of a running discovery. Returns status, steps so far, and — on completion — the result with a quality report. If status is "needs-human", a human must resolve the intervention at the console URL — do NOT attempt to resolve it yourself. Present the options and the console link to your user and stop. Always show the "detail" field verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The runId returned by discover_capability' },
      },
      required: ['runId'],
    },
  });

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const catalog = buildCatalog();
  const config = loadMcpConfig();
  const startTime = Date.now();
  const toolName = request.params.name;

  // ── discover_capability ─────────────────────────────────
  if (toolName === 'discover_capability') {
    const args = (request.params.arguments ?? {}) as Record<string, string>;
    const goal = args.goal;
    const siteId = args.site;
    if (!goal || !siteId) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'missing_args', message: 'Both goal and site are required.' }) }], isError: true };
    }
    const surfConf = (config.surfaces as any)[siteId];
    if (!surfConf) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_site', message: `Site "${siteId}" not configured. Available: ${Object.keys(config.surfaces).join(', ')}` }) }], isError: true };
    }
    const name = goal.replace(/[^a-z0-9]+/gi, '-').toLowerCase().substring(0, 40);
    const cliArgs = ['discover', '--name', name, '--goal', goal, '--app', siteId];
    if (surfConf.tenant) cliArgs.push('--tenant', surfConf.tenant);
    else cliArgs.push('--tenant', 'none');
    if (surfConf.description) cliArgs.push('--app-description', surfConf.description);
    cliArgs.push('--start', surfConf.startPath || '/search', '--output', 'result:string');
    // Spawn and return immediately — never block
    spawn('npm', ['run', 'cli', '--', ...cliArgs], {
      cwd: resolve('.'), shell: true, env: { ...process.env }, stdio: 'pipe',
    });
    // Find the run directory (will appear in evidence/runs/ momentarily)
    const runId = name;
    const { describeDiscoveryResult } = await import('../schema/describe-result.js');
    const desc = describeDiscoveryResult({ status: 'running', stepsSoFar: 0 }, { goal, site: surfConf.label || siteId });
    return { content: [{ type: 'text', text: JSON.stringify({
      runId, status: 'running', summary: desc.summary, detail: desc.detail, nextActions: desc.nextActions,
    }) }] };
  }

  // ── check_discovery ─────────────────────────────────────
  if (toolName === 'check_discovery') {
    const args = (request.params.arguments ?? {}) as Record<string, string>;
    const runId = args.runId;
    if (!runId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'missing_runId' }) }], isError: true };
    // Find the latest run matching this runId
    const runsDir = resolve('evidence/runs');
    let runDir: string | null = null;
    if (existsSync(runsDir)) {
      const dirs = readdirSync(runsDir).filter(d => d.includes(runId) && statSync(join(runsDir, d)).isDirectory()).sort().reverse();
      if (dirs.length > 0) runDir = dirs[0];
    }
    if (!runDir) return { content: [{ type: 'text', text: JSON.stringify({ status: 'running', stepsSoFar: 0, summary: 'Discovery starting — no journal yet.' }) }] };
    // Read journal to count steps and check for completion
    const jPath = join(runsDir, runDir, 'journal.jsonl');
    const events = existsSync(jPath) ? readFileSync(jPath, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    const stepCount = events.filter((e: any) => e.event === 'step_ok' || e.event === 'step_ok_fallback').length;
    // Check if discovery completed
    const tokenSummary = events.find((e: any) => e.event === 'token_summary');
    const compileEvent = events.find((e: any) => e.event === 'compiled' || e.event === 'compiling');
    // Check for result file (discovery writes artifact, not result.json)
    const capDir = resolve('capabilities');
    const newArtFile = existsSync(capDir) ? readdirSync(capDir).find(f => f.includes(runId) && f.endsWith('.json')) : null;
    const { describeDiscoveryResult } = await import('../schema/describe-result.js');
    if (newArtFile) {
      // Compiled
      const art = JSON.parse(readFileSync(join(capDir, newArtFile), 'utf8'));
      const desc = describeDiscoveryResult({ status: 'compiled', artifact: art, artifactPath: newArtFile }, { capabilityName: art.name, goal: events.find((e: any) => e.event === 'discovery_start')?.goal, site: '' });
      return { content: [{ type: 'text', text: JSON.stringify({
        _instruction: 'Show the detail field below VERBATIM to the user. It is a quality report they must read before deciding to approve.',
        status: 'compiled', capability: art.name, version: art.version,
        stepCount: art.steps.length,
        trust: 'manual', callable: false,
        summary: desc.summary, detail: desc.detail, nextActions: desc.nextActions,
      }) }] };
    }
    // Check for dead_end or aborted (no artifact produced, but tokenSummary present = run finished)
    if (tokenSummary && !newArtFile) {
      const reason = events.find((e: any) => e.event === 'dead_end')?.reason || events.find((e: any) => e.event === 'aborted')?.reason || 'exploration ended without a result';
      const status = events.some((e: any) => e.event === 'aborted') ? 'aborted' : 'dead_end';

      // Build step-by-step trace from journal
      const traceLines: string[] = [];
      for (const e of events) {
        if (e.event === 'observed') {
          traceLines.push(`step ${e.step}: OBSERVE ${e.url} (${e.elements} elements)${e.headings?.length ? ' headings=[' + e.headings.join(', ') + ']' : ''}${e.fields?.length ? ' fields=[' + e.fields.join(', ') + ']' : ''}`);
        } else if (e.event === 'decision' && e.tool !== 'done') {
          traceLines.push(`  DECIDE: ${e.verb || '?'} on "${e.targetName || '?'}"${e.value ? ' value=' + e.value : ''}${e.intent ? ' — "' + e.intent + '"' : ''}`);
        } else if (e.event === 'decision' && e.tool === 'done') {
          traceLines.push(`  DECIDE: done`);
        } else if (e.event === 'act_result') {
          traceLines.push(`  ACT: ${e.ok ? '✓' : '✗'} ${e.verb}${e.readValue ? ' → read: "' + e.readValue + '"' : ''}`);
        } else if (e.event === 'navigate') {
          traceLines.push(`  ACT: navigate → ${e.path}`);
        } else if (e.event === 'same_action_warning') {
          traceLines.push(`  ⚠ REPEATED: ${e.verbTarget}`);
        } else if (e.event === 'resolve_failed') {
          traceLines.push(`  ✗ resolve failed: ${e.kind}`);
        } else if (e.event === 'refusal') {
          traceLines.push(`  ✗ blocked by policy: ${e.rule}`);
        } else if (e.event === 'expect_failed') {
          traceLines.push(`  ✗ expect failed`);
        } else if (e.event === 'verify_failed') {
          traceLines.push(`  ✗ verify failed: ${e.errors?.join('; ')}`);
        }
      }

      const desc = describeDiscoveryResult({ status, reason }, { goal: events.find((e: any) => e.event === 'discovery_start')?.goal, site: '' });
      return { content: [{ type: 'text', text: JSON.stringify({
        _instruction: 'Show the detail, trace, and summary fields VERBATIM to the user. The trace shows every step the agent took.',
        status, stepsSoFar: stepCount, reason,
        summary: desc.summary, detail: desc.detail,
        trace: traceLines.join('\n'),
        nextActions: desc.nextActions,
      }) }] };
    }
    // Check if paused awaiting human intervention
    const lastTransfer = [...events].reverse().find((e: any) => e.event === 'control_transfer');
    const isPaused = lastTransfer?.to === 'human';
    if (isPaused) {
      const consolePort = process.env.CONSOLE_UI_PORT || '4000';
      const consoleUrl = `http://localhost:${consolePort}/intervention`;
      return { content: [{ type: 'text', text: JSON.stringify({
        _instruction: 'A human must resolve this intervention. Do NOT attempt to resolve it yourself. Present the options and the console URL to your user.',
        status: 'needs-human', stepsSoFar: stepCount,
        summary: `Discovery paused — a human must intervene at step ${lastTransfer.stepId || '?'}.`,
        detail: `The agent is stuck and has asked for help. Reason: ${lastTransfer.reason || 'unknown'}.`,
        consoleUrl,
        nextActions: [
          '--- Actions the CALLER can take ---',
          'Wait for the human to resolve the intervention, then poll again.',
          'If discovery is no longer needed, the human can abort from the console.',
          '--- Actions requiring a HUMAN WITH AUTHORITY ---',
          `Open the operator console at ${consoleUrl} to answer the intervention (retry, skip, or abort).`,
          'Only a human at the console can approve or reject a capability.',
        ],
      }) }] };
    }

    // Still running
    const desc = describeDiscoveryResult({ status: 'running', stepsSoFar: stepCount }, { goal: events.find((e: any) => e.event === 'discovery_start')?.goal, site: '' });
    return { content: [{ type: 'text', text: JSON.stringify({
      _instruction: 'Show the detail and summary fields VERBATIM to the user.',
      status: 'running', stepsSoFar: stepCount,
      summary: desc.summary, detail: desc.detail, nextActions: desc.nextActions,
    }) }] };
  }

  // ── Capability tools ────────────────────────────────────
  let entry: CatalogEntry | undefined;
  for (const [name, e] of catalog) {
    if (sanitizeToolName(name) === toolName) {
      entry = e;
      break;
    }
  }

  if (!entry) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_capability', message: `No capability found for tool "${toolName}"` }) }],
      isError: true,
    };
  }

  // Trust gate (double-check — tools/list already filters, but invocation must re-verify)
  if (entry.trustStatus.status !== 'approved') {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'trust_blocked',
        message: `Capability "${entry.artifact.name}@${entry.artifact.version}" is not approved for unattended execution. Current status: ${entry.trustStatus.status}`,
      }) }],
      isError: true,
    };
  }

  const art = entry.artifact;
  const args = (request.params.arguments ?? {}) as Record<string, string>;

  // Resolve surface config (needed for per-site credential lookup)
  const surfaceConf = config.surfaces[art.app.id];
  if (!surfaceConf) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'no_surface', message: `No surface configured for app "${art.app.id}" in config/mcp-surfaces.json` }) }],
      isError: true,
    };
  }

  // Build inputs: non-sensitive from args, sensitive from env
  // Per-surface credentials override global; fall back to global when absent
  const surfaceCreds = (surfaceConf as any).credentials || {};
  const globalCreds = config.credentials || {};
  const inputs: Record<string, string> = {};
  for (const [inputName, decl] of Object.entries(art.inputs)) {
    if (decl.sensitive) {
      const envKey = surfaceCreds[inputName] || globalCreds[inputName];
      const envVal = envKey ? process.env[envKey] : undefined;
      if (envVal) {
        inputs[inputName] = envVal;
      }
    } else {
      if (args[inputName] != null) {
        inputs[inputName] = String(args[inputName]);
      }
    }
  }

  // Pre-flight: every sensitive input must have a value
  for (const [inputName, decl] of Object.entries(art.inputs)) {
    if (decl.sensitive && !inputs[inputName]) {
      const envKey = surfaceCreds[inputName] || globalCreds[inputName] || inputName.toUpperCase();
      return {
        content: [{ type: 'text', text: JSON.stringify({ result: 'INVALID_INPUT', message: `${inputName} is required by this capability but ${envKey} is unset` }) }],
        isError: true,
      };
    }
  }

  // Validate inputs (pattern matching, etc.)
  try {
    validateInputs(art, inputs);
  } catch (e) {
    if (e instanceof InvalidInputError) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ result: 'INVALID_INPUT', message: e.message }) }],
        isError: true,
      };
    }
    throw e;
  }

  // Run replay — CONSOLE_URL env overrides config baseUrl (for test isolation)
  const policy = loadPolicy(resolve('config/policy.json'));
  const effectiveBaseUrl = process.env.CONSOLE_URL || surfaceConf.baseUrl;
  const surface = new BrowserSurface({
    baseUrl: effectiveBaseUrl,
    tenantPrefix: surfaceConf.tenant ? `/t/${surfaceConf.tenant}` : '',
    policy: { ...policy, allowedOrigins: [...policy.allowedOrigins, effectiveBaseUrl] },
    headed: false,
  });

  const journal = new RunJournal(resolve('evidence/runs'), art, inputs);
  (surface as any).config.screenshotDir = journal.runDir;

  try {
    await surface.launch();
    const result = await replay({
      surface, artifact: art, inputs, journal,
      stepTimeoutMs: 30000, tickMs: 250,
      tenant: surfaceConf.tenant || undefined,
    });

    // Redact sensitive outputs before journaling
    if (result.status === 'SUCCESS') {
      for (const [key, decl] of Object.entries(art.outputs)) {
        if (decl.sensitive && result.outputs[key] != null) {
          journal.addSensitiveOutput(String(result.outputs[key]));
        }
      }
    }
    journal.writeResult(result);
    const durationMs = Date.now() - startTime;
    // Dual-audience envelope: typed fields + human-readable strings
    const { describeReplayResult } = await import('../schema/describe-result.js');
    const described = describeReplayResult(result, { capabilityName: art.name, durationMs, recovered: (result as any).recovered });
    const response: Record<string, unknown> = {
      _instruction: 'Show the summary and detail fields VERBATIM to the user.',
      result: result.status,
      durationMs,
      journalPath: journal.runDir,
      reportPath: join(journal.runDir, 'report.md'),
      summary: described.summary,
      detail: described.detail,
      nextActions: described.nextActions,
    };
    if (result.status === 'SUCCESS') response.outputs = result.outputs;
    if (result.status === 'BUSINESS_OUTCOME') response.outcome = (result as any).code;

    return {
      content: [{ type: 'text', text: JSON.stringify(response) }],
    };
  } finally {
    await surface.close();
  }
});

// ── Main ────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] Computer-use automation server running (stdio)');
}

main().catch((e) => {
  console.error('[mcp] Fatal:', e);
  process.exit(1);
});
