// src/schema/artifact.ts — Zod schemas for the capability artifact.
// Single source of truth. Matches capability-draft.json field names exactly.
// See DESIGN_MAP.md Decisions 3+7 for the locked design.

import { z } from 'zod';

// ── Value bindings ──────────────────────────────────────────
// Literal string OR { $input: "paramName" } reference
export const ValueBindingSchema = z.union([
  z.string(),
  z.object({ $input: z.string() }).strict(),
]);
export type ValueBinding = z.infer<typeof ValueBindingSchema>;

// ── Descriptor chain strategies ─────────────────────────────
// Discriminated union on "by" — each rung type has its own fields.
// Geometric must be flagged lastResort (DESIGN_MAP: "recorded but never trusted").

export const RoleNameDescriptor = z.object({
  by: z.literal('roleName'), role: z.string(), name: z.string(),
});
export const LabelProximityDescriptor = z.object({
  by: z.literal('labelProximity'), role: z.string(), anchor: z.string(),
});
export const TableCellDescriptor = z.object({
  by: z.literal('tableCell'), column: z.string(), rowContains: z.string(),
});
export const AnchorRelationDescriptor = z.object({
  by: z.literal('anchorRelation'), relation: z.string(), anchor: z.string(), match: z.string(),
});
export const StructuralDescriptor = z.object({
  by: z.literal('structural'), note: z.string(), near: z.string().optional(),
});
export const GeometricDescriptor = z.object({
  by: z.literal('geometric'), lastResort: z.literal(true),
}).passthrough(); // allow x, y, width, height etc. — shape not yet locked

export const DescriptorSchema = z.discriminatedUnion('by', [
  RoleNameDescriptor,
  LabelProximityDescriptor,
  TableCellDescriptor,
  AnchorRelationDescriptor,
  StructuralDescriptor,
  GeometricDescriptor,
]);
export type Descriptor = z.infer<typeof DescriptorSchema>;

// ── Predicates ──────────────────────────────────────────────
// Recursive union — each predicate is an object with exactly one key.
// anyOf/allOf enable composition. $outcome references a declared businessOutcome.

export type Predicate =
  | { textPresent: string }
  | { textAbsent: string }
  | { elementPresent: string }
  | { dialogPresent: string }
  | { urlMatches: string }
  | { outputPopulated: string }
  | { elementValue: { $self: true } }
  | { anyOf: Predicate[] }
  | { allOf: Predicate[] }
  | { $outcome: string };

export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ textPresent: z.string() }).strict(),
    z.object({ textAbsent: z.string() }).strict(),
    z.object({ elementPresent: z.string() }).strict(),
    z.object({ dialogPresent: z.string() }).strict(),
    z.object({ urlMatches: z.string() }).strict(),
    z.object({ outputPopulated: z.string() }).strict(),
    z.object({ elementValue: z.object({ $self: z.literal(true) }).strict() }).strict(),
    z.object({ anyOf: z.array(z.lazy(() => PredicateSchema)).min(1) }).strict(),
    z.object({ allOf: z.array(z.lazy(() => PredicateSchema)).min(1) }).strict(),
    z.object({ $outcome: z.string() }).strict(),
  ]),
);

// ── Actions ─────────────────────────────────────────────────
// 5 verbs: click, type, select, read, navigate.
// read requires parseAs + saveTo. type/select/navigate require value.

export const ActionSchema = z.object({
  verb: z.enum(['click', 'type', 'select', 'read', 'navigate']),
  value: ValueBindingSchema.optional(),
  parseAs: z.enum(['money', 'string', 'date', 'enum']).optional(),
  saveTo: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.verb === 'read') {
    if (!data.parseAs) ctx.addIssue({ code: 'custom', path: ['parseAs'], message: 'read action requires parseAs' });
    if (!data.saveTo) ctx.addIssue({ code: 'custom', path: ['saveTo'], message: 'read action requires saveTo' });
  }
  if (['type', 'select', 'navigate'].includes(data.verb) && data.value === undefined) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: `${data.verb} action requires value` });
  }
});
export type Action = z.infer<typeof ActionSchema>;

// ── Condition handlers ──────────────────────────────────────
// "handlers = 1 action max" — do is a single object, not an array.
// This structurally forbids 2 actions.

export const HandlerActionSchema = z.object({
  verb: z.enum(['click', 'type', 'select', 'read', 'navigate']),
  targetName: z.string(),
});
export type HandlerAction = z.infer<typeof HandlerActionSchema>;

export const ConditionHandlerSchema = z.object({
  if: PredicateSchema,
  do: HandlerActionSchema,
  maxApplies: z.number().int().positive(),
});
export type ConditionHandler = z.infer<typeof ConditionHandlerSchema>;

// ── Target ──────────────────────────────────────────────────
export const TargetSchema = z.object({
  chain: z.array(DescriptorSchema).min(1),
  reasoning: z.string(),
});
export type Target = z.infer<typeof TargetSchema>;

// ── Steps ───────────────────────────────────────────────────
export const StepSchema = z.object({
  id: z.string(),
  intent: z.string(),
  action: ActionSchema,
  target: TargetSchema,
  risk: z.enum(['safe', 'risky']),
  expect: PredicateSchema,
  onCondition: z.array(ConditionHandlerSchema).optional(),
});
export type Step = z.infer<typeof StepSchema>;

// ── Top-level blocks ────────────────────────────────────────

export const InputDeclSchema = z.object({
  type: z.string(),
  pattern: z.string().optional(),
  sensitive: z.boolean(),
});
export type InputDecl = z.infer<typeof InputDeclSchema>;

export const OutputDeclSchema = z.object({
  type: z.enum(['money', 'string', 'date', 'enum']),
  sensitive: z.boolean(),
});
export type OutputDecl = z.infer<typeof OutputDeclSchema>;

export const BusinessOutcomeSchema = z.object({
  detect: PredicateSchema,
});
export type BusinessOutcome = z.infer<typeof BusinessOutcomeSchema>;

export const AppSchema = z.object({
  id: z.string(),
  startPath: z.string(),
});

// ── Capability artifact (the whole thing) ────────────────────

export const CapabilityArtifactSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver (x.y.z)'),
  app: AppSchema,
  inputs: z.record(z.string(), InputDeclSchema),
  outputs: z.record(z.string(), OutputDeclSchema),
  businessOutcomes: z.record(z.string(), BusinessOutcomeSchema),
  steps: z.array(StepSchema).min(1),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
