// src/replay/engine.ts — ReplayEngine per-step FSM.
// DESIGN_MAP D6: condition-polled, whole-chain-per-tick, fixed arbitration order.
// No LLM anywhere. Replay never waits for time, it waits for truth.

import type { CapabilityArtifact, Predicate, Step, ConditionHandler } from '../schema/artifact.js';
import type { ReplayResult, InterventionRequest } from '../schema/results.js';
import type { Surface, ResolveResult } from '../surface/surface.js';
import type { RunJournal } from '../evidence/journal.js';
import type { EscalationChannel, HandbackClaim } from '../escalation/intervention.js';
import { getTrustStatus } from '../guardrails/trust.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

export interface EngineConfig {
  surface: Surface;
  artifact: CapabilityArtifact;
  inputs: Record<string, string>;
  journal: RunJournal;
  stepTimeoutMs?: number;  // default 30000
  tickMs?: number;         // default 250
  attended?: boolean;       // attended mode: escalate instead of hard-fail
  channel?: EscalationChannel; // the escalation channel (required if attended)
}

// ── Pre-flight: validate inputs BEFORE launching browser ────
export function validateInputs(
  artifact: CapabilityArtifact,
  inputs: Record<string, string>,
): void {
  for (const [name, decl] of Object.entries(artifact.inputs)) {
    if (!(name in inputs)) {
      throw new InvalidInputError(`Missing required input: "${name}"`);
    }
    if (decl.pattern) {
      const re = new RegExp(decl.pattern);
      if (!re.test(inputs[name])) {
        throw new InvalidInputError(
          `Input "${name}" value "${inputs[name]}" does not match pattern ${decl.pattern}`,
        );
      }
    }
  }
}

// ── Value binding ───────────────────────────────────────────
function bindValue(
  value: unknown,
  inputs: Record<string, string>,
): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && '$input' in value) {
    const key = (value as { $input: string }).$input;
    return inputs[key] ?? '';
  }
  return String(value ?? '');
}

// ── Money parser ────────────────────────────────────────────
function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null; // strict: digits and optional decimal only
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : Math.round(num * 100) / 100;
}

function parseValue(raw: string, parseAs: string): unknown {
  switch (parseAs) {
    case 'money': return parseMoney(raw);
    case 'string': return raw;
    case 'date': return raw; // pass through for now
    case 'enum': return raw;
    default: return raw;
  }
}

// ── Predicate checking (with engine context) ────────────────
async function checkPredicate(
  pred: Predicate,
  surface: Surface,
  outputs: Record<string, unknown>,
  lastTypedValue?: string,
  lastActionRef?: string,
): Promise<boolean> {
  const p = pred as Record<string, unknown>;

  if ('outputPopulated' in p) {
    const key = p.outputPopulated as string;
    return key in outputs && outputs[key] != null;
  }

  if ('elementValue' in p) {
    // { $self: true } — the element just acted on contains the value we set.
    // For type/select actions, fill/selectOption are synchronous with the DOM.
    return lastTypedValue != null;
  }

  return surface.check(pred);
}

// ── Delay helper (NOT a sleep — it's a poll tick interval) ───
function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── The engine ──────────────────────────────────────────────
export async function replay(config: EngineConfig): Promise<ReplayResult> {
  const { surface, artifact, inputs, journal } = config;
  const stepTimeout = config.stepTimeoutMs ?? 30000;
  const tickMs = config.tickMs ?? 250;
  const outputs: Record<string, unknown> = {};

  // Track condition handler applies (clone to avoid mutating artifact)
  const handlerApplies = new Map<string, number[]>();
  for (const step of artifact.steps) {
    if (step.onCondition) {
      handlerApplies.set(step.id, step.onCondition.map(h => h.maxApplies));
    }
  }

  const approvedRiskySteps = new Set<string>();

  for (const step of artifact.steps) {
    // Retry loop for attended escalation
    let stepRetry = true;
    while (stepRetry) {
    stepRetry = false;
    journal.stepStart(step.id, step.intent);

    // ── RISKY GATE (trust lifecycle) ────────────────────
    if (step.risk === 'risky' && !approvedRiskySteps.has(step.id)) {
      const trust = getTrustStatus(artifact.name, artifact.version);
      if (trust.status === 'approved') {
        // Trusted: proceed but log loudly
        journal.event('risky_step_executed', { stepId: step.id, trustStatus: 'approved', approvedBy: trust.approvedBy });
      } else if (config.attended && config.channel) {
        // Manual + attended: pause for approval
        const ss = await captureFailure(surface, journal);
        const riskyEsc = await escalateOrFail(step, `Risky step ${step.id}: capability not approved for unattended execution`, ss, config, outputs);
        if (riskyEsc.action === 'retry') { approvedRiskySteps.add(step.id); stepRetry = true; break; }
        if (riskyEsc.action === 'skip') break;
        if (riskyEsc.action === 'return') return riskyEsc.result;
      } else {
        // Manual + unattended: stop AT the risky step
        return {
          status: 'HARD_FAILURE', stepId: step.id,
          expected: JSON.stringify(step.expect),
          observed: `Risky step ${step.id}: capability not approved for unattended execution`,
          evidenceRefs: [],
        };
      }
    }

    // ── RESOLVE or NAVIGATE ─────────────────────────────
    let lastActionRef: string | undefined;
    let lastTypedValue: string | undefined;

    if (step.action.verb === 'navigate') {
      const path = bindValue(step.action.value, inputs);
      journal.event('navigate', { stepId: step.id, path });
      const navResult = await surface.navigate(path);
      if (!navResult.ok) {
        const ss = await captureFailure(surface, journal);
        { const _esc = await escalateOrFail(step, 'Navigation failed: ' + (navResult.error ?? 'blocked'), ss, config, outputs); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
      }
    } else {
      // Poll for target resolution
      const resolveStart = Date.now();
      let resolveResult: ResolveResult | null = null;

      while (Date.now() - resolveStart < stepTimeout) {
        resolveResult = await surface.resolve(step.target.chain);
        if (resolveResult.kind === 'match') break;
        await delay(tickMs);
      }

      if (!resolveResult || resolveResult.kind !== 'match') {
        const ss = await captureFailure(surface, journal);
        { const _esc = await escalateOrFail(step, 'Target not resolved', ss, config, outputs, resolveResult); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
      }

      journal.rungMatched(step.id, resolveResult.rungIndex);
      lastActionRef = resolveResult.ref;

      // ── ACT ─────────────────────────────────────────
      const actionValue = step.action.value != null
        ? bindValue(step.action.value, inputs)
        : undefined;

      const actResult = await surface.act({
        verb: step.action.verb,
        value: actionValue,
        ref: resolveResult.ref,
      });

      if (!actResult.ok) {
        if (actResult.blocked) {
          const ss = await captureFailure(surface, journal);
          { const _esc = await escalateOrFail(step, `Policy blocked: ${actResult.blocked.rule} (${actResult.blocked.attempted})`, ss, config, outputs); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
        }
        const ss = await captureFailure(surface, journal);
        { const _esc = await escalateOrFail(step, 'Action failed: ' + (actResult.error ?? 'unknown'), ss, config, outputs); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
      }

      journal.event('acted', { stepId: step.id, verb: step.action.verb });

      // Handle read actions
      if (step.action.verb === 'read' && actResult.readValue != null) {
        const parsed = parseValue(actResult.readValue, step.action.parseAs ?? 'string');
        if (parsed == null) {
          const ss = await captureFailure(surface, journal);
          { const _esc = await escalateOrFail(step, `Parse failed (${step.action.parseAs}): raw="${actResult.readValue}"`, ss, config, outputs); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
        }
        outputs[step.action.saveTo!] = parsed;
        journal.event('output_parsed', { stepId: step.id, key: step.action.saveTo!, parseAs: step.action.parseAs });
      }

      if (step.action.verb === 'type' || step.action.verb === 'select') {
        lastTypedValue = actionValue;
      }
    }

    // ── ARBITRATE (poll in fixed order) ───────────────
    const arbStart = Date.now();
    const applies = handlerApplies.get(step.id);

    while (Date.now() - arbStart < stepTimeout) {
      // (1) onCondition triggers
      let conditionHandled = false;
      if (step.onCondition && applies) {
        for (let i = 0; i < step.onCondition.length; i++) {
          if (applies[i] <= 0) continue;
          const handler = step.onCondition[i];
          if (await surface.check(handler.if)) {
            // Execute handler action
            const handlerChain = [{ by: 'roleName' as const, role: 'button', name: handler.do.targetName }];
            const handlerResolve = await surface.resolve(handlerChain);
            if (handlerResolve.kind === 'match') {
              await surface.act({ verb: handler.do.verb, ref: handlerResolve.ref });
            }
            applies[i]--;
            journal.conditionHandled(step.id, handler.do.targetName, applies[i]);
            conditionHandled = true;

            // ── RE-ANCHOR after handler ─────────────────
            // If the expect doesn't pass within a grace window, re-resolve
            // and re-act the step's action (one re-attempt max per handler firing).
            const graceMs = 2000;
            const graceStart = Date.now();
            let expectPassedInGrace = false;
            while (Date.now() - graceStart < graceMs) {
              if (await checkPredicate(step.expect, surface, outputs, lastTypedValue, lastActionRef)) {
                expectPassedInGrace = true;
                break;
              }
              await delay(tickMs);
            }
            if (!expectPassedInGrace && step.action.verb !== 'navigate') {
              // Re-resolve + re-act (skip for risky clicks)
              if (step.risk === 'risky' && step.action.verb === 'click') {
                journal.event('reanchor_refused_risky', { stepId: step.id });
                const ss = await captureFailure(surface, journal);
                { const _esc = await escalateOrFail(step, 'Reanchor refused: risky click after condition handler', ss, config, outputs); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
              }
              journal.event('reanchor_reattempt', { stepId: step.id, verb: step.action.verb });
              const reResolve = await surface.resolve(step.target.chain);
              if (reResolve.kind === 'match') {
                const reValue = step.action.value != null ? bindValue(step.action.value, inputs) : undefined;
                const reAct = await surface.act({ verb: step.action.verb, value: reValue, ref: reResolve.ref });
                if (reAct.ok) {
                  lastActionRef = reResolve.ref;
                  if (step.action.verb === 'type') lastTypedValue = reValue;
                  if (step.action.verb === 'read' && reAct.readValue != null) {
                    const parsed = parseValue(reAct.readValue, step.action.parseAs ?? 'string');
                    if (parsed != null) { outputs[step.action.saveTo!] = parsed; }
                  }
                  journal.event('reanchor_acted', { stepId: step.id });
                }
              }
            }

            break; // restart arbitration
          }
        }
        if (conditionHandled) continue;

        // Check for exhausted handlers that still trigger
        for (let i = 0; i < step.onCondition.length; i++) {
          if (applies[i] <= 0 && await surface.check(step.onCondition[i].if)) {
            const ss = await captureFailure(surface, journal);
            { const _esc = await escalateOrFail(step, `Condition handler exhausted (maxApplies spent) but condition persists`, ss, config, outputs); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
          }
        }
      }

      // (2) expect passes → next step
      if (await checkPredicate(step.expect, surface, outputs, lastTypedValue, lastActionRef)) {
        journal.expectPassed(step.id);
        break;
      }

      // (3) declared businessOutcomes → end run
      for (const [code, outcome] of Object.entries(artifact.businessOutcomes)) {
        if (await surface.check(outcome.detect)) {
          journal.outcomeDetected(step.id, code);
          return { status: 'BUSINESS_OUTCOME', code };
        }
      }

      // (4) nothing → keep polling
      await delay(tickMs);

      // Check timeout
      if (Date.now() - arbStart >= stepTimeout) {
        const ss = await captureFailure(surface, journal);
        { const _esc = await escalateOrFail(step, `Arbitration timeout (${stepTimeout}ms)`, ss, config, outputs); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
      }
    }
    } // end while(stepRetry)
  } // end for(step)

  // All steps completed → SUCCESS
  return { status: 'SUCCESS', outputs };
}

// ── Helpers ─────────────────────────────────────────────────

async function captureFailure(surface: Surface, journal: RunJournal): Promise<string[]> {
  const obs = await surface.observe();
  const refs: string[] = [];
  if (obs.screenshotPath) refs.push(obs.screenshotPath);
  return refs;
}

function buildObserved(msg: string, resolveResult?: ResolveResult | null): string {
  let observed = msg;
  if (resolveResult && resolveResult.kind !== 'match') {
    const reports = resolveResult.rungReports
      .map(r => `rung ${r.rungIndex} (${r.descriptor.by}): ${r.reason}`)
      .join('; ');
    observed += ` | Rung reports: ${reports}`;
  }
  return observed;
}

type EscalationOutcome = { action: 'return'; result: ReplayResult } | { action: 'retry' } | { action: 'skip' };

// In attended mode: escalate → channel → handback claim → retry/skip/abort
async function escalateOrFail(
  step: Step, reason: string, evidenceRefs: string[],
  config: EngineConfig, outputs: Record<string, unknown>,
  resolveResult?: ResolveResult | null,
): Promise<EscalationOutcome> {
  const observed = buildObserved(reason, resolveResult);

  if (!config.attended || !config.channel) {
    return { action: 'return', result: { status: 'HARD_FAILURE', stepId: step.id, expected: JSON.stringify(step.expect), observed, evidenceRefs } };
  }

  // ── Attended: escalate ──────────────────────────────────
  const { surface, artifact, journal } = config;
  const ssRefs = await captureFailure(surface, journal);
  const interventionReq: InterventionRequest = {
    capability: artifact.name,
    version: artifact.version,
    stepId: step.id,
    intent: step.intent,
    expected: JSON.stringify(step.expect),
    observed,
    screenshotRef: ssRefs[0] ?? '',
    reason,
    options: ['retry', 'skip', 'abort'],
  };

  // Write intervention JSON to run dir
  writeFileSync(join(journal.runDir, `intervention-${step.id}.json`), JSON.stringify(interventionReq, null, 2));
  journal.event('control_transfer', { to: 'human', stepId: step.id, reason });

  // Ask the channel (may loop on rejected skip)
  while (true) {
    const claim = await config.channel.request(interventionReq);

    if (claim.kind === 'abort') {
      journal.event('handback', { claim: 'abort', notes: claim.notes });
      journal.event('control_transfer', { to: 'machine', stepId: step.id });
      return { action: 'return', result: { status: 'ESCALATED', resolution: 'Human aborted', notes: claim.notes } };
    }

    if (claim.kind === 'retry') {
      journal.event('handback', { claim: 'retry' });
      journal.event('control_transfer', { to: 'machine', stepId: step.id });
      return { action: 'retry' };
    }

    if (claim.kind === 'approve') {
      // Risky-step approval — allow the step to proceed (tracked per-step)
      journal.event('handback', { claim: 'approve' });
      journal.event('control_transfer', { to: 'machine', stepId: step.id });
      // The caller must add step.id to approvedRiskySteps before re-entering
      return { action: 'retry' };
    }

    if (claim.kind === 'skip') {
      // Verify: the step's expect must pass on the live screen
      const expectOk = await checkPredicate(step.expect, surface, outputs);
      if (expectOk) {
        journal.event('handback', { claim: 'skip', verified: true });
        journal.event('control_transfer', { to: 'machine', stepId: step.id });
        return { action: 'skip' };
      } else {
        journal.event('handback_rejected', { claim: 'skip', reason: 'expect not met on live screen' });
        // Ask again
        interventionReq.observed = 'Skip claim REJECTED: expect does not pass on live screen. Try again.';
        continue;
      }
    }
  }
}

function hardFailure(
  step: Step,
  observedMsg: string,
  evidenceRefs: string[],
  resolveResult?: ResolveResult | null,
): ReplayResult {
  const observed = buildObserved(observedMsg, resolveResult);
  return {
    status: 'HARD_FAILURE',
    stepId: step.id,
    expected: JSON.stringify(step.expect),
    observed,
    evidenceRefs,
  };
}
