// src/errors/schema.ts — Zod schema for the app-scoped error library.
// Each entry: detect predicate + recovery steps + resume strategy.

import { z } from 'zod';
import { PredicateSchema, StepSchema } from '../schema/artifact.js';

export const ErrorEntrySchema = z.object({
  detect: PredicateSchema,
  recovery: z.array(StepSchema).min(1),
  resume: z.literal('retry_current_step'),
  maxRecoveries: z.number().int().positive().default(1),
});

export type ErrorEntry = z.infer<typeof ErrorEntrySchema>;

export const ErrorLibrarySchema = z.record(z.string(), ErrorEntrySchema);
export type ErrorLibrary = z.infer<typeof ErrorLibrarySchema>;
