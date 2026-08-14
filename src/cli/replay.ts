// src/cli/replay.ts — CLI replay subcommand.
// Usage: npm run cli -- replay <capability> --tenant <id> --<input> <value> [--headed]

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadArtifact } from '../schema/loader.js';
import { loadPolicy } from '../guardrails/policy.js';
import { BrowserSurface } from '../surface/browser-surface.js';
import { replay, validateInputs, InvalidInputError } from '../replay/engine.js';
import { RunJournal } from '../evidence/journal.js';

export async function runReplay(args: string[]): Promise<void> {
  // Parse args
  const capabilityName = args[0];
  if (!capabilityName) {
    console.error('Usage: replay <capability> --tenant <id> --<input> <value> [--headed]');
    process.exit(1);
  }

  const flags = new Map<string, string>();
  let headed = false;
  let attended = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--headed') { headed = true; continue; }
    if (args[i] === '--attended') { attended = true; headed = true; continue; }
    if (args[i].startsWith('--') && i + 1 < args.length) {
      flags.set(args[i].slice(2), args[i + 1]);
      i++;
    }
  }

  const tenant = flags.get('tenant') || 'cascade-cu';
  flags.delete('tenant');

  // Load artifact
  const artifactPath = resolve(`capabilities/${capabilityName}.v1.json`);
  if (!existsSync(artifactPath)) {
    console.error(`Artifact not found: ${artifactPath}`);
    process.exit(1);
  }
  const artifact = loadArtifact(artifactPath);

  // Build inputs from flags + env
  const inputs: Record<string, string> = {};
  for (const name of Object.keys(artifact.inputs)) {
    if (flags.has(name)) {
      inputs[name] = flags.get(name)!;
    } else if (name === 'username') {
      inputs[name] = process.env.CONSOLE_USER || 'operator';
    } else if (name === 'password') {
      inputs[name] = process.env.CONSOLE_PASS || 'demo123';
    }
  }

  // Pre-flight validation (before browser launch)
  try {
    validateInputs(artifact, inputs);
  } catch (e) {
    if (e instanceof InvalidInputError) {
      console.error(`INVALID_INPUT: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  // Load policy + create surface
  const policyPath = resolve('policy.json');
  const policy = loadPolicy(policyPath);
  const baseUrl = process.env.CONSOLE_URL || 'http://localhost:3000';

  const surface = new BrowserSurface({
    baseUrl,
    tenantPrefix: `/t/${tenant}`,
    policy: { ...policy, allowedOrigins: [baseUrl] },
    headed,
    screenshotDir: undefined, // set by journal
  });

  // Create evidence journal
  const evidenceDir = resolve('evidence/runs');
  const journal = new RunJournal(evidenceDir, artifact, inputs);

  // Update surface screenshot dir to journal's run dir
  (surface as any).config.screenshotDir = journal.runDir;

  try {
    await surface.launch();
    // Escalation channel for attended mode
    let channel: import('../escalation/intervention.js').EscalationChannel | undefined;
    if (attended) {
      const { TerminalChannel } = await import('../escalation/intervention.js');
      channel = new TerminalChannel();
    }

    const result = await replay({ surface, artifact, inputs, journal, stepTimeoutMs: 30000, tickMs: 250, attended, channel });

    // Add sensitive output values to redactor before writing result
    if (result.status === 'SUCCESS') {
      for (const [key, decl] of Object.entries(artifact.outputs)) {
        if (decl.sensitive && result.outputs[key] != null) {
          journal.addSensitiveOutput(String(result.outputs[key]));
        }
      }
    }

    journal.writeResult(result);
    console.log(JSON.stringify(result, null, 2));

    if (result.status === 'SUCCESS' || result.status === 'BUSINESS_OUTCOME') {
      process.exit(0);
    } else if (result.status === 'HARD_FAILURE') {
      process.exit(3);
    } else {
      process.exit(3);
    }
  } finally {
    await surface.close();
  }
}
