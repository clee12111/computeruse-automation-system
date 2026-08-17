// src/evidence/journal.ts — Per-run evidence capture.
// Writes journal.jsonl + result.json to evidence/runs/<ts>-<capability>/
// REDACTION: sensitive values masked ("•••") in ALL journal lines and files.
// Unmasked values appear ONLY in the returned result object.

import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityArtifact } from '../schema/artifact.js';
import type { ReplayResult } from '../schema/results.js';
import { generateReport, renderMarkdown } from './report.js';

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
  private artifact: any;

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
    this.artifact = artifact;
  }

  /** Update the stored artifact (discovery sets this after compiling). */
  setArtifact(artifact: any): void {
    this.artifact = artifact;
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

  scoringResult(stepId: string, data: { topScore: number; margin: number; matchedRole?: string; candidates?: any[] }): void {
    this.writeLine({ event: 'scoring_result', stepId, ...data });
    if (data.margin < 0.15) {
      this.writeLine({ event: 'low_margin_warning', stepId, margin: data.margin, topScore: data.topScore });
    }
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
    // result.json
    const resultJson = JSON.stringify(result, null, 2);
    const maskedJson = this.redactor.redact(resultJson);
    writeFileSync(join(this.runDir, 'result.json'), maskedJson);

    // report.json + report.md — ONE place, all callers go through writeResult.
    try {
      const journalText = readFileSync(this.journalPath, 'utf8');
      const events = journalText.split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      const report = generateReport(events, this.artifact, result);
      writeFileSync(join(this.runDir, 'report.json'), JSON.stringify(report, null, 2));
      writeFileSync(join(this.runDir, 'report.md'), renderMarkdown(report));
    } catch (e) {
      // Report generation must never fail the run
      console.error(`[journal] report generation failed: ${(e as Error).message}`);
    }
  }

  addSensitiveOutput(value: string): void {
    this.redactor.addSensitiveOutput(value);
  }

  /** Write report for discovery runs (which don't go through writeResult). */
  writeDiscoveryReport(compiledArtifact?: any): void {
    try {
      if (compiledArtifact) this.artifact = compiledArtifact;
      const journalText = readFileSync(this.journalPath, 'utf8');
      const events = journalText.split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      const report = generateReport(events, this.artifact, null);
      writeFileSync(join(this.runDir, 'report.json'), JSON.stringify(report, null, 2));
      writeFileSync(join(this.runDir, 'report.md'), renderMarkdown(report));
    } catch (e) {
      console.error(`[journal] discovery report failed: ${(e as Error).message}`);
    }
  }

  get screenshotDir(): string {
    return this.runDir;
  }
}
