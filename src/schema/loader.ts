// src/schema/loader.ts — Load and validate a capability artifact from JSON.
// Returns a typed artifact or a POINTED error (which field, what's wrong).
// Cross-field checks beyond raw Zod: $input/$saveTo/$outcome references,
// unique step IDs, read actions require parseAs+saveTo.

import { readFileSync } from 'node:fs';
import { ZodError } from 'zod';
import { CapabilityArtifactSchema, type CapabilityArtifact, type ValueBinding } from './artifact.js';

export class ArtifactValidationError extends Error {
  constructor(public readonly errors: Array<{ path: string; message: string }>) {
    const summary = errors.map(e => `  ${e.path}: ${e.message}`).join('\n');
    super(`Artifact validation failed:\n${summary}`);
    this.name = 'ArtifactValidationError';
  }
}

export function loadArtifact(filePath: string): CapabilityArtifact {
  const raw = readFileSync(filePath, 'utf8');
  const json = JSON.parse(raw);

  // Phase 1: Zod structural validation
  const result = CapabilityArtifactSchema.safeParse(json);
  if (!result.success) {
    throw new ArtifactValidationError(
      result.error.errors.map(e => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    );
  }

  const artifact = result.data;
  const crossErrors: Array<{ path: string; message: string }> = [];

  // Phase 2: Cross-field validation

  // Check step IDs are unique
  const stepIds = new Set<string>();
  for (let i = 0; i < artifact.steps.length; i++) {
    const id = artifact.steps[i].id;
    if (stepIds.has(id)) {
      crossErrors.push({ path: `steps[${i}].id`, message: `duplicate step id "${id}"` });
    }
    stepIds.add(id);
  }

  // Check $input references resolve to declared inputs
  for (let i = 0; i < artifact.steps.length; i++) {
    const step = artifact.steps[i];
    const val = step.action.value;
    if (val && typeof val === 'object' && '$input' in val) {
      const inputName = (val as { $input: string }).$input;
      if (!(inputName in artifact.inputs)) {
        crossErrors.push({
          path: `steps[${i}].action.value.$input`,
          message: `$input "${inputName}" references undeclared input (declared: ${Object.keys(artifact.inputs).join(', ') || 'none'})`,
        });
      }
    }
  }

  // Check saveTo references resolve to declared outputs
  for (let i = 0; i < artifact.steps.length; i++) {
    const step = artifact.steps[i];
    if (step.action.saveTo) {
      if (!(step.action.saveTo in artifact.outputs)) {
        crossErrors.push({
          path: `steps[${i}].action.saveTo`,
          message: `saveTo "${step.action.saveTo}" references undeclared output (declared: ${Object.keys(artifact.outputs).join(', ') || 'none'})`,
        });
      }
    }
  }

  // Check $outcome references in predicates resolve to declared businessOutcomes
  function checkPredicateOutcomes(pred: unknown, path: string): void {
    if (!pred || typeof pred !== 'object') return;
    const p = pred as Record<string, unknown>;
    if ('$outcome' in p) {
      const code = p.$outcome as string;
      if (!(code in artifact.businessOutcomes)) {
        crossErrors.push({
          path,
          message: `$outcome "${code}" references undeclared businessOutcome (declared: ${Object.keys(artifact.businessOutcomes).join(', ') || 'none'})`,
        });
      }
    }
    if ('anyOf' in p && Array.isArray(p.anyOf)) {
      p.anyOf.forEach((sub, j) => checkPredicateOutcomes(sub, `${path}.anyOf[${j}]`));
    }
    if ('allOf' in p && Array.isArray(p.allOf)) {
      p.allOf.forEach((sub, j) => checkPredicateOutcomes(sub, `${path}.allOf[${j}]`));
    }
  }

  for (let i = 0; i < artifact.steps.length; i++) {
    checkPredicateOutcomes(artifact.steps[i].expect, `steps[${i}].expect`);
    if (artifact.steps[i].onCondition) {
      for (let j = 0; j < artifact.steps[i].onCondition!.length; j++) {
        checkPredicateOutcomes(artifact.steps[i].onCondition![j].if, `steps[${i}].onCondition[${j}].if`);
      }
    }
  }

  if (crossErrors.length > 0) {
    throw new ArtifactValidationError(crossErrors);
  }

  return artifact;
}
