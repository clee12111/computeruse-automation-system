// src/discovery/llm-client.ts — The LLM seam.
// DESIGN_MAP D5: thin decide(context) → toolCall interface.
// MockLLMClient plays back JSON fixtures for zero-token tests.

import type { Predicate } from '../schema/artifact.js';
import type { Observation, ElementInfo } from '../surface/surface.js';

// ── Decision context (what the LLM sees) ────────────────────
export interface DecisionContext {
  goal: string;
  contract: { name: string; inputs: Record<string, { type: string }>; outputs: Record<string, { type: string }> };
  journal: string[];           // one-line summaries of past steps (incl. failures)
  observation: Observation;
}

// ── Tool calls (what the LLM returns) ───────────────────────
export interface ActToolCall {
  tool: 'act';
  verb: string;
  targetRef?: string;          // ref from current observation
  value?: string;
  outputName?: string;         // for read actions: which output to save to
  intent: string;
  expectProposal: Predicate;
  paramHint?: string;          // corroboration only — which input this value might be
}

export interface DoneToolCall {
  tool: 'done';
  summary: string;
}

export type ToolCall = ActToolCall | DoneToolCall;

// ── Interface ───────────────────────────────────────────────
export interface LLMClient {
  decide(ctx: DecisionContext): Promise<ToolCall>;
}

// ── Mock fixture entry ──────────────────────────────────────
export interface FixtureEntry {
  tool: 'act' | 'done';
  verb?: string;
  targetMatch?: { role?: string; name?: string; nearbyText?: string; frame?: string };
  value?: string;
  outputName?: string;
  intent?: string;
  expectProposal?: Predicate;
  paramHint?: string;
  summary?: string;
}

// ── MockLLMClient ───────────────────────────────────────────
export class MockLLMClient implements LLMClient {
  private entries: FixtureEntry[];
  private index = 0;

  constructor(entries: FixtureEntry[]) {
    this.entries = entries;
  }

  async decide(ctx: DecisionContext): Promise<ToolCall> {
    if (this.index >= this.entries.length) {
      return { tool: 'done', summary: 'Fixture exhausted' };
    }

    const entry = this.entries[this.index++];

    if (entry.tool === 'done') {
      return { tool: 'done', summary: entry.summary ?? 'Done' };
    }

    // Resolve targetMatch against current observation
    let targetRef: string | undefined;
    if (entry.targetMatch) {
      const m = entry.targetMatch;
      const el = ctx.observation.elements.find(e =>
        (!m.role || e.role === m.role) &&
        (!m.name || e.name.includes(m.name)) &&
        (!m.nearbyText || (e.nearbyText?.includes(m.nearbyText) ?? false)) &&
        (!m.frame || e.frame.includes(m.frame)),
      );
      targetRef = el?.ref;
    }

    return {
      tool: 'act',
      verb: entry.verb!,
      targetRef,
      value: entry.value,
      outputName: entry.outputName,
      intent: entry.intent ?? `${entry.verb} action`,
      expectProposal: entry.expectProposal ?? { textPresent: 'page' },
      paramHint: entry.paramHint,
    };
  }
}
