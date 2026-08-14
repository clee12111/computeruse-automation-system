// src/schema/export-json-schema.ts — Emit JSON Schema from our Zod definitions.
// No external deps — hand-constructed to match the Zod schema structure.
// Run: npm run schema:export

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const predicateRef = { $ref: '#/$defs/Predicate' };
const valueBindingSchema = {
  oneOf: [
    { type: 'string' as const },
    { type: 'object' as const, properties: { $input: { type: 'string' as const } }, required: ['$input'], additionalProperties: false },
  ],
};

const schema = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  title: 'CapabilityArtifact',
  type: 'object' as const,
  required: ['name', 'version', 'app', 'inputs', 'outputs', 'businessOutcomes', 'steps'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' as const, minLength: 1 },
    version: { type: 'string' as const, pattern: '^\\d+\\.\\d+\\.\\d+$' },
    app: {
      type: 'object' as const,
      required: ['id', 'startPath'],
      properties: { id: { type: 'string' as const }, startPath: { type: 'string' as const } },
    },
    inputs: {
      type: 'object' as const,
      additionalProperties: {
        type: 'object' as const,
        required: ['type', 'sensitive'],
        properties: {
          type: { type: 'string' as const },
          pattern: { type: 'string' as const },
          sensitive: { type: 'boolean' as const },
        },
      },
    },
    outputs: {
      type: 'object' as const,
      additionalProperties: {
        type: 'object' as const,
        required: ['type', 'sensitive'],
        properties: {
          type: { type: 'string' as const, enum: ['money', 'string', 'date', 'enum'] },
          sensitive: { type: 'boolean' as const },
        },
      },
    },
    businessOutcomes: {
      type: 'object' as const,
      additionalProperties: {
        type: 'object' as const,
        required: ['detect'],
        properties: { detect: predicateRef },
      },
    },
    steps: {
      type: 'array' as const,
      minItems: 1,
      items: {
        type: 'object' as const,
        required: ['id', 'intent', 'action', 'target', 'risk', 'expect'],
        properties: {
          id: { type: 'string' as const },
          intent: { type: 'string' as const },
          action: {
            type: 'object' as const,
            required: ['verb'],
            properties: {
              verb: { type: 'string' as const, enum: ['click', 'type', 'select', 'read', 'navigate'] },
              value: valueBindingSchema,
              parseAs: { type: 'string' as const, enum: ['money', 'string', 'date', 'enum'] },
              saveTo: { type: 'string' as const },
            },
          },
          target: {
            type: 'object' as const,
            required: ['chain', 'reasoning'],
            properties: {
              chain: {
                type: 'array' as const, minItems: 1,
                items: {
                  type: 'object' as const, required: ['by'],
                  properties: { by: { type: 'string' as const, enum: ['roleName', 'labelProximity', 'tableCell', 'anchorRelation', 'structural', 'geometric'] } },
                },
              },
              reasoning: { type: 'string' as const },
            },
          },
          risk: { type: 'string' as const, enum: ['safe', 'risky'] },
          expect: predicateRef,
          onCondition: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              required: ['if', 'do', 'maxApplies'],
              properties: {
                if: predicateRef,
                do: {
                  type: 'object' as const,
                  required: ['verb', 'targetName'],
                  properties: {
                    verb: { type: 'string' as const, enum: ['click', 'type', 'select', 'read', 'navigate'] },
                    targetName: { type: 'string' as const },
                  },
                },
                maxApplies: { type: 'integer' as const, minimum: 1 },
              },
            },
          },
        },
      },
    },
  },
  $defs: {
    Predicate: {
      oneOf: [
        { type: 'object' as const, required: ['textPresent'], properties: { textPresent: { type: 'string' as const } }, additionalProperties: false },
        { type: 'object' as const, required: ['textAbsent'], properties: { textAbsent: { type: 'string' as const } }, additionalProperties: false },
        { type: 'object' as const, required: ['elementPresent'], properties: { elementPresent: { type: 'string' as const } }, additionalProperties: false },
        { type: 'object' as const, required: ['dialogPresent'], properties: { dialogPresent: { type: 'string' as const } }, additionalProperties: false },
        { type: 'object' as const, required: ['urlMatches'], properties: { urlMatches: { type: 'string' as const } }, additionalProperties: false },
        { type: 'object' as const, required: ['outputPopulated'], properties: { outputPopulated: { type: 'string' as const } }, additionalProperties: false },
        { type: 'object' as const, required: ['elementValue'], properties: { elementValue: { type: 'object' as const } }, additionalProperties: false },
        { type: 'object' as const, required: ['anyOf'], properties: { anyOf: { type: 'array' as const, items: predicateRef, minItems: 1 } }, additionalProperties: false },
        { type: 'object' as const, required: ['allOf'], properties: { allOf: { type: 'array' as const, items: predicateRef, minItems: 1 } }, additionalProperties: false },
        { type: 'object' as const, required: ['$outcome'], properties: { $outcome: { type: 'string' as const } }, additionalProperties: false },
      ],
    },
  },
};

const outPath = join(__dirname, 'artifact.schema.json');
writeFileSync(outPath, JSON.stringify(schema, null, 2) + '\n');
console.log(`JSON Schema written to ${outPath}`);
