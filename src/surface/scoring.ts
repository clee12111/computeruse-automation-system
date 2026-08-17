// src/surface/scoring.ts — Deterministic similarity scoring for element identity.
// ARCHITECTURE_V2 §3: replaces the 5-strategy ladder with multi-property scoring.
// Pure functions: (properties, candidates) → ranked scores. No randomness, no model.

import type { ElementInfo } from './surface.js';

// ── Property set (recorded at describe() time) ─────────────
export interface PropertySet {
  role: string;
  name?: string;
  attrName?: string;
  neighborText?: string[];
  columnHeader?: string;
  frame: string;
  position?: { x: number; y: number };
  size?: { w: number; h: number };
}

// ── Scoring weights (near-uniform; Ringer finding: learned weights don't transfer) ─
const W_ROLE = 1.5;          // exact-match — higher weight (Similo's split)
const W_FRAME = 1.5;         // exact-match
const W_NAME = 1.0;          // fuzzy
const W_COLUMN_HEADER = 1.0; // fuzzy
const W_ATTR_NAME = 1.5;      // exact-match (form element identity)
const W_NEIGHBOR_TEXT = 1.0;  // fuzzy (word overlap)
const W_POSITION = 1.0;      // distance decay
const W_SIZE = 1.0;           // distance decay

// Position/size distance decay constant
const K_POSITION = 100; // pixels — score halves at 100px displacement
const K_SIZE = 50;      // pixels — score halves at 50px size change

// ── THETA: minimum margin between top and runner-up ─────────
// Tuned against the 12.0 fixture bench:
//   θ=0.05: dense 91% / overall 97% — nearly all genuine twins separate
//   θ=0.10: dense 88% / overall 96% — marginal; some single-diff pairs refused
//   θ=0.15: dense 82% / overall 93% — too aggressive, refuses distinguishable pairs
// Chosen: 0.05 (permissive — prefer correct match over refusal; genuine twins
// still refuse because they score identically, giving margin=0 < 0.05).
export const THETA = 0.05;

// ── Similarity functions ────────────────────────────────────

/** Normalized Levenshtein edit distance similarity: 0 = no match, 1 = identical */
export function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  // Levenshtein via single-row DP
  const maxLen = Math.max(la, lb);
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const curr = [i];
    for (let j = 1; j <= lb; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return 1 - prev[lb] / maxLen;
}

/** Word-overlap ratio for neighborText arrays: |intersection| / |union| (Jaccard) */
export function wordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1; // both empty = match
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a.map(s => s.toLowerCase().trim()).filter(Boolean));
  const setB = new Set(b.map(s => s.toLowerCase().trim()).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) { if (setB.has(w)) intersection++; }
  return intersection / (setA.size + setB.size - intersection);
}

/** Distance decay: 1/(1 + dist/k) */
export function distanceDecay(dist: number, k: number): number {
  return 1 / (1 + Math.abs(dist) / k);
}

// ── Main scorer ─────────────────────────────────────────────

export interface CandidateScore {
  ref: string;
  score: number;
  breakdown: {
    role: number;
    frame: number;
    name: number;
    attrName: number;
    columnHeader: number;
    neighborText: number;
    position: number;
    size: number;
  };
}

/** Score a single candidate against the recorded property set. */
export function scoreCandidate(props: PropertySet, candidate: ElementInfo): number {
  const bd = scoreCandidateBreakdown(props, candidate);
  return bd.role * W_ROLE
    + bd.frame * W_FRAME
    + bd.name * W_NAME
    + bd.attrName * W_ATTR_NAME
    + bd.columnHeader * W_COLUMN_HEADER
    + bd.neighborText * W_NEIGHBOR_TEXT
    + bd.position * W_POSITION
    + bd.size * W_SIZE;
}

export function scoreCandidateBreakdown(props: PropertySet, candidate: ElementInfo): CandidateScore['breakdown'] {
  // Role: exact match
  const role = props.role === candidate.role ? 1 : 0;

  // Frame: exact match
  const frame = props.frame === candidate.frame ? 1 : 0;

  // Name: edit similarity (normalized)
  // When props.name is absent, the dimension is neutral (0.5) — "don't care"
  const name = props.name != null
    ? (candidate.name ? editSimilarity(props.name, candidate.name) : 0)
    : 0.5;

  // attrName: exact match (HTML name or id attribute)
  // When props.attrName is absent, neutral (0.5)
  const attrName = props.attrName != null
    ? (candidate.attrName ? (props.attrName === candidate.attrName ? 1 : 0) : 0)
    : 0.5;

  // Column header: edit similarity
  // When props.columnHeader is absent, neutral (0.5)
  const columnHeader = props.columnHeader != null
    ? (candidate.columnHeader ? editSimilarity(props.columnHeader, candidate.columnHeader) : 0)
    : 0.5;

  // Neighbor text: word overlap
  // When props.neighborText is absent, neutral (0.5)
  const candidateNeighbors = candidate.nearbyText
    ? candidate.nearbyText.split(/\s+/).filter(Boolean)
    : [];
  const neighborText = props.neighborText
    ? wordOverlap(props.neighborText, candidateNeighbors)
    : 0.5;

  // Position: distance decay (Euclidean)
  let position = 0.5; // neutral if either is missing
  if (props.position && candidate.bounds) {
    const dx = props.position.x - (candidate.bounds.x + (candidate.bounds.width || 0) / 2);
    const dy = props.position.y - (candidate.bounds.y + (candidate.bounds.height || 0) / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);
    position = distanceDecay(dist, K_POSITION);
  }

  // Size: distance decay (diagonal difference)
  let size = 0.5; // neutral if either is missing
  if (props.size && candidate.bounds) {
    const dw = props.size.w - (candidate.bounds.width || 0);
    const dh = props.size.h - (candidate.bounds.height || 0);
    const diag = Math.sqrt(dw * dw + dh * dh);
    size = distanceDecay(diag, K_SIZE);
  }

  return { role, frame, name, attrName, columnHeader, neighborText, position, size };
}

/** Maximum possible score (all properties perfect match). */
export const MAX_SCORE = W_ROLE + W_FRAME + W_NAME + W_ATTR_NAME + W_COLUMN_HEADER + W_NEIGHBOR_TEXT + W_POSITION + W_SIZE;

/** LOW_MARGIN threshold: fires a warning when margin is below this (telemetry, not refusal). */
export const LOW_MARGIN_THRESHOLD = 0.15;

export interface ScoringResult {
  kind: 'match' | 'ambiguous' | 'notFound';
  ref?: string;
  topScore?: number;
  margin?: number;
  candidates?: CandidateScore[];
}

/** Score all candidates and pick the winner using THETA margin. */
export function resolveByScoring(props: PropertySet, candidates: ElementInfo[]): ScoringResult {
  if (candidates.length === 0) {
    return { kind: 'notFound', candidates: [] };
  }

  const scored: CandidateScore[] = candidates.map(c => {
    const breakdown = scoreCandidateBreakdown(props, c);
    const score = breakdown.role * W_ROLE
      + breakdown.frame * W_FRAME
      + breakdown.name * W_NAME
      + breakdown.attrName * W_ATTR_NAME
      + breakdown.columnHeader * W_COLUMN_HEADER
      + breakdown.neighborText * W_NEIGHBOR_TEXT
      + breakdown.position * W_POSITION
      + breakdown.size * W_SIZE;
    return { ref: c.ref, score, breakdown };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  const runnerUp = scored.length > 1 ? scored[1] : null;
  const margin = runnerUp ? (top.score - runnerUp.score) / MAX_SCORE : 1;

  // Top 3 for reporting
  const top3 = scored.slice(0, 3);

  // Compute the maximum score achievable given which properties are specified.
  // Unspecified properties contribute 0.5 (neutral) to every candidate — they
  // inflate scores without discriminating. Only count specified properties' max.
  let specifiedMax = W_ROLE + W_FRAME; // always specified
  if (props.name != null) specifiedMax += W_NAME;
  if (props.attrName != null) specifiedMax += W_ATTR_NAME;
  if (props.columnHeader != null) specifiedMax += W_COLUMN_HEADER;
  if (props.neighborText != null) specifiedMax += W_NEIGHBOR_TEXT;
  if (props.position != null) specifiedMax += W_POSITION;
  if (props.size != null) specifiedMax += W_SIZE;
  // Neutral contribution from unspecified properties
  const neutralContrib = (MAX_SCORE - specifiedMax) * 0.5;
  const effectiveMax = specifiedMax + neutralContrib;
  // If the top score's specified-property contribution is below 60% of what's possible,
  // nothing on the page closely resembles the target
  if ((top.score - neutralContrib) < specifiedMax * 0.5) {
    return { kind: 'notFound', topScore: top.score, margin, candidates: top3 };
  }

  if (margin >= THETA) {
    return { kind: 'match', ref: top.ref, topScore: top.score, margin, candidates: top3 };
  }

  return { kind: 'ambiguous', topScore: top.score, margin, candidates: top3 };
}
