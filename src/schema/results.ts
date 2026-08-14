// src/schema/results.ts — Replay result contract + intervention types.
// DESIGN_MAP Decision 7: SUCCESS | BUSINESS_OUTCOME | ESCALATED | HARD_FAILURE.

import { z } from 'zod';

// ── Result enum (discriminated union on "status") ───────────

export const SuccessResultSchema = z.object({
  status: z.literal('SUCCESS'),
  outputs: z.record(z.string(), z.unknown()),
});

export const BusinessOutcomeResultSchema = z.object({
  status: z.literal('BUSINESS_OUTCOME'),
  code: z.string(),
  details: z.string().optional(),
});

export const EscalatedResultSchema = z.object({
  status: z.literal('ESCALATED'),
  resolution: z.string(),
  notes: z.string().optional(),
});

export const HardFailureResultSchema = z.object({
  status: z.literal('HARD_FAILURE'),
  stepId: z.string(),
  expected: z.string(),
  observed: z.string(),
  evidenceRefs: z.array(z.string()),
});

export const ReplayResultSchema = z.discriminatedUnion('status', [
  SuccessResultSchema,
  BusinessOutcomeResultSchema,
  EscalatedResultSchema,
  HardFailureResultSchema,
]);
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

// ── Controller state ────────────────────────────────────────
// Tracks who is currently driving the session (DESIGN_MAP D8).
export const ControllerStateSchema = z.enum(['machine', 'human']);
export type ControllerState = z.infer<typeof ControllerStateSchema>;

// ── Intervention request ────────────────────────────────────
// Emitted when the engine needs a human to take over.
export const InterventionRequestSchema = z.object({
  capability: z.string(),
  version: z.string(),
  stepId: z.string(),
  intent: z.string(),
  expected: z.string(),
  observed: z.string(),
  screenshotRef: z.string(),
  reason: z.string(),
  options: z.array(z.enum(['retry', 'skip', 'abort'])),
});
export type InterventionRequest = z.infer<typeof InterventionRequestSchema>;
