// src/evidence/journal.ts — Per-run evidence capture.
// Writes journal.jsonl + result.json to evidence/runs/<ts>-<capability>/
// REDACTION: sensitive values masked ("•••") in ALL journal lines and files.
// Unmasked values appear ONLY in the returned result object.

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityArtifact } from '../schema/artifact.js';
import type { ReplayResult } from '../schema/results.js';

export class Redactor {
  private sensitiveValues = new Set<string>();

  constructor(
    inputs: Record<string, string>,
    artifact: CapabilityArtifact,
  ) {
    // Mask input values declared sensitive
    for (const [name, decl] of Object.entries(artifact.inputs)) {
      if (decl.sensitive && inputs[name]) {
        this.sensitiveValues.add(inputs[name]);
      }
    }
  }

  addSensitiveOutput(value: string): void {
    this.sensitiveValues.add(value);
  }

  redact(text: string): string {
    let result = text;
    for (const v of this.sensitiveValues) {
      if (v.length > 0) result = result.split(v).join('\u2022\u2022\u2022');
    }
    return result;
  }
}

export class RunJournal {
  readonly runDir: string;
  private journalPath: string;
  private redactor: Redactor;

  constructor(
    evidenceBase: string,
    artifact: CapabilityArtifact,
    inputs: Record<string, string>,
  ) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.runDir = join(evidenceBase, `${ts}-${artifact.name}`);
    mkdirSync(this.runDir, { recursive: true });
    this.journalPath = join(this.runDir, 'journal.jsonl');
    this.redactor = new Redactor(inputs, artifact);
  }

  private writeLine(entry: Record<string, unknown>): void {
    const line = this.redactor.redact(JSON.stringify({
      ...entry,
      controller: 'machine',
      timestamp: new Date().toISOString(),
    }));
    appendFileSync(this.journalPath, line + '\n');
  }

  stepStart(stepId: string, intent: string): void {
    this.writeLine({ event: 'step_start', stepId, intent });
  }

  rungMatched(stepId: string, rungIndex: number): void {
    this.writeLine({ event: 'rung_matched', stepId, rungIndex });
  }

  event(type: string, data: Record<string, unknown>): void {
    this.writeLine({ event: type, ...data });
  }

  conditionHandled(stepId: string, targetName: string, remainingApplies: number): void {
    this.writeLine({ event: 'condition_handled', stepId, targetName, remainingApplies });
  }

  expectPassed(stepId: string): void {
    this.writeLine({ event: 'expect_passed', stepId });
  }

  outcomeDetected(stepId: string, code: string): void {
    this.writeLine({ event: 'outcome_detected', stepId, code });
  }

  writeResult(result: ReplayResult): void {
    // result.json: write the redacted result as-is (string replacement on JSON).
    // Rationale: result.json is an evidence file (auditable); the programmatic return
    // value is where the caller gets clear data. Sensitive values are masked.
    const resultJson = JSON.stringify(result, null, 2);
    const maskedJson = this.redactor.redact(resultJson);
    writeFileSync(join(this.runDir, 'result.json'), maskedJson);
  }

  addSensitiveOutput(value: string): void {
    this.redactor.addSensitiveOutput(value);
  }

  get screenshotDir(): string {
    return this.runDir;
  }
}
