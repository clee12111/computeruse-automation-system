// src/surface/surface.ts — The Surface interface. Types only, no Playwright.
// DESIGN_MAP D2: "everything above it is surface-agnostic."
// No CSS selectors, no XPath — descriptors hold semantic/structural FIELDS.

import type { Descriptor, Predicate } from '../schema/artifact.js';

// ── Observation (what the Surface sees) ─────────────────────
export interface ElementInfo {
  ref: string;         // ephemeral reference (e1, e2, ...)
  role: string;        // ARIA role or implicit role
  name: string;        // accessible name or visible text
  nearbyText?: string; // closest label-like text
  columnHeader?: string; // for table cells: the column header text
  frame: string;       // 'main' or iframe identifier
  value?: string;      // current value (inputs, selects)
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface Observation {
  url: string;
  title: string;
  screenshotPath?: string;
  elements: ElementInfo[];
}

// ── Resolution result ───────────────────────────────────────
export interface RungReport {
  rungIndex: number;
  descriptor: Descriptor;
  count: number;
  reason: string; // "not found" | "ambiguous (N matches)" | "error: ..."
}

export type ResolveResult =
  | { kind: 'match'; ref: string; rungIndex: number }
  | { kind: 'ambiguous'; rungReports: RungReport[] }
  | { kind: 'notFound'; rungReports: RungReport[] };

// ── Policy violation ────────────────────────────────────────
export interface PolicyViolation {
  rule: string;      // "origin" | "route" | "verb"
  attempted: string;  // what was attempted
}

// ── Act result ──────────────────────────────────────────────
export type ActResult =
  | { ok: true; readValue?: string }
  | { ok: false; blocked?: PolicyViolation; error?: string };

// ── Surface configuration ───────────────────────────────────
export interface SurfaceConfig {
  baseUrl: string;         // e.g. "http://localhost:3000"
  tenantPrefix: string;    // e.g. "/t/cascade-cu" — the tenant-binding seam
  policy: Policy;
  headed?: boolean;
  screenshotDir?: string;
}

export interface Policy {
  allowedOrigins: string[];
  allowedRoutes: string[];  // path patterns, glob-style
  allowedVerbs: string[];
}

// ── The Surface interface ───────────────────────────────────
export interface Surface {
  /** Snapshot the current page state. */
  observe(): Promise<Observation>;

  /** Generate a descriptor chain for an element (best-first). */
  describe(ref: string): Promise<Descriptor[]>;

  /** Resolve a descriptor chain to an element ref (single DOM pass, no polling). */
  resolve(chain: Descriptor[]): Promise<ResolveResult>;

  /** Evaluate a predicate against the current page. */
  check(predicate: Predicate): Promise<boolean>;

  /** Execute an action. Guardrails enforced INSIDE this method. */
  act(action: { verb: string; value?: unknown; ref?: string }): Promise<ActResult>;

  /** Navigate to an app-relative path (Surface prefixes baseUrl + tenantPrefix). */
  navigate(path: string): Promise<ActResult>;

  /** Lifecycle. */
  launch(): Promise<void>;
  close(): Promise<void>;
}
