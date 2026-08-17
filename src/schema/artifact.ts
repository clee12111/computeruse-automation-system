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

// ── Property set (v2 — replaces the v1 descriptor chain) ────
// Recorded at describe() time from the observed element.
// resolve() scores every candidate against these properties.
// See ARCHITECTURE_V2.md §3 for design rationale.

export const PropertySetSchema = z.object({
  role: z.string(),
  name: z.string().optional(),
  attrName: z.string().optional(),
  neighborText: z.array(z.string()).optional(),
  columnHeader: z.string().optional(),
  frame: z.string(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  size: z.object({ w: z.number(), h: z.number() }).optional(),
}).refine(data => {
  // role + frame are always present (required). At least one additional property
  // recommended for non-navigate steps, but navigate targets legitimately have
  // only role + frame. Validation: role and frame must be non-empty.
  return data.role.length > 0 && data.frame.length > 0;
}, { message: 'PropertySet: role and frame must be non-empty' });

export type PropertySet = z.infer<typeof PropertySetSchema>;

// ── Legacy v1 Descriptor type (for type compatibility during migration) ───
// Not used in v2 artifacts; kept as a type alias for code that still
// references it (describe/resolve signature). Will be removed after 12.2b.
export type Descriptor = PropertySet;

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
// Extended to 1-2 actions (DESIGN_MAP: "extend only by demonstrated need" —
// demonstrated by the checkbox+Continue compliance interstitial pattern).

export const HandlerActionSchema = z.object({
  verb: z.enum(['click', 'type', 'select', 'read', 'navigate']),
  targetName: z.string(),
});
export type HandlerAction = z.infer<typeof HandlerActionSchema>;

export const ConditionHandlerSchema = z.object({
  if: PredicateSchema,
  do: z.union([HandlerActionSchema, z.tuple([HandlerActionSchema, HandlerActionSchema])]),
  maxApplies: z.number().int().positive(),
});
export type ConditionHandler = z.infer<typeof ConditionHandlerSchema>;

// ── Target ──────────────────────────────────────────────────
export const TargetSchema = z.object({
  properties: PropertySetSchema,
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
  pattern: z.string().optional(),
}).refine(data => {
  // String outputs MUST have a pattern — prevents "read a blob and call it done"
  if (data.type === 'string' && !data.pattern) return false;
  return true;
}, { message: 'String outputs must have a pattern to prevent unverified blob reads' });
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
  humanAssisted: z.boolean().optional(),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
