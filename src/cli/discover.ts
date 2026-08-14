// src/cli/discover.ts — CLI discover subcommand.
// Usage: npm run cli -- discover --name <name> --goal <goal> --input key=value
//   --input-type key:type:pattern --output key:type --app <id> --start <path>
//   --llm mock:<fixture> --tenant <id> [--headed]

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { BrowserSurface } from '../surface/browser-surface.js';
import { MockLLMClient, type FixtureEntry } from '../discovery/llm-client.js';
import { discover, type DiscoveryContract } from '../discovery/agent.js';
import { RunJournal } from '../evidence/journal.js';

export async function runDiscover(args: string[]): Promise<void> {
  const flags = new Map<string, string>();
  const inputs: Array<[string, string]> = [];
  const inputTypes: Array<[string, string, string?]> = [];
  const outputs: Array<[string, string]> = [];
  let headed = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--headed') { headed = true; continue; }
    if (args[i] === '--input' && args[i+1]) {
      const [k, v] = args[++i].split('=', 2);
      inputs.push([k, v]);
      continue;
    }
    if (args[i] === '--input-type' && args[i+1]) {
      const parts = args[++i].split(':');
      inputTypes.push([parts[0], parts[1], parts[2]]);
      continue;
    }
    if (args[i] === '--output' && args[i+1]) {
      const [k, v] = args[++i].split(':', 2);
      outputs.push([k, v]);
      continue;
    }
    if (args[i].startsWith('--') && args[i+1]) {
      flags.set(args[i].slice(2), args[++i]);
    }
  }

  const name = flags.get('name');
  const goal = flags.get('goal');
  const app = flags.get('app') || 'console';
  const start = flags.get('start') || '/login';
  const tenant = flags.get('tenant') || 'cascade-cu';
  const llmFlag = flags.get('llm') || '';

  if (!name || !goal) {
    console.error('Required: --name and --goal');
    process.exit(1);
  }

  // Build contract
  const contract: DiscoveryContract = {
    name, goal, app,
    startPath: start,
    inputs: {},
    outputs: {},
  };

  // Merge input declarations
  for (const [k, v] of inputs) {
    const typeInfo = inputTypes.find(([tk]) => tk === k);
    contract.inputs[k] = {
      type: typeInfo?.[1] || 'string',
      pattern: typeInfo?.[2],
      sensitive: k === 'username' || k === 'password',
      exampleValue: v,
    };
  }

  // Add implicit username/password if not declared
  if (!contract.inputs.username) {
    contract.inputs.username = { type: 'string', sensitive: true, exampleValue: process.env.CONSOLE_USER || 'operator' };
  }
  if (!contract.inputs.password) {
    contract.inputs.password = { type: 'string', sensitive: true, exampleValue: process.env.CONSOLE_PASS || 'demo123' };
  }

  for (const [k, v] of outputs) {
    contract.outputs[k] = { type: v, sensitive: v === 'money' };
  }

  // LLM client
  if (!llmFlag.startsWith('mock:')) {
    console.error('No LLM configured — Phase 6. Use --llm mock:<fixture.json>');
    process.exit(1);
  }

  const fixturePath = resolve(llmFlag.slice(5));
  const fixture: FixtureEntry[] = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const llmClient = new MockLLMClient(fixture);

  // Surface
  const baseUrl = process.env.CONSOLE_URL || 'http://localhost:3000';
  const policy = { allowedOrigins: [baseUrl], allowedRoutes: ['/t/*'], allowedVerbs: ['click','type','select','read','navigate'] };
  const surface = new BrowserSurface({ baseUrl, tenantPrefix: `/t/${tenant}`, policy, headed });

  // Journal (create a temporary artifact-like object for redaction)
  const tempArtifact = {
    name, version: '0.0.0',
    app: { id: app, startPath: start },
    inputs: Object.fromEntries(Object.entries(contract.inputs).map(([k, v]) => [k, { type: v.type, pattern: v.pattern, sensitive: v.sensitive }])),
    outputs: Object.fromEntries(Object.entries(contract.outputs).map(([k, v]) => [k, { type: v.type as any, sensitive: v.sensitive }])),
    businessOutcomes: {},
    steps: [{ id: 's0', intent: '', action: { verb: 'navigate' as const }, target: { chain: [], reasoning: '' }, risk: 'safe' as const, expect: { textPresent: '' } }],
  };
  const journalInputs = Object.fromEntries(Object.entries(contract.inputs).map(([k, v]) => [k, v.exampleValue]));
  const journal = new RunJournal(resolve('evidence/runs'), tempArtifact as any, journalInputs);
  (surface as any).config.screenshotDir = journal.runDir;

  try {
    await surface.launch();
    const result = await discover({ surface, llmClient, contract, journal, capabilitiesDir: resolve('capabilities') });
    console.log(JSON.stringify({ status: result.status, artifactPath: result.artifactPath, reason: result.reason }, null, 2));
    process.exit(result.status === 'compiled' ? 0 : 1);
  } finally {
    await surface.close();
  }
}
