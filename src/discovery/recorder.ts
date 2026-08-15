// src/discovery/recorder.ts — The scribe + compiler.
// Records successful actions to ledger. Compiles ledger → CapabilityArtifact.
// Param lifting: declared input example values replaced with { $input: name }.
// Risk: rule-based (LLM never sets risk).

import type { Descriptor, Predicate, CapabilityArtifact } from '../schema/artifact.js';
import { loadArtifact, ArtifactValidationError } from '../schema/loader.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ── Ledger entry ────────────────────────────────────────────
export interface LedgerEntry {
  intent: string;
  verb: string;
  value?: string;
  chain: Descriptor[];
  expect: Predicate;
  outputName?: string;
  parseAs?: string;
  paramHint?: string;
  targetName?: string;     // accessible name of the target element (for risk check)
  targetIsPassword?: boolean;
}

// ── Risk assignment (rule-based, LLM never sets risk) ───────
const RISKY_BUTTON_PATTERN = /submit|open|confirm|execute|post|authorize/i;

function assignRisk(entry: LedgerEntry): 'safe' | 'risky' {
  // Risky = irreversible actions ONLY (not sensitive inputs like passwords)
  // Click on button whose name matches irreversible-action pattern
  if (entry.verb === 'click' && entry.targetName && RISKY_BUTTON_PATTERN.test(entry.targetName)) {
    return 'risky';
  }
  // Password typing is SENSITIVE (handled by redaction), NOT risky
  return 'safe';
}

// ── Recorder ────────────────────────────────────────────────
export class Recorder {
  private ledger: LedgerEntry[] = [];
  private outputs: Record<string, unknown> = {};

  record(entry: LedgerEntry): void {
    this.ledger.push(entry);
  }

  setOutput(name: string, value: unknown): void {
    this.outputs[name] = value;
  }

  getOutputs(): Record<string, unknown> {
    return { ...this.outputs };
  }

  getLedger(): LedgerEntry[] {
    return [...this.ledger];
  }

  // ── Compile ─────────────────────────────────────────────
  compile(contract: {
    name: string;
    app: string;
    startPath: string;
    inputs: Record<string, { type: string; pattern?: string; sensitive: boolean; exampleValue: string }>;
    outputs: Record<string, { type: string; sensitive: boolean }>;
  }): CapabilityArtifact {

    const steps = this.ledger.map((entry, i) => {
      // Param lifting: replace literal example values with $input bindings
      let value: unknown = entry.value;
      if (value != null) {
        for (const [inputName, inputDecl] of Object.entries(contract.inputs)) {
          if (String(value) === inputDecl.exampleValue) {
            value = { $input: inputName };
            break;
          }
        }
      }

      // Build action
      const action: Record<string, unknown> = { verb: entry.verb };
      if (value != null) action.value = value;
      if (entry.parseAs) action.parseAs = entry.parseAs;
      if (entry.outputName) action.saveTo = entry.outputName;

      // Scrub example values from intent strings
      let intent = entry.intent;
      for (const [inputName, inputDecl] of Object.entries(contract.inputs)) {
        if (inputDecl.exampleValue && intent.includes(inputDecl.exampleValue)) {
          intent = intent.split(inputDecl.exampleValue).join(`<${inputName}>`);
        }
      }

      return {
        id: `s${i + 1}`,
        intent,
        action,
        target: {
          chain: entry.chain,
          reasoning: 'Recorded from discovery run.',
        },
        risk: assignRisk(entry),
        expect: entry.expect,
      };
    });

    return {
      name: contract.name,
      version: '1.0.0',
      app: { id: contract.app, startPath: contract.startPath },
      inputs: Object.fromEntries(
        Object.entries(contract.inputs).map(([k, v]) => [k, {
          type: v.type,
          ...(v.pattern ? { pattern: v.pattern } : {}),
          sensitive: v.sensitive,
        }]),
      ),
      outputs: Object.fromEntries(
        Object.entries(contract.outputs).map(([k, v]) => [k, {
          type: v.type as 'money' | 'string' | 'date' | 'enum',
          sensitive: v.sensitive,
        }]),
      ),
      businessOutcomes: {},
      steps: steps as CapabilityArtifact['steps'],
    };
  }

  // ── Save compiled artifact ──────────────────────────────
  saveArtifact(artifact: CapabilityArtifact, capDir: string, evidenceDir?: string): string {
    mkdirSync(capDir, { recursive: true });
    const filePath = join(capDir, `${artifact.name}.v1.json`);
    const json = JSON.stringify(artifact, null, 2);
    writeFileSync(filePath, json);

    // Round-trip validation
    const loaded = loadArtifact(filePath);
    if (!loaded) throw new Error('Compiled artifact failed round-trip validation');

    // Also write to evidence dir if provided
    if (evidenceDir) {
      writeFileSync(join(evidenceDir, 'compiled-artifact.json'), json);
    }

    return filePath;
  }
}
