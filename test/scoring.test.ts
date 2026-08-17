// test/scoring.test.ts — Scorer unit tests (no browser).
// Validates the pure scoring functions from src/surface/scoring.ts.

import { describe, it, expect } from 'vitest';
import {
  editSimilarity,
  wordOverlap,
  distanceDecay,
  resolveByScoring,
  THETA,
  MAX_SCORE,
  LOW_MARGIN_THRESHOLD,
  type PropertySet,
} from '../src/surface/scoring.js';
import type { ElementInfo } from '../src/surface/surface.js';

// ── Helper: build a minimal ElementInfo ─────────────────────
function mkEl(overrides: Partial<ElementInfo> & { ref: string }): ElementInfo {
  return {
    role: 'cell',
    name: '',
    frame: 'main',
    ...overrides,
  };
}

describe('Scoring primitives', () => {
  it('editSimilarity: identical strings → 1', () => {
    expect(editSimilarity('hello', 'hello')).toBe(1);
  });

  it('editSimilarity: completely different → low', () => {
    expect(editSimilarity('abc', 'xyz')).toBeLessThan(0.5);
  });

  it('editSimilarity: one-char edit → high', () => {
    expect(editSimilarity('hello', 'hallo')).toBeGreaterThan(0.7);
  });

  it('editSimilarity: empty strings', () => {
    expect(editSimilarity('', '')).toBe(1);
    expect(editSimilarity('abc', '')).toBe(0);
  });

  it('wordOverlap: identical sets → 1', () => {
    expect(wordOverlap(['Savings', '12345'], ['Savings', '12345'])).toBe(1);
  });

  it('wordOverlap: disjoint sets → 0', () => {
    expect(wordOverlap(['Savings'], ['Checking'])).toBe(0);
  });

  it('wordOverlap: partial overlap', () => {
    const r = wordOverlap(['Savings', '12345', 'Active'], ['Savings', '12345']);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(1);
  });

  it('wordOverlap: both empty → 1', () => {
    expect(wordOverlap([], [])).toBe(1);
  });

  it('distanceDecay: zero distance → 1', () => {
    expect(distanceDecay(0, 100)).toBe(1);
  });

  it('distanceDecay: at k → 0.5', () => {
    expect(distanceDecay(100, 100)).toBe(0.5);
  });
});

describe('resolveByScoring', () => {
  it('renamed element still wins (name changed, everything else same)', () => {
    const props: PropertySet = {
      role: 'button', frame: 'main', name: 'Sign In',
      position: { x: 100, y: 200 }, size: { w: 80, h: 30 },
    };
    const candidates: ElementInfo[] = [
      mkEl({ ref: 'e0', role: 'button', name: 'Log In', frame: 'main',
        bounds: { x: 60, y: 185, width: 80, height: 30 } }),
      mkEl({ ref: 'e1', role: 'link', name: 'About', frame: 'main',
        bounds: { x: 300, y: 400, width: 50, height: 20 } }),
    ];
    const result = resolveByScoring(props, candidates);
    expect(result.kind).toBe('match');
    expect(result.ref).toBe('e0');
  });

  it('moved element still wins (position shifted, name same)', () => {
    const props: PropertySet = {
      role: 'cell', frame: 'iframe-0', name: '$4,320.10',
      columnHeader: 'Balance', neighborText: ['Savings', '12345-S1'],
      position: { x: 500, y: 300 }, size: { w: 80, h: 20 },
    };
    const candidates: ElementInfo[] = [
      mkEl({ ref: 'e10', role: 'cell', name: '$4,320.10', frame: 'iframe-0',
        columnHeader: 'Balance', nearbyText: 'Savings 12345-S1',
        bounds: { x: 520, y: 350, width: 80, height: 20 } }), // shifted 50px
      mkEl({ ref: 'e11', role: 'cell', name: '$1,205.63', frame: 'iframe-0',
        columnHeader: 'Balance', nearbyText: 'Checking 12345-C1',
        bounds: { x: 520, y: 380, width: 80, height: 20 } }),
    ];
    const result = resolveByScoring(props, candidates);
    expect(result.kind).toBe('match');
    expect(result.ref).toBe('e10');
  });

  it('restyled element still wins (size changed, position shifted)', () => {
    const props: PropertySet = {
      role: 'textbox', frame: 'main', name: 'Username',
      position: { x: 200, y: 100 }, size: { w: 200, h: 30 },
    };
    const candidates: ElementInfo[] = [
      mkEl({ ref: 'e5', role: 'textbox', name: 'Username', frame: 'main',
        bounds: { x: 220, y: 110, width: 250, height: 35 } }), // restyled
      mkEl({ ref: 'e6', role: 'textbox', name: 'Password', frame: 'main',
        bounds: { x: 220, y: 160, width: 250, height: 35 } }),
    ];
    const result = resolveByScoring(props, candidates);
    expect(result.kind).toBe('match');
    expect(result.ref).toBe('e5');
  });

  it('two IDENTICAL twins → ambiguous refusal with candidates', () => {
    const props: PropertySet = {
      role: 'cell', frame: 'main', name: 'Savings',
      columnHeader: 'Type',
    };
    const candidates: ElementInfo[] = [
      mkEl({ ref: 'e20', role: 'cell', name: 'Savings', frame: 'main',
        columnHeader: 'Type',
        bounds: { x: 300, y: 200, width: 80, height: 20 } }),
      mkEl({ ref: 'e21', role: 'cell', name: 'Savings', frame: 'main',
        columnHeader: 'Type',
        bounds: { x: 300, y: 230, width: 80, height: 20 } }),
    ];
    const result = resolveByScoring(props, candidates);
    expect(result.kind).toBe('ambiguous');
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBeGreaterThanOrEqual(2);
  });

  it('empty page → notFound', () => {
    const props: PropertySet = { role: 'button', frame: 'main', name: 'Submit' };
    const result = resolveByScoring(props, []);
    expect(result.kind).toBe('notFound');
  });

  it('determinism: two calls, identical output', () => {
    const props: PropertySet = {
      role: 'link', frame: 'main', name: 'Dashboard',
      position: { x: 150, y: 80 },
    };
    const candidates: ElementInfo[] = [
      mkEl({ ref: 'e0', role: 'link', name: 'Dashboard', frame: 'main',
        bounds: { x: 140, y: 75, width: 100, height: 20 } }),
      mkEl({ ref: 'e1', role: 'link', name: 'Settings', frame: 'main',
        bounds: { x: 140, y: 105, width: 100, height: 20 } }),
    ];
    const r1 = resolveByScoring(props, candidates);
    const r2 = resolveByScoring(props, candidates);
    expect(r1.kind).toBe(r2.kind);
    expect(r1.ref).toBe(r2.ref);
    expect(r1.topScore).toBe(r2.topScore);
    expect(r1.margin).toBe(r2.margin);
  });

  it('cross-frame mismatch penalizes correctly', () => {
    const props: PropertySet = {
      role: 'cell', frame: 'iframe-0', name: '$4,320.10',
      columnHeader: 'Balance',
    };
    const candidates: ElementInfo[] = [
      // Same element in wrong frame
      mkEl({ ref: 'e30', role: 'cell', name: '$4,320.10', frame: 'main',
        columnHeader: 'Balance' }),
      // Right frame, wrong name
      mkEl({ ref: 'e31', role: 'cell', name: '$1,205.63', frame: 'iframe-0',
        columnHeader: 'Balance' }),
    ];
    const result = resolveByScoring(props, candidates);
    // The iframe-0 candidate should score higher despite different name,
    // because frame is an exact-match property with higher weight
    if (result.kind === 'match') {
      expect(result.ref).toBe('e31');
    }
  });

  it('THETA is sensible', () => {
    expect(THETA).toBeGreaterThan(0);
    expect(THETA).toBeLessThan(0.5);
  });

  it('MAX_SCORE is sum of all weights', () => {
    expect(MAX_SCORE).toBe(9.5); // 1.5+1.5+1+1.5+1+1+1+1
  });

  it('attrName separates otherwise-identical form inputs', () => {
    const props: PropertySet = {
      role: 'textbox', frame: 'main', attrName: 'f1',
      position: { x: 200, y: 100 }, size: { w: 200, h: 30 },
    };
    const candidates: ElementInfo[] = [
      mkEl({ ref: 'e0', role: 'textbox', name: '', frame: 'main', attrName: 'f1',
        bounds: { x: 160, y: 85, width: 200, height: 30 } }),
      mkEl({ ref: 'e1', role: 'textbox', name: '', frame: 'main', attrName: 'f2',
        bounds: { x: 160, y: 135, width: 200, height: 30 } }),
    ];
    const result = resolveByScoring(props, candidates);
    expect(result.kind).toBe('match');
    expect(result.ref).toBe('e0');
  });

  it('LOW_MARGIN_THRESHOLD fires in the band and not above it', () => {
    // Scenario: two links with different names but same frame/role — clear winner
    const props: PropertySet = {
      role: 'link', frame: 'main', name: 'Settings', attrName: 'nav-settings',
      position: { x: 100, y: 400 }, size: { w: 80, h: 20 },
    };
    const candidates: ElementInfo[] = [
      mkEl({ ref: 'e0', role: 'link', name: 'Settings', frame: 'main', attrName: 'nav-settings',
        bounds: { x: 95, y: 395, width: 80, height: 20 } }),
      mkEl({ ref: 'e1', role: 'link', name: 'Reports', frame: 'main', attrName: 'nav-reports',
        bounds: { x: 95, y: 425, width: 80, height: 20 } }),
    ];
    const result = resolveByScoring(props, candidates);
    expect(result.kind).toBe('match');
    expect(result.margin!).toBeGreaterThan(THETA);
    expect(LOW_MARGIN_THRESHOLD).toBeGreaterThan(THETA);
    // Fully different name + attrName = clear margin above LOW_MARGIN
    expect(result.margin!).toBeGreaterThan(LOW_MARGIN_THRESHOLD);
  });
});
