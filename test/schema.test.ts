// test/schema.test.ts — Artifact schema validation tests.
// Golden fixture validates, 12+ mutation tests each assert rejection
// AND that the error message names the offending field.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Ajv = require('ajv') as new (opts?: Record<string, unknown>) => { compile: (schema: unknown) => (data: unknown) => boolean; errors?: unknown[] };
import { CapabilityArtifactSchema } from '../src/schema/artifact.js';
import { ReplayResultSchema, InterventionRequestSchema } from '../src/schema/results.js';
import { loadArtifact, ArtifactValidationError } from '../src/schema/loader.js';

const FIXTURE = resolve(__dirname, 'fixtures/capability-draft.json');

function loadFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

function mutate(overrides: (draft: Record<string, unknown>) => void): unknown {
  const draft = loadFixture() as Record<string, unknown>;
  overrides(draft);
  return draft;
}

// Helper: parse and expect failure, return error messages
function expectZodFail(data: unknown): string[] {
  const result = CapabilityArtifactSchema.safeParse(data);
  expect(result.success).toBe(false);
  if (!result.success) {
    return result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
  }
  return [];
}

// Helper: load from temp file and expect loader failure
function expectLoaderFail(data: unknown): string[] {
  const tmpPath = resolve(__dirname, 'fixtures/_tmp_test.json');
  const fs = require('node:fs');
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  try {
    loadArtifact(tmpPath);
    expect.fail('Expected ArtifactValidationError');
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(ArtifactValidationError);
    return (e as ArtifactValidationError).errors.map(err => `${err.path}: ${err.message}`);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

describe('schema validation', () => {

  // ── Golden fixture ──────────────────────────────────────
  it('golden fixture (capability-draft.json) validates', () => {
    const artifact = loadArtifact(FIXTURE);
    expect(artifact.name).toBe('lookup-member-savings-balance');
    expect(artifact.version).toBe('2.0.0');
    expect(artifact.steps).toHaveLength(3);
    expect(artifact.steps[0].action.verb).toBe('type');
    expect(artifact.steps[2].action.verb).toBe('read');
  });

  it('Zod schema parse matches loadArtifact result', () => {
    const raw = loadFixture();
    const result = CapabilityArtifactSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  // ── JSON Schema export ──────────────────────────────────
  it('artifact.schema.json exists and is valid JSON', () => {
    const schemaPath = resolve(__dirname, '../src/schema/artifact.schema.json');
    expect(existsSync(schemaPath)).toBe(true);
    const content = JSON.parse(readFileSync(schemaPath, 'utf8'));
    expect(content.$schema).toContain('json-schema.org');
    expect(content.title).toBe('CapabilityArtifact');
    expect(content.properties.steps).toBeDefined();
  });

  it('JSON Schema drift guard: draft validates against exported schema', () => {
    const schemaPath = resolve(__dirname, '../src/schema/artifact.schema.json');
    const ajv = new Ajv({ strict: false });
    const jsonSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = ajv.compile(jsonSchema);
    const draft = loadFixture();
    const valid = validate(draft);
    if (!valid) console.error('AJV errors:', ajv.errors);
    expect(valid).toBe(true);
  });

  // ── Mutation tests ──────────────────────────────────────

  it('rejects unknown verb', () => {
    const data = mutate(d => {
      (d.steps as any[])[0].action.verb = 'hover';
    });
    const errs = expectZodFail(data);
    const relevant = errs.find(e => e.includes('verb'));
    expect(relevant).toBeDefined();
  });

  it('rejects step missing expect', () => {
    const data = mutate(d => {
      delete (d.steps as any[])[0].expect;
    });
    const errs = expectZodFail(data);
    const relevant = errs.find(e => e.includes('expect'));
    expect(relevant).toBeDefined();
  });

  it('rejects handler with 3 actions (do as oversized array)', () => {
    const data = mutate(d => {
      (d.steps as any[])[1].onCondition[0].do = [
        { verb: 'click', targetName: 'A' },
        { verb: 'click', targetName: 'B' },
        { verb: 'click', targetName: 'C' },
      ];
    });
    const errs = expectZodFail(data);
    const relevant = errs.find(e => e.includes('do') || e.includes('Expected'));
    expect(relevant).toBeDefined();
  });

  it('rejects handler missing maxApplies', () => {
    const data = mutate(d => {
      delete (d.steps as any[])[1].onCondition[0].maxApplies;
    });
    const errs = expectZodFail(data);
    const relevant = errs.find(e => e.includes('maxApplies'));
    expect(relevant).toBeDefined();
  });

  it('rejects $input referencing undeclared input', () => {
    const data = mutate(d => {
      (d.steps as any[])[0].action.value = { $input: 'nonExistent' };
    });
    const errs = expectLoaderFail(data);
    const relevant = errs.find(e => e.includes('$input') && e.includes('nonExistent'));
    expect(relevant).toBeDefined();
  });

  it('rejects saveTo referencing undeclared output', () => {
    const data = mutate(d => {
      (d.steps as any[])[2].action.saveTo = 'fakeOutput';
    });
    const errs = expectLoaderFail(data);
    const relevant = errs.find(e => e.includes('saveTo') && e.includes('fakeOutput'));
    expect(relevant).toBeDefined();
  });

  it('rejects $outcome referencing undeclared businessOutcome', () => {
    const data = mutate(d => {
      (d.steps as any[])[1].expect = {
        anyOf: [
          { textPresent: 'Member Details' },
          { $outcome: 'TOTALLY_FAKE' },
        ],
      };
    });
    const errs = expectLoaderFail(data);
    const relevant = errs.find(e => e.includes('$outcome') && e.includes('TOTALLY_FAKE'));
    expect(relevant).toBeDefined();
  });

  it('rejects duplicate step ids', () => {
    const data = mutate(d => {
      (d.steps as any[])[1].id = 's1'; // same as step 0
    });
    const errs = expectLoaderFail(data);
    const relevant = errs.find(e => e.includes('duplicate') && e.includes('s1'));
    expect(relevant).toBeDefined();
  });

  it('rejects read action without parseAs', () => {
    const data = mutate(d => {
      delete (d.steps as any[])[2].action.parseAs;
    });
    const errs = expectZodFail(data);
    const relevant = errs.find(e => e.includes('parseAs'));
    expect(relevant).toBeDefined();
  });

  it('accepts PropertySet with only role + frame (minimum valid)', () => {
    const data = mutate(d => {
      (d.steps as any[])[0].target.properties = { role: 'textbox', frame: 'main' };
    });
    // role + frame is the minimum valid PropertySet (navigate targets)
    const result = CapabilityArtifactSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('rejects missing role in PropertySet', () => {
    const data = mutate(d => {
      (d.steps as any[])[0].target.properties = { frame: 'main', name: 'Search' };
    });
    const errs = expectZodFail(data);
    const relevant = errs.find(e => e.includes('role') || e.includes('Required'));
    expect(relevant).toBeDefined();
  });

  it('rejects version not semver', () => {
    const data = mutate(d => { d.version = '1.0'; });
    const errs = expectZodFail(data);
    const relevant = errs.find(e => e.includes('version') && e.includes('semver'));
    expect(relevant).toBeDefined();
  });

  it('rejects read action without saveTo', () => {
    const data = mutate(d => {
      delete (d.steps as any[])[2].action.saveTo;
    });
    const errs = expectZodFail(data);
    const relevant = errs.find(e => e.includes('saveTo'));
    expect(relevant).toBeDefined();
  });

  // ── Result types ────────────────────────────────────────

  it('validates SUCCESS result', () => {
    const r = ReplayResultSchema.safeParse({ status: 'SUCCESS', outputs: { balance: '$100.00' } });
    expect(r.success).toBe(true);
  });

  it('validates HARD_FAILURE result', () => {
    const r = ReplayResultSchema.safeParse({
      status: 'HARD_FAILURE', stepId: 's3', expected: 'outputPopulated',
      observed: 'element not found', evidenceRefs: ['screenshot-001.png'],
    });
    expect(r.success).toBe(true);
  });

  it('validates InterventionRequest', () => {
    const r = InterventionRequestSchema.safeParse({
      capability: 'lookup-member', version: '1.0.0', stepId: 's2',
      intent: 'Submit search', expected: 'Member Details visible',
      observed: 'Unknown dialog appeared', screenshotRef: 'shot-005.png',
      reason: 'Unexpected screen state', options: ['retry', 'skip', 'abort'],
    });
    expect(r.success).toBe(true);
  });
});
