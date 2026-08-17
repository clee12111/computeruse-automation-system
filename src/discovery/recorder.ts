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
  properties: Descriptor;
  expect: Predicate;
  outputName?: string;
  parseAs?: string;
  paramHint?: string;
  targetName?: string;     // accessible name of the target element (for risk check)
  targetIsPassword?: boolean;
  forceRisky?: boolean;    // set when the risky-action gate approved the action
}

// ── Risk assignment (rule-based, LLM never sets risk) ───────
import { isRiskyTarget } from '../guardrails/risky.js';

function assignRisk(entry: LedgerEntry): 'safe' | 'risky' {
  if (entry.forceRisky) return 'risky';
  if ((entry.verb === 'click' || entry.verb === 'select') && entry.targetName && isRiskyTarget(entry.targetName)) {
    return 'risky';
  }
  // Password typing is SENSITIVE (handled by redaction), NOT risky
  return 'safe';
}

// ── Reasoning generator ────────────────────────────────
// Explains WHY each target element is identified this way and what makes it robust.
function buildReasoning(entry: LedgerEntry): string {
  const p = entry.properties;
  const parts: string[] = [];

  // Primary identification strategy
  if (entry.verb === 'navigate') {
    return 'URL-based navigation — no element resolution needed.';
  }

  // What identifies this element
  const identifiers: string[] = [];
  if (p.name) identifiers.push(`accessible name "${p.name}"`);
  if (p.attrName) identifiers.push(`HTML name attribute "${p.attrName}"`);
  if (p.columnHeader) identifiers.push(`column header "${p.columnHeader}"`);
  if (p.neighborText?.length) identifiers.push(`neighbor text [${p.neighborText.join(', ')}]`);

  if (identifiers.length > 0) {
    parts.push(`Identified by ${identifiers.join(' + ')}.`);
  } else {
    parts.push(`Identified by role "${p.role}" and position.`);
  }

  // Robustness factors
  const robust: string[] = [];
  const fragile: string[] = [];

  if (p.name) robust.push('accessible name (survives layout changes)');
  if (p.attrName) robust.push('HTML name attr (stable across reflows)');
  if (p.columnHeader) robust.push('column header (structural, not positional)');
  if (p.neighborText?.length) robust.push('neighbor text provides context if name changes');
  if (p.frame && p.frame !== 'main') robust.push(`scoped to frame "${p.frame}" (reduces ambiguity)`);

  if (p.position) fragile.push('position is a fallback — breaks on viewport/layout change');
  if (p.size) fragile.push('size used as tiebreaker only');
  if (!p.name && !p.attrName && !p.columnHeader) fragile.push('no semantic identifier — relies on role + position (fragile)');

  if (robust.length) parts.push(`Robust: ${robust.join('; ')}.`);
  if (fragile.length) parts.push(`Fragile: ${fragile.join('; ')}.`);

  // Scoring context
  parts.push(`Role: ${p.role}, frame: ${p.frame}.`);

  return parts.join(' ');
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
      // Param lifting: replace literal example values with $input bindings.
      // For sensitive inputs, the discovery agent records <sensitive:NAME> as the value
      // (real value is substituted only at act time). Match both forms.
      let value: unknown = entry.value;
      if (value != null) {
        for (const [inputName, inputDecl] of Object.entries(contract.inputs)) {
          const strVal = String(value);
          if (strVal === inputDecl.exampleValue || strVal === `<sensitive:${inputName}>`) {
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
          properties: entry.properties,
          reasoning: buildReasoning(entry),
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
        Object.entries(contract.outputs).map(([k, v]) => {
          const base = {
            type: v.type as 'money' | 'string' | 'date' | 'enum',
            sensitive: v.sensitive,
          };
          // String outputs must have a pattern (schema rule B).
          if (v.type === 'string') {
            return [k, { ...base, pattern: (v as any).pattern || '.{1,500}' }];
          }
          return [k, base];
        }),
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
