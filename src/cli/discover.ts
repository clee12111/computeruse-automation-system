// src/cli/discover.ts — CLI discover subcommand.
// --llm openai (default when OPENAI_API_KEY set) or --llm mock:<fixture.json>
// --input-type format: key:type:pattern:sensitive (4th field optional)

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { BrowserSurface } from '../surface/browser-surface.js';
import { MockLLMClient, type FixtureEntry, type LLMClient } from '../discovery/llm-client.js';
import { discover, type DiscoveryContract } from '../discovery/agent.js';
import { RunJournal } from '../evidence/journal.js';
import { loadEnvFile } from '../discovery/openai-client.js';

export async function runDiscover(args: string[]): Promise<void> {
  // Load .env before processing args
  loadEnvFile(resolve(process.cwd(), '.env'));

  const flags = new Map<string, string>();
  const inputs: Array<[string, string]> = [];
  const inputTypes: Array<{ name: string; type: string; pattern?: string; sensitive?: boolean }> = [];
  const outputs: Array<[string, string]> = [];
  let headed = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--headed') { headed = true; continue; }
    if (args[i] === '--input' && args[i+1]) {
      const [k, ...rest] = args[++i].split('=');
      inputs.push([k, rest.join('=')]);
      continue;
    }
    if (args[i] === '--input-type' && args[i+1]) {
      const parts = args[++i].split(':');
      inputTypes.push({
        name: parts[0],
        type: parts[1] || 'string',
        pattern: parts[2] || undefined,
        sensitive: parts[3] === 'sensitive',
      });
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
  let llmFlag = flags.get('llm') || '';

  if (!name || !goal) {
    console.error('Required: --name and --goal');
    process.exit(1);
  }

  // Build contract
  const contract: DiscoveryContract = { name, goal, app, startPath: start, inputs: {}, outputs: {} };

  for (const [k, v] of inputs) {
    const typeInfo = inputTypes.find(t => t.name === k);
    contract.inputs[k] = {
      type: typeInfo?.type || 'string',
      pattern: typeInfo?.pattern,
      sensitive: typeInfo?.sensitive || k === 'username' || k === 'password',
      exampleValue: v,
    };
  }

  // Implicit username/password from env if not declared
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
  let llmClient: LLMClient;

  if (llmFlag.startsWith('mock:')) {
    const fixturePath = resolve(llmFlag.slice(5));
    const fixture: FixtureEntry[] = JSON.parse(readFileSync(fixturePath, 'utf8'));
    llmClient = new MockLLMClient(fixture);
  } else if (llmFlag === 'openai' || (!llmFlag && process.env.OPENAI_API_KEY)) {
    const { OpenAIClient } = await import('../discovery/openai-client.js');
    llmClient = new OpenAIClient({
      onUsage: (turn, usage) => {
        console.error(`  [turn ${turn}] tokens: ${usage.promptTokens}+${usage.completionTokens}=${usage.totalTokens}`);
      },
    });
  } else {
    console.error('No LLM configured. Set OPENAI_API_KEY or use --llm mock:<fixture.json>');
    process.exit(1);
  }

  // Surface
  const baseUrl = process.env.CONSOLE_URL || process.env.MOCK_CONSOLE_URL || 'http://localhost:3000';
  const policy = { allowedOrigins: [baseUrl], allowedRoutes: ['/t/*'], allowedVerbs: ['click','type','select','read','navigate'] };
  const surface = new BrowserSurface({ baseUrl, tenantPrefix: `/t/${tenant}`, policy, headed });

  // Journal
  const tempArtifact = {
    name, version: '0.0.0', app: { id: app, startPath: start },
    inputs: Object.fromEntries(Object.entries(contract.inputs).map(([k, v]) => [k, { type: v.type, pattern: v.pattern, sensitive: v.sensitive }])),
    outputs: Object.fromEntries(Object.entries(contract.outputs).map(([k, v]) => [k, { type: v.type as any, sensitive: v.sensitive }])),
    businessOutcomes: {},
    steps: [{ id: 's0', intent: '', action: { verb: 'navigate' as const }, target: { chain: [{ by: 'structural' as const, note: 'x' }], reasoning: '' }, risk: 'safe' as const, expect: { textPresent: '' } }],
  };
  const journalInputs = Object.fromEntries(Object.entries(contract.inputs).map(([k, v]) => [k, v.exampleValue]));
  const journal = new RunJournal(resolve('evidence/runs'), tempArtifact as any, journalInputs);
  (surface as any).config.screenshotDir = journal.runDir;

  console.error(`Discovery: ${name}`);
  console.error(`Evidence: ${journal.runDir}`);

  try {
    await surface.launch();
    const result = await discover({ surface, llmClient, contract, journal, capabilitiesDir: resolve('capabilities') });

    // Print total token usage if OpenAI
    if ('getTotalUsage' in llmClient) {
      const usage = (llmClient as any).getTotalUsage();
      console.error(`Total tokens: ${usage.totalTokens} (prompt: ${usage.promptTokens}, completion: ${usage.completionTokens})`);
      journal.event('token_summary', usage);
    }

    console.log(JSON.stringify({ status: result.status, artifactPath: result.artifactPath, reason: result.reason }, null, 2));
    process.exit(result.status === 'compiled' ? 0 : 1);
  } finally {
    await surface.close();
  }
}
