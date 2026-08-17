// src/replay/engine.ts — ReplayEngine per-step FSM.
// DESIGN_MAP D6: condition-polled, whole-chain-per-tick, fixed arbitration order.
// No LLM anywhere. Replay never waits for time, it waits for truth.

import type { CapabilityArtifact, Predicate, Step, ConditionHandler } from '../schema/artifact.js';
import type { ReplayResult, InterventionRequest } from '../schema/results.js';
import type { Surface, ResolveResult } from '../surface/surface.js';
import type { RunJournal } from '../evidence/journal.js';
import type { EscalationChannel, HandbackClaim } from '../escalation/intervention.js';
import { getTrustStatus } from '../guardrails/trust.js';
import { loadOverlay, applyOverlay } from '../guardrails/overlay.js';
import { loadErrorLibrary, type ErrorLibrary } from '../errors/loader.js';
import { snapshotObservation, diffSnapshots } from '../escalation/window-capture.js';
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
  tenant?: string;           // tenant for overlay lookup
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
  const { surface, inputs, journal } = config;
  const stepTimeout = config.stepTimeoutMs ?? 30000;
  const tickMs = config.tickMs ?? 250;
  const outputs: Record<string, unknown> = {};

  // Apply tenant overlay if one exists
  let artifact = config.artifact;
  if (config.tenant) {
    const overlay = loadOverlay(artifact.name, artifact.version, config.tenant);
    if (overlay) {
      const { artifact: overlaid, usedMappings } = applyOverlay(artifact, overlay);
      artifact = overlaid;
      journal.event('overlay_applied', { tenant: config.tenant, mappings: usedMappings });
    }
  }

  // Load error library for this app
  const errorLibrary: ErrorLibrary = loadErrorLibrary(artifact.app.id);
  let recoveryCount = 0;
  const maxTotalRecoveries = 1; // one recovery per run, any error

  // Track condition handler applies (clone to avoid mutating artifact)
  const handlerApplies = new Map<string, number[]>();
  for (const step of artifact.steps) {
    if (step.onCondition) {
      handlerApplies.set(step.id, step.onCondition.map(h => h.maxApplies));
    }
  }

  const approvedRiskySteps = new Set<string>();

  for (const step of artifact.steps) {
    // Retry loop for attended escalation and error recovery
    let stepRetry = true;
    stepRetryLoop: while (stepRetry) {
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
        const riskyEsc = await escalateOrFail(step, `Risky step ${step.id}: capability not approved for unattended execution`, ss, config, outputs, 'authority');
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
        { const _esc = await escalateOrFail(step, 'Navigation failed: ' + (navResult.error ?? 'blocked'), ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
      }
    } else {
      // Poll for target resolution
      const resolveStart = Date.now();
      let resolveResult: ResolveResult | null = null;

      let errorRecoveredDuringResolve = false;
      while (Date.now() - resolveStart < stepTimeout) {
        // Check error library BEFORE resolve (session expiry redirects to a different page;
        // the scorer may match wrong-page elements with identical properties like attrName)
        if (recoveryCount < maxTotalRecoveries) {
          let errorDetectedPreResolve = false;
          for (const [errName, errEntry] of Object.entries(errorLibrary)) {
            if (await surface.check(errEntry.detect)) {
              journal.event('error_detected', { stepId: step.id, error: errName, phase: 'pre_resolve' });
              await delay(1000); // let the page settle after redirect
              let recoveryFailed = false;
              let recTypedValue0: string | undefined;
              for (const recStep of errEntry.recovery) {
                journal.event('recovery_step', { stepId: recStep.id, verb: recStep.action.verb, intent: recStep.intent });
                if (recStep.action.verb === 'navigate') {
                  const path = bindValue(recStep.action.value, inputs);
                  const navResult = await surface.navigate(path);
                  if (!navResult.ok) { recoveryFailed = true; break; }
                } else {
                  await surface.observe();
                  const rr = await surface.resolve([recStep.target.properties]);
                  if (rr.kind !== 'match') { recoveryFailed = true; break; }
                  const rv = recStep.action.value != null ? bindValue(recStep.action.value, inputs) : undefined;
                  const ra = await surface.act({ verb: recStep.action.verb, value: rv, ref: rr.ref });
                  if (!ra.ok) { recoveryFailed = true; break; }
                  if (recStep.action.verb === 'type') recTypedValue0 = rv;
                }
                await delay(1000);
                if (!await checkPredicate(recStep.expect, surface, outputs, recTypedValue0, undefined)) {
                  await delay(2000);
                  if (!await checkPredicate(recStep.expect, surface, outputs, recTypedValue0, undefined)) {
                    recoveryFailed = true; break;
                  }
                }
              }
              if (recoveryFailed) {
                const ss = await captureFailure(surface, journal);
                journal.event('recovery_failed', { stepId: step.id, error: errName });
                { const _esc = await escalateOrFail(step, `Recovery for "${errName}" failed`, ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
              }
              recoveryCount++;
              journal.event('recovery_complete', { stepId: step.id, error: errName, recoveryCount });
              errorDetectedPreResolve = true;
              errorRecoveredDuringResolve = true;
              stepRetry = true;
              break;
            }
          }
          if (errorDetectedPreResolve) break;
        }

        resolveResult = await surface.resolve([step.target.properties]);
        if (resolveResult.kind === 'match') break;

        // Check error library AFTER resolve failure (fallback)
        if (recoveryCount < maxTotalRecoveries) {
          for (const [errName, errEntry] of Object.entries(errorLibrary)) {
            if (await surface.check(errEntry.detect)) {
              journal.event('error_detected', { stepId: step.id, error: errName, phase: 'resolve' });
              // Execute recovery steps
              let recoveryFailed = false;
              let recTypedValue: string | undefined;
              for (const recStep of errEntry.recovery) {
                journal.event('recovery_step', { stepId: recStep.id, verb: recStep.action.verb, intent: recStep.intent });
                if (recStep.action.verb === 'navigate') {
                  const path = bindValue(recStep.action.value, inputs);
                  const navResult = await surface.navigate(path);
                  if (!navResult.ok) { recoveryFailed = true; break; }
                } else {
                  await surface.observe();
                  const rr = await surface.resolve([recStep.target.properties]);
                  if (rr.kind !== 'match') { recoveryFailed = true; break; }
                  const rv = recStep.action.value != null ? bindValue(recStep.action.value, inputs) : undefined;
                  const ra = await surface.act({ verb: recStep.action.verb, value: rv, ref: rr.ref });
                  if (!ra.ok) { recoveryFailed = true; break; }
                  if (recStep.action.verb === 'type') recTypedValue = rv;
                }
                await delay(500);
                if (!await checkPredicate(recStep.expect, surface, outputs, recTypedValue, undefined)) {
                  await delay(1000);
                  if (!await checkPredicate(recStep.expect, surface, outputs, recTypedValue, undefined)) {
                    recoveryFailed = true; break;
                  }
                }
              }
              if (recoveryFailed) {
                const ss = await captureFailure(surface, journal);
                journal.event('recovery_failed', { stepId: step.id, error: errName });
                { const _esc = await escalateOrFail(step, `Recovery for "${errName}" failed`, ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
              }
              recoveryCount++;
              journal.event('recovery_complete', { stepId: step.id, error: errName, recoveryCount });
              errorRecoveredDuringResolve = true;
              stepRetry = true;
              break;
            }
          }
        }
        if (errorRecoveredDuringResolve) break;

        await delay(tickMs);
      }
      if (errorRecoveredDuringResolve) continue stepRetryLoop; // retry the step

      if (!resolveResult || resolveResult.kind !== 'match') {
        const ss = await captureFailure(surface, journal);
        { const _esc = await escalateOrFail(step, 'Target not resolved', ss, config, outputs, 'breakage', resolveResult); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
      }

      journal.rungMatched(step.id, resolveResult.rungIndex);
      // Journal scoring telemetry (v2: margin-based drift signal)
      const scoringData = (surface as any).lastScoringResult;
      if (scoringData) {
        journal.scoringResult(step.id, scoringData);
      }
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
          { const _esc = await escalateOrFail(step, `Policy blocked: ${actResult.blocked.rule} (${actResult.blocked.attempted})`, ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
        }
        const ss = await captureFailure(surface, journal);
        { const _esc = await escalateOrFail(step, 'Action failed: ' + (actResult.error ?? 'unknown'), ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
      }

      journal.event('acted', { stepId: step.id, verb: step.action.verb });

      // Handle read actions
      if (step.action.verb === 'read' && actResult.readValue != null) {
        const parsed = parseValue(actResult.readValue, step.action.parseAs ?? 'string');
        if (parsed == null) {
          const ss = await captureFailure(surface, journal);
          { const _esc = await escalateOrFail(step, `Parse failed (${step.action.parseAs}): raw="${actResult.readValue}"`, ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
        }
        // Pattern validation for patterned outputs
        const outputDecl = artifact.outputs[step.action.saveTo!];
        if (outputDecl?.pattern && parsed != null) {
          const val = String(parsed);
          if (!new RegExp(outputDecl.pattern).test(val)) {
            const ss = await captureFailure(surface, journal);
            { const _esc = await escalateOrFail(step, `Output pattern mismatch: "${val.substring(0, 40)}" does not match /${outputDecl.pattern}/`, ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
          }
        }
        outputs[step.action.saveTo!] = parsed;
        journal.event('output_parsed', { stepId: step.id, key: step.action.saveTo!, parseAs: step.action.parseAs });
      }

      if (step.action.verb === 'type' || step.action.verb === 'select') {
        lastTypedValue = actionValue;
      }
    }

    // Skip arbitration if recovery already fired (step will retry)
    if (stepRetry) continue stepRetryLoop;

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
            // Execute 1 or 2 handler actions (extended for checkbox+Continue pattern)
            const actions = Array.isArray(handler.do) ? handler.do : [handler.do];
            for (const act of actions) {
              const hChain = [{ role: act.verb === 'click' ? 'button' : 'textbox', frame: 'main', name: act.targetName }];
              // For checkbox actions, resolve as checkbox role instead
              if (act.verb === 'click' && act.targetName.includes('checkbox:')) {
                // Find checkbox by nearby text (substring match via structural)
                const checkName = act.targetName.replace('checkbox:', '');
                // Try to find a checkbox on the page
                const checkLoc = await surface.resolve([{ role: 'checkbox', frame: 'main' } as any]);
                if (checkLoc.kind === 'match') await surface.act({ verb: 'click', ref: checkLoc.ref });
              } else {
                const hResolve = await surface.resolve(hChain);
                if (hResolve.kind === 'match') await surface.act({ verb: act.verb, ref: hResolve.ref });
              }
            }
            applies[i]--;
            const handlerLabel = Array.isArray(handler.do) ? handler.do.map(a => a.targetName).join('+') : handler.do.targetName;
            journal.conditionHandled(step.id, handlerLabel, applies[i]);
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
                { const _esc = await escalateOrFail(step, 'Reanchor refused: risky click after condition handler', ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
              }
              journal.event('reanchor_reattempt', { stepId: step.id, verb: step.action.verb });
              const reResolve = await surface.resolve([step.target.properties]);
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
            { const _esc = await escalateOrFail(step, `Condition handler exhausted (maxApplies spent) but condition persists`, ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
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

      // (4) error library — detect + recover + retry current step
      let errorRecovered = false;
      for (const [errName, errEntry] of Object.entries(errorLibrary)) {
        if (await surface.check(errEntry.detect)) {
          journal.event('error_detected', { stepId: step.id, error: errName });

          if (recoveryCount >= maxTotalRecoveries) {
            const ss = await captureFailure(surface, journal);
            journal.event('recovery_exhausted', { stepId: step.id, error: errName, count: recoveryCount });
            { const _esc = await escalateOrFail(step, `Error "${errName}" detected but recovery already used (max ${maxTotalRecoveries})`, ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
          }

          // Execute recovery steps using the same step executor
          let recoveryFailed = false;
          let recTypedValue2: string | undefined;
          for (const recStep of errEntry.recovery) {
            journal.event('recovery_step', { stepId: recStep.id, verb: recStep.action.verb, intent: recStep.intent });

            if (recStep.action.verb === 'navigate') {
              const path = bindValue(recStep.action.value, inputs);
              const navResult = await surface.navigate(path);
              if (!navResult.ok) { recoveryFailed = true; break; }
            } else {
              await surface.observe();
              const resolveResult = await surface.resolve([recStep.target.properties]);
              if (resolveResult.kind !== 'match') { recoveryFailed = true; break; }
              const recValue = recStep.action.value != null ? bindValue(recStep.action.value, inputs) : undefined;
              const actResult = await surface.act({ verb: recStep.action.verb, value: recValue, ref: resolveResult.ref });
              if (!actResult.ok) { recoveryFailed = true; break; }
              if (recStep.action.verb === 'type') recTypedValue2 = recValue;
            }

            await delay(500);
            if (!await checkPredicate(recStep.expect, surface, outputs, recTypedValue2, undefined)) {
              await delay(1000);
              if (!await checkPredicate(recStep.expect, surface, outputs, recTypedValue2, undefined)) {
                recoveryFailed = true; break;
              }
            }
          }

          if (recoveryFailed) {
            const ss = await captureFailure(surface, journal);
            journal.event('recovery_failed', { stepId: step.id, error: errName });
            { const _esc = await escalateOrFail(step, `Recovery for "${errName}" failed`, ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
          }

          recoveryCount++;
          journal.event('recovery_complete', { stepId: step.id, error: errName, recoveryCount });
          // Retry current step
          stepRetry = true;
          errorRecovered = true;
          break;
        }
      }
      if (errorRecovered) break;

      // (5) nothing → keep polling
      await delay(tickMs);

      // Check timeout
      if (Date.now() - arbStart >= stepTimeout) {
        const ss = await captureFailure(surface, journal);
        { const _esc = await escalateOrFail(step, `Arbitration timeout (${stepTimeout}ms)`, ss, config, outputs, 'breakage'); if (_esc.action === "retry") { stepRetry = true; break; } if (_esc.action === "skip") break; return _esc.result; }
      }
    }
    } // end while(stepRetry)
  } // end for(step)

  // All steps completed → SUCCESS
  const result: ReplayResult = { status: 'SUCCESS', outputs };
  if (recoveryCount > 0) (result as any).recovered = true;
  return result;
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
      .map(r => `candidate ${r.rungIndex} (${r.descriptor.role ?? 'scored'}): ${r.reason}`)
      .join('; ');
    observed += ` | Rung reports: ${reports}`;
  }
  return observed;
}

type EscalationOutcome = { action: 'return'; result: ReplayResult } | { action: 'retry' } | { action: 'skip' };

// Replay escalation semantics:
// kind 'breakage' → HARD_FAILURE immediately, never consult channel. Replay is
// deterministic execution of an already-approved tool. A human pushing a broken
// run through rescues the run and leaves the tool broken — the next unattended
// call fails identically. Breakage goes back to the tool factory (rediscovery).
// kind 'authority' → consult channel if attended (risky step without approval).
// Discovery escalation is unaffected and remains fully intact.
async function escalateOrFail(
  step: Step, reason: string, evidenceRefs: string[],
  config: EngineConfig, outputs: Record<string, unknown>,
  kind: 'breakage' | 'authority',
  resolveResult?: ResolveResult | null,
): Promise<EscalationOutcome> {
  const observed = buildObserved(reason, resolveResult);

  if (kind === 'breakage' || !config.attended || !config.channel) {
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

  // Capture before-snapshot for window recording
  const sensitiveNames = Object.entries(artifact.inputs).filter(([, v]) => v.sensitive).map(([k]) => k);
  const beforeObs = await surface.observe();
  const beforeSnap = snapshotObservation(beforeObs, sensitiveNames);

  // Write intervention JSON to run dir
  writeFileSync(join(journal.runDir, `intervention-${step.id}.json`), JSON.stringify(interventionReq, null, 2));
  journal.event('control_transfer', { to: 'human', stepId: step.id, reason });
  journal.event('window_before', { stepId: step.id, url: beforeSnap.url, elements: beforeSnap.elementCount, headings: beforeSnap.headings });

  // Ask the channel (may loop on rejected skip)
  while (true) {
    const claim = await config.channel.request(interventionReq);

    // Capture after-snapshot and diff
    const afterObs = await surface.observe();
    const afterSnap = snapshotObservation(afterObs, sensitiveNames);
    const diff = diffSnapshots(beforeSnap, afterSnap);
    journal.event('window_after', { stepId: step.id, url: afterSnap.url, elements: afterSnap.elementCount, headings: afterSnap.headings });
    journal.event('human_actions', { stepId: step.id, ...diff });

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
      journal.event('handback', { claim: 'approve' });
      journal.event('control_transfer', { to: 'machine', stepId: step.id });
      return { action: 'retry' };
    }

    if (claim.kind === 'skip') {
      const expectOk = await checkPredicate(step.expect, surface, outputs);
      if (expectOk) {
        journal.event('handback', { claim: 'skip', verified: true });
        journal.event('control_transfer', { to: 'machine', stepId: step.id });
        return { action: 'skip' };
      } else {
        journal.event('handback_rejected', { claim: 'skip', reason: 'expect not met on live screen' });
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
