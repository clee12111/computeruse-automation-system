// src/guardrails/overlay.ts — Per-tenant vocabulary overlay.
// Artifacts are tenant-free. Overlays map vocabulary strings only.
// Any structural key (steps, verbs, properties) in an overlay is REJECTED.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CapabilityArtifact, Step, Predicate, Descriptor } from '../schema/artifact.js';

export interface Overlay {
  anchors?: Record<string, string>;  // descriptor anchor text mappings
  detects?: Record<string, string>;  // businessOutcome detect text mappings
  expects?: Record<string, string>;  // expect textPresent/Absent text mappings
}

const ALLOWED_KEYS = new Set(['anchors', 'detects', 'expects']);

export class OverlayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlayValidationError';
  }
}

export function loadOverlay(capName: string, version: string, tenant: string): Overlay | null {
  const path = resolve(`capabilities/overlays/${capName}@${version}.${tenant}.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8'));

  // Validate: only allowed keys, all values must be string→string
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new OverlayValidationError(`Overlay contains structural key "${key}" — overlays may ONLY map strings (anchors, detects, expects)`);
    }
    const section = raw[key];
    if (typeof section !== 'object') throw new OverlayValidationError(`Overlay key "${key}" must be an object`);
    for (const [k, v] of Object.entries(section)) {
      if (typeof v !== 'string') throw new OverlayValidationError(`Overlay ${key}["${k}"] must be a string, got ${typeof v}`);
    }
  }

  return raw as Overlay;
}

// Apply overlay to a CLONE of the artifact (never mutates the original)
export function applyOverlay(artifact: CapabilityArtifact, overlay: Overlay): { artifact: CapabilityArtifact; usedMappings: string[] } {
  const a = JSON.parse(JSON.stringify(artifact)) as CapabilityArtifact;
  const used: string[] = [];

  // Apply anchor mappings to target property strings
  if (overlay.anchors) {
    for (const step of a.steps) {
      const props = step.target.properties;
      // Map name
      if (props.name && overlay.anchors[props.name]) {
        used.push(`anchor: "${props.name}" → "${overlay.anchors[props.name]}"`);
        props.name = overlay.anchors[props.name];
      }
      // Map neighborText entries
      if (props.neighborText) {
        props.neighborText = props.neighborText.map(t => {
          if (overlay.anchors![t]) {
            used.push(`anchor: "${t}" → "${overlay.anchors![t]}"`);
            return overlay.anchors![t];
          }
          return t;
        });
      }
      // Map columnHeader
      if (props.columnHeader && overlay.anchors[props.columnHeader]) {
        used.push(`anchor: "${props.columnHeader}" → "${overlay.anchors[props.columnHeader]}"`);
        props.columnHeader = overlay.anchors[props.columnHeader];
      }
      // Apply to condition handler targets if present
      if (step.onCondition) {
        for (const handler of step.onCondition) {
          applyToPredicateStrings(handler.if, overlay, used);
        }
      }
    }
  }

  // Apply expect mappings to step expects
  if (overlay.expects) {
    for (const step of a.steps) {
      applyToPredicateStrings(step.expect, overlay, used);
    }
  }

  // Apply detect mappings to business outcomes
  if (overlay.detects) {
    for (const [code, outcome] of Object.entries(a.businessOutcomes)) {
      applyToPredicateStrings(outcome.detect, overlay, used);
    }
  }

  return { artifact: a, usedMappings: [...new Set(used)] };
}

function applyToPredicateStrings(pred: Predicate, overlay: Overlay, used: string[]): void {
  const p = pred as Record<string, unknown>;
  if ('textPresent' in p && typeof p.textPresent === 'string') {
    const maps = { ...overlay.expects, ...overlay.detects };
    if (maps[p.textPresent as string]) {
      used.push(`expect/detect: "${p.textPresent}" → "${maps[p.textPresent as string]}"`);
      p.textPresent = maps[p.textPresent as string];
    }
  }
  if ('textAbsent' in p && typeof p.textAbsent === 'string') {
    const maps = { ...overlay.expects, ...overlay.detects };
    if (maps[p.textAbsent as string]) {
      p.textAbsent = maps[p.textAbsent as string];
      used.push(`textAbsent: mapped`);
    }
  }
  if ('anyOf' in p && Array.isArray(p.anyOf)) {
    for (const sub of p.anyOf) applyToPredicateStrings(sub as Predicate, overlay, used);
  }
  if ('allOf' in p && Array.isArray(p.allOf)) {
    for (const sub of p.allOf) applyToPredicateStrings(sub as Predicate, overlay, used);
  }
}
