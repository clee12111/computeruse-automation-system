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
  const outputs: Array<[string, string, string?]> = [];
  let headed = false;
  let attended = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--headed') { headed = true; continue; }
    if (args[i] === '--attended') { attended = true; headed = true; continue; }
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
      const parts = args[++i].split(':');
      outputs.push([parts[0], parts[1], parts[2]]);
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
  const tenantRaw = flags.get('tenant') ?? 'cascade-cu';
  const tenant = tenantRaw === 'none' ? '' : tenantRaw;
  let llmFlag = flags.get('llm') || '';

  if (!name || !goal) {
    console.error('Required: --name and --goal');
    process.exit(1);
  }

  const appDesc = flags.get('app-description') || undefined;

  // Build contract
  const contract: DiscoveryContract = { name, goal, app, appDescription: appDesc, startPath: start, inputs: {}, outputs: {} };

  for (const [k, v] of inputs) {
    const typeInfo = inputTypes.find(t => t.name === k);
    contract.inputs[k] = {
      type: typeInfo?.type || 'string',
      pattern: typeInfo?.pattern,
      sensitive: typeInfo?.sensitive || k === 'username' || k === 'password',
      exampleValue: v,
    };
  }

  // Implicit username/password from env if not declared (no defaults — env must be set)
  if (!contract.inputs.username && process.env.CONSOLE_USER) {
    contract.inputs.username = { type: 'string', sensitive: true, exampleValue: process.env.CONSOLE_USER };
  }
  if (!contract.inputs.password && process.env.CONSOLE_PASS) {
    contract.inputs.password = { type: 'string', sensitive: true, exampleValue: process.env.CONSOLE_PASS };
  }

  for (const [k, v, pattern] of outputs) {
    contract.outputs[k] = { type: v, sensitive: v === 'money', pattern: pattern || undefined };
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
      appDescription: contract.appDescription,
    });
  } else {
    console.error('No LLM configured. Set OPENAI_API_KEY or use --llm mock:<fixture.json>');
    process.exit(1);
  }

  // Surface
  const baseUrl = process.env.CONSOLE_URL || process.env.MOCK_CONSOLE_URL || 'http://localhost:3000';
  const { loadPolicy } = await import('../guardrails/policy.js');
  const basePolicy = loadPolicy(resolve('config/policy.json'));
  const policy = { ...basePolicy, allowedOrigins: [...basePolicy.allowedOrigins, baseUrl] };
  const tenantPrefix = tenant ? `/t/${tenant}` : '';
  const surface = new BrowserSurface({ baseUrl, tenantPrefix, policy, headed });

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
    // Escalation channel for attended mode
    let channel: import('../escalation/intervention.js').EscalationChannel | undefined;
    if (attended) {
      const { TerminalChannel } = await import('../escalation/intervention.js');
      channel = new TerminalChannel();
    }
    const result = await discover({ surface, llmClient, contract, journal, capabilitiesDir: resolve('capabilities'), attended, channel });

    // Print total token usage if OpenAI
    if ('getTotalUsage' in llmClient) {
      const usage = (llmClient as any).getTotalUsage();
      console.error(`Total tokens: ${usage.totalTokens} (prompt: ${usage.promptTokens}, completion: ${usage.completionTokens})`);
      journal.event('token_summary', usage);
    }

    // Generate report — stored in journal dir alongside journal.jsonl
    const compiledArtifact = result.artifactPath
      ? JSON.parse(readFileSync(resolve(result.artifactPath), 'utf8'))
      : null;
    journal.writeDiscoveryReport(compiledArtifact);

    // Print report
    const jsonMode = args.includes('--json');
    if (jsonMode) {
      console.log(readFileSync(resolve(journal.runDir, 'report.json'), 'utf8'));
    } else {
      console.log(readFileSync(resolve(journal.runDir, 'report.md'), 'utf8'));
    }

    process.exit(result.status === 'compiled' ? 0 : 1);
  } finally {
    await surface.close();
  }
}
