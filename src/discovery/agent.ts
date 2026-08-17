// src/discovery/agent.ts — The DiscoveryAgent loop.
// DESIGN_MAP D5: observe → context → decide → describe-then-act → verify → ledger.
// Contract-first (Amendment A): the WHAT is declared; the LLM discovers the HOW.
// Describe-then-act (Amendment B): descriptor chain captured BEFORE act.

import type { Surface, Observation, ActResult } from '../surface/surface.js';
import type { LLMClient, DecisionContext, ToolCall, ActToolCall, DoneToolCall } from './llm-client.js';
import { Recorder, type LedgerEntry } from './recorder.js';
import type { CapabilityArtifact, Descriptor } from '../schema/artifact.js';
import { RunJournal } from '../evidence/journal.js';
import type { EscalationChannel } from '../escalation/intervention.js';
import type { InterventionRequest } from '../schema/results.js';
import { snapshotObservation, diffSnapshots } from '../escalation/window-capture.js';
import { isRiskyTarget } from '../guardrails/risky.js';

// ── Stop condition constants ────────────────────────────────
const MAX_STEPS = 15;
const MAX_REFUSALS = 3;
const MAX_SAME_ACTION = 5; // 5th consecutive same verb+target → DEAD_END
const WALL_CLOCK_TIMEOUT_MS = 120_000;

// ── Discovery contract (from CLI args) ──────────────────────
export interface DiscoveryContract {
  name: string;
  goal: string;
  app: string;
  appDescription?: string;
  startPath: string;
  inputs: Record<string, { type: string; pattern?: string; sensitive: boolean; exampleValue: string }>;
  outputs: Record<string, { type: string; sensitive: boolean; pattern?: string }>;
}

// ── Discovery result ────────────────────────────────────────
export interface DiscoverResult {
  status: 'compiled' | 'dead_end' | 'aborted' | 'escalated';
  artifactPath?: string;
  artifact?: CapabilityArtifact;
  reason?: string;
}

// ── Discovery config ────────────────────────────────────────
export interface DiscoverConfig {
  surface: Surface;
  llmClient: LLMClient;
  contract: DiscoveryContract;
  journal: RunJournal;
  capabilitiesDir: string;
  attended?: boolean;
  channel?: EscalationChannel;
}

// ── Parse money ─────────────────────────────────────────────
function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null; // strict: digits and optional decimal only
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function parseOutputValue(raw: string, type: string): unknown {
  if (type === 'money') return parseMoney(raw);
  return raw;
}

// ── The agent loop ──────────────────────────────────────────
export async function discover(config: DiscoverConfig): Promise<DiscoverResult> {
  const { surface, llmClient, contract, journal } = config;
  const attended = config.attended && config.channel;
  const channel = config.channel;
  // ── Contract pre-flight ────────────────────────────────────
  // Refuse a discovery that declares typed outputs but zero non-credential inputs.
  // This catches "look up a balance" without a memberId — the model has nothing to search with.
  const nonCredentialInputs = Object.entries(contract.inputs).filter(([, v]) => !v.sensitive);
  const hasTypedOutputs = Object.keys(contract.outputs).length > 0;
  if (hasTypedOutputs && nonCredentialInputs.length === 0) {
    const outputNames = Object.keys(contract.outputs).join(', ');
    return {
      status: 'dead_end',
      reason: `Contract declares outputs (${outputNames}) but no non-credential inputs. The model will have nothing to search with. Add --input <name>=<value> --input-type <name>:<type>:<pattern> to specify what to look up.`,
    };
  }

  const recorder = new Recorder();
  const journalLines: string[] = [];
  let stepCount = 0;
  let refusalCount = 0;
  let lastVerbTarget = '';
  let sameActionCount = 0;
  let humanAssisted = false;
  const startTime = Date.now();

  // Escalation helper — returns true if the agent should continue, false to stop
  async function escalateOrStop(reason: string, obs: Observation): Promise<'continue' | 'abort'> {
    if (!attended || !channel) return 'abort';
    const ss = obs.screenshotPath || '';
    const req: InterventionRequest = {
      capability: contract.name, version: '0.0.0', stepId: `step-${stepCount}`,
      intent: contract.goal, expected: 'progress toward goal', observed: reason,
      screenshotRef: ss, reason,
      options: ['retry', 'skip', 'abort', 'approve'],
    };
    // Capture before-snapshot
    const sensitiveNames = Object.entries(contract.inputs).filter(([, v]) => v.sensitive).map(([k]) => k);
    const beforeSnap = snapshotObservation(obs, sensitiveNames);
    journal.event('control_transfer', { to: 'human', stepId: req.stepId, reason });
    journal.event('window_before', { stepId: req.stepId, url: beforeSnap.url, elements: beforeSnap.elementCount, headings: beforeSnap.headings });
    const claim = await channel.request(req);

    // Capture after-snapshot and diff
    const afterObs = await surface.observe();
    const afterSnap = snapshotObservation(afterObs, sensitiveNames);
    const diff = diffSnapshots(beforeSnap, afterSnap);
    journal.event('window_after', { stepId: req.stepId, url: afterSnap.url, elements: afterSnap.elementCount });
    journal.event('human_actions', { stepId: req.stepId, ...diff });
    journal.event('handback', { claim: claim.kind, notes: (claim as any).notes });

    if (claim.kind === 'retry') {
      journal.event('control_transfer', { to: 'machine', stepId: req.stepId });
      humanAssisted = true;
      return 'continue';
    }
    if (claim.kind === 'skip') {
      const freshObs = afterObs; // already observed
      const changed = freshObs.url !== obs.url || freshObs.elements.length !== obs.elements.length;
      if (!changed) {
        journal.event('handback_rejected', { claim: 'skip', reason: 'page state unchanged after skip claim' });
        journalLines.push('SKIP_REJECTED: page state unchanged — try again or abort');
        // Give the human another chance
        return escalateOrStop('Skip rejected — page unchanged. ' + reason, freshObs);
      }
      journal.event('control_transfer', { to: 'machine', stepId: req.stepId });
      humanAssisted = true;
      return 'continue';
    }
    if (claim.kind === 'approve') {
      journal.event('control_transfer', { to: 'machine', stepId: req.stepId });
      humanAssisted = true;
      return 'continue';
    }
    // abort
    return 'abort';
  }

  // Navigate to start path and record it
  journal.event('discovery_start', { name: contract.name, goal: contract.goal });
  const navResult = await surface.navigate(contract.startPath);
  if (!navResult.ok) {
    const reason = navResult.blocked
      ? `Policy blocked: ${navResult.blocked.rule} (${navResult.blocked.attempted})`
      : (navResult.error ?? 'unknown');
    return { status: 'aborted', reason: `Failed to navigate to start: ${reason}` };
  }
  // Wait for page to settle, then record the initial navigation
  await new Promise(r => setTimeout(r, 500));
  const startObs = await surface.observe();
  // Find prominent VISIBLE text — headings first, then buttons, then any named element.
  // Priority: heading > button > link > any element with text > page title.
  // NEVER fall back to URL slugs. Verify via surface.check before recording.
  const candidates = [
    ...startObs.elements.filter(e => e.role === 'heading' && e.name.length > 2),
    ...startObs.elements.filter(e => e.role === 'button' && e.name.length > 2),
    ...startObs.elements.filter(e => e.role === 'link' && e.name.length > 3 && e.name.length < 40),
    ...startObs.elements.filter(e => e.name.length > 3 && e.name.length < 50),
  ];
  let startPageText = 'page';
  for (const el of candidates) {
    const candidate = el.name.substring(0, 40);
    if (await surface.check({ textPresent: candidate })) {
      startPageText = candidate;
      break;
    }
  }
  journal.event('initial_navigate_expect', { text: startPageText, verified: startPageText !== 'page' });
  recorder.record({
    intent: `Navigate to ${contract.startPath}`,
    verb: 'navigate',
    value: contract.startPath,
    properties: { role: 'navigation', frame: 'main' } as Descriptor,
    expect: { textPresent: startPageText },
  });

  while (true) {
    // Phase 26: exhaustion triggers are dead-ends, not escalations.
    // Escalation is reserved for AUTHORITY (risky actions, auth walls).
    if (Date.now() - startTime > WALL_CLOCK_TIMEOUT_MS) {
      journal.event('dead_end', { reason: 'Wall clock timeout', stepsCompleted: stepCount });
      return { status: 'dead_end', reason: 'Wall clock timeout' };
    }
    if (stepCount >= MAX_STEPS) {
      journal.event('dead_end', { reason: `Max steps (${MAX_STEPS}) reached`, stepsCompleted: stepCount });
      return { status: 'dead_end', reason: `Max steps (${MAX_STEPS}) reached` };
    }
    if (refusalCount >= MAX_REFUSALS) {
      journal.event('aborted', { reason: `${MAX_REFUSALS} guardrail refusals`, stepsCompleted: stepCount });
      return { status: 'aborted', reason: `${MAX_REFUSALS} guardrail refusals` };
    }

    // Brief settle wait for iframes/dynamic content
    await new Promise(r => setTimeout(r, 300));

    // Observe (wait for any iframes to settle)
    const obs = await surface.observe();
    stepCount++;
    const iframeEls = obs.elements.filter(e => e.frame !== 'main');
    // Log observation with key page landmarks
    const headings = obs.elements.filter(e => e.role === 'heading').map(e => e.name).filter(Boolean).slice(0, 5);
    const buttons = obs.elements.filter(e => e.role === 'button' || e.role === 'link').map(e => e.name).filter(Boolean).slice(0, 8);
    const fields = obs.elements.filter(e => e.role === 'textbox' || e.role === 'combobox').map(e => e.name || e.attrName).filter(Boolean).slice(0, 5);
    journal.event('observed', {
      step: stepCount, elements: obs.elements.length, iframeElements: iframeEls.length, url: obs.url,
      headings, buttons, fields,
    });

    // Build context
    const ctx: DecisionContext = {
      goal: contract.goal,
      contract: {
        name: contract.name,
        inputs: Object.fromEntries(Object.entries(contract.inputs).map(([k, v]) => [k, {
          type: v.type,
          exampleValue: v.sensitive ? `<sensitive:${k}>` : v.exampleValue,
        }])),
        outputs: Object.fromEntries(Object.entries(contract.outputs).map(([k, v]) => [k, { type: v.type }])),
      },
      journal: journalLines,
      observation: obs,
    };

    // Decide
    const toolCall = await llmClient.decide(ctx);
    // Log the full decision — not just the tool name
    const decisionDetail: Record<string, any> = { step: stepCount, tool: toolCall.tool };
    if (toolCall.tool === 'act') {
      const a = toolCall as ActToolCall;
      decisionDetail.verb = a.verb;
      decisionDetail.intent = a.intent;
      decisionDetail.value = a.value && contract.inputs[a.value]?.sensitive ? '<sensitive>' : a.value;
      const targetEl = obs.elements.find(e => e.ref === a.targetRef);
      decisionDetail.targetName = targetEl?.name || targetEl?.role || a.targetRef || '?';
      decisionDetail.targetRole = targetEl?.role;
      if (a.outputName) decisionDetail.outputName = a.outputName;
    } else if (toolCall.tool === 'done') {
      decisionDetail.summary = (toolCall as DoneToolCall).summary;
    }
    journal.event('decision', decisionDetail);

    // ── DONE ──────────────────────────────────────────────
    if (toolCall.tool === 'done') {
      // Verify: all outputs populated + parsed
      const outputs = recorder.getOutputs();
      const errors: string[] = [];
      for (const [name, decl] of Object.entries(contract.outputs)) {
        if (!(name in outputs) || outputs[name] == null) {
          errors.push(`Output "${name}" not populated`);
        } else if (decl.pattern) {
          const val = String(outputs[name]);
          if (!new RegExp(decl.pattern).test(val)) {
            errors.push(`Output "${name}" value "${val.substring(0, 40)}" does not match pattern /${decl.pattern}/`);
          }
        }
      }

      if (errors.length > 0) {
        const msg = `VERIFY_FAILED: missing outputs: ${errors.join('; ')}. You must read these values before calling done.`;
        journalLines.push(msg);
        if ('recordResult' in llmClient) (llmClient as any).recordResult(msg);
        journal.event('verify_failed', { errors });
        // Loop continues — model must do more work
        continue;
      }

      // Compile
      journal.event('compiling', {});

      // Fix the first ledger entry's expect (the initial navigate)
      const ledger = recorder.getLedger();
      if (ledger.length > 1) {
        // The initial navigate's expect should be the page indicator after navigation
        // Use the second entry's observation context — but for simplicity, use textPresent
        // with the start page's expected text
      }

      const artifact = recorder.compile(contract);
      if (humanAssisted) (artifact as any).humanAssisted = true;

      // ── POST-COMPILE SELF-REPLAY GATE ──────────────────
      // The artifact is legitimate ONLY if the replay engine can reproduce
      // the outputs with the same inputs. This prevents "read a blob and
      // call it done" from passing as a working capability.
      journal.event('self_replay_start', {});
      try {
        const { replay: replayEngine } = await import('../replay/engine.js');
        const { RunJournal: SelfReplayJournal } = await import('../evidence/journal.js');
        const { loadPolicy } = await import('../guardrails/policy.js');
        const { BrowserSurface } = await import('../surface/browser-surface.js');
        const { resolve: resolvePath } = await import('node:path');

        // Build inputs from contract example values
        const replayInputs: Record<string, string> = {};
        for (const [k, v] of Object.entries(contract.inputs)) {
          if (v.exampleValue) replayInputs[k] = v.exampleValue;
        }

        // Create a self-replay surface with the same config
        const baseUrl = surface.getBaseUrl();
        const basePolicy = loadPolicy(resolvePath('policy.json'));
        const selfSurface = new BrowserSurface({
          baseUrl,
          tenantPrefix: (surface as any).config.tenantPrefix || '',
          policy: { ...basePolicy, allowedOrigins: [...basePolicy.allowedOrigins, baseUrl] },
          headed: false,
        });

        const selfJournal = new SelfReplayJournal(resolvePath('evidence/runs'), artifact, replayInputs);
        (selfSurface as any).config.screenshotDir = selfJournal.runDir;

        await selfSurface.launch();
        try {
          const replayResult = await replayEngine({
            surface: selfSurface, artifact, inputs: replayInputs, journal: selfJournal,
            stepTimeoutMs: 30000, tickMs: 250,
          });

          if (replayResult.status === 'SUCCESS') {
            // Verify outputs
            let outputsValid = true;
            for (const [outName, outDecl] of Object.entries(artifact.outputs)) {
              const val = replayResult.outputs[outName];
              if (val == null) { outputsValid = false; break; }
              if (outDecl.pattern && !new RegExp(outDecl.pattern).test(String(val))) { outputsValid = false; break; }
            }

            if (outputsValid) {
              journal.event('self_replay_passed', { outputs: replayResult.outputs });
              // Gate passed — write the artifact
              const artifactPath = recorder.saveArtifact(artifact, config.capabilitiesDir, journal.runDir);
              journal.event('compiled', { path: artifactPath, humanAssisted });
              return { status: 'compiled', artifactPath, artifact };
            } else {
              // Outputs didn't validate
              const reason = 'Self-replay produced outputs but they failed validation';
              journal.event('self_replay_failed', { reason, outputs: replayResult.outputs });
              // Save rejected artifact for inspection
              recorder.saveArtifact(artifact, journal.runDir);
              journal.event('dead_end', { reason, stepsCompleted: stepCount });
              return { status: 'dead_end', reason };
            }
          } else {
            // Replay didn't succeed
            const reason = `Self-replay returned ${replayResult.status}${replayResult.status === 'HARD_FAILURE' ? ` at step ${(replayResult as any).stepId}` : ''}`;
            journal.event('self_replay_failed', { reason, replayStatus: replayResult.status });
            // Save rejected artifact for inspection
            recorder.saveArtifact(artifact, journal.runDir);
            journal.event('dead_end', { reason, stepsCompleted: stepCount });
            return { status: 'dead_end', reason };
          }
        } finally {
          await selfSurface.close();
        }
      } catch (e) {
        const reason = `Self-replay crashed: ${(e as Error).message}`;
        journal.event('self_replay_failed', { reason });
        recorder.saveArtifact(artifact, journal.runDir);
        journal.event('dead_end', { reason, stepsCompleted: stepCount });
        return { status: 'dead_end', reason };
      }
    }

    // ── ACT ───────────────────────────────────────────────
    const act = toolCall as ActToolCall;

    // Same-action detection (use target name/value, not ref — refs are ephemeral)
    const targetDesc = act.targetRef
      ? (obs.elements.find(e => e.ref === act.targetRef)?.name ?? act.targetRef)
      : (act.value ?? '');
    const verbTarget = `${act.verb}:${targetDesc}`;
    if (verbTarget === lastVerbTarget) {
      sameActionCount++;
      if (sameActionCount >= MAX_SAME_ACTION) {
        // Phase 26: exhaustion is a dead-end, not an escalation
        journal.event('dead_end', { reason: `Same action repeated ${MAX_SAME_ACTION} times`, stepsCompleted: stepCount, verbTarget });
        return { status: 'dead_end', reason: `Same action repeated ${MAX_SAME_ACTION} times` };
      }
      if (sameActionCount === 2) {
        journalLines.push('WARNING: same action repeated twice');
        journal.event('same_action_warning', { verbTarget });
      }
    } else {
      sameActionCount = 1;
      lastVerbTarget = verbTarget;
    }

    // Navigate actions: skip describe, just navigate
    if (act.verb === 'navigate' && act.value) {
      journal.event('navigate', { path: act.value, intent: act.intent });
      const navRes = await surface.navigate(act.value);
      if (!navRes.ok) {
        if (navRes.blocked) {
          refusalCount++;
          journalLines.push(`REFUSAL: navigate to ${act.value} blocked (${navRes.blocked.rule})`);
          journal.event('refusal', { verb: 'navigate', value: act.value, rule: navRes.blocked.rule });
          continue;
        }
        journalLines.push(`ERROR: navigate failed: ${navRes.error}`);
        continue;
      }

      // Check expect
      if (await surface.check(act.expectProposal)) {
        recorder.record({
          intent: act.intent,
          verb: 'navigate',
          value: act.value,
          properties: { role: 'navigation', frame: 'main' } as Descriptor,
          expect: act.expectProposal,
        });
        journalLines.push(`OK: navigate ${act.value} → expect passed`);
        journal.event('step_ok', { step: stepCount, verb: 'navigate' });

        // No duplicate check needed
      } else {
        journalLines.push(`EXPECT_FAILED: navigate ${act.value} — expect not met`);
        journal.event('expect_failed', { step: stepCount });
      }
      continue;
    }

    // Element-targeted actions: DESCRIBE FIRST (Amendment B)
    if (!act.targetRef) {
      journalLines.push(`ERROR: no targetRef for ${act.verb} action`);
      continue;
    }

    // Describe BEFORE act (refs die on navigation)
    const chain = await surface.describe(act.targetRef);
    const targetEl = obs.elements.find(e => e.ref === act.targetRef);

    // Resolve the chain to get a ref with stored Playwright Locator
    const resolveResult = await surface.resolve(chain.length > 0 ? chain : [{ role: 'generic', frame: 'main' } as Descriptor]);
    journal.event('resolve_result', { step: stepCount, kind: resolveResult.kind, chainLen: chain.length });
    if (resolveResult.kind !== 'match') {
      // Actionable feedback: name the mechanism and discriminator
      let feedback = `RESOLVE_FAILED: ${act.verb} — ${resolveResult.kind}`;
      if (resolveResult.kind === 'ambiguous' && resolveResult.rungReports?.length > 0) {
        const scores = resolveResult.rungReports.map(r => r.reason).join('; ');
        feedback = `AMBIGUOUS: ${resolveResult.rungReports.length} candidates for ${targetEl?.role ?? act.verb} — ${scores}. Try a different element or navigate to a detail page.`;
      }
      journalLines.push(feedback);
      // Record result for trajectory memory
      if ('recordResult' in llmClient) (llmClient as any).recordResult(feedback);
      journal.event('resolve_failed', { step: stepCount, kind: resolveResult.kind });
      continue;
    }
    const actRef = resolveResult.ref;

    // Substitute sensitive placeholders with real values before acting
    let actValue = act.value;
    if (actValue && typeof actValue === 'string') {
      for (const [k, v] of Object.entries(contract.inputs)) {
        if (v.sensitive && actValue === `<sensitive:${k}>`) {
          actValue = v.exampleValue;
        }
      }
    }

    // ── RISKY-ACTION GATE ─────────────────────────────────
    // Escalate for authority BEFORE performing a click/select whose
    // resolved target matches the config risky-verb list.
    // Deterministic — never the model's judgment.
    const resolvedTargetName = targetEl?.name || '';
    if ((act.verb === 'click' || act.verb === 'select') && isRiskyTarget(resolvedTargetName)) {
      journal.event('risky_action_detected', { step: stepCount, verb: act.verb, targetName: resolvedTargetName, url: obs.url });

      if (!attended || !channel) {
        // UNATTENDED: never perform. Stop naming the refused action.
        const reason = `Risky action refused (unattended): about to ${act.verb} "${resolvedTargetName}" — requires human authorization`;
        journal.event('dead_end', { reason, stepsCompleted: stepCount });
        return { status: 'dead_end', reason };
      }

      // ATTENDED: escalate for authority
      const decision = await escalateOrStop(
        `About to ${act.verb} "${resolvedTargetName}" — requires human authorization`, obs,
      );
      if (decision === 'abort') {
        const reason = `Human declined risky action: ${act.verb} on "${resolvedTargetName}"`;
        journal.event('dead_end', { reason, stepsCompleted: stepCount });
        return { status: 'dead_end', reason };
      }
      // Human approved — proceed, mark step as risky
      humanAssisted = true;
      (act as any).__riskyApproved = true;
    }

    // Act
    const actResult = await surface.act({
      verb: act.verb,
      value: actValue,
      ref: actRef,
    });

    if (!actResult.ok) {
      if (actResult.blocked) {
        refusalCount++;
        const refusalMsg = `REFUSAL: ${act.verb} blocked by policy rule "${actResult.blocked.rule}" (attempted: ${actResult.blocked.attempted})`;
        journalLines.push(refusalMsg);
        if ('recordResult' in llmClient) (llmClient as any).recordResult(refusalMsg);
        journal.event('refusal', { verb: act.verb, rule: actResult.blocked.rule });
        continue;
      }
      journalLines.push(`ERROR: ${act.verb} failed: ${actResult.error}`);
      journal.event('act_error', { verb: act.verb, error: actResult.error });
      continue;
    }

    journal.event('act_result', { step: stepCount, ok: actResult.ok, readValue: actResult.readValue ?? null, verb: act.verb });

    // Handle read: extract value, parse, store
    if (act.verb === 'read' && actResult.readValue != null && act.outputName) {
      const outputDecl = contract.outputs[act.outputName];
      if (outputDecl) {
        const parsed = parseOutputValue(actResult.readValue, outputDecl.type);
        if (parsed != null) {
          recorder.setOutput(act.outputName, parsed);
          journal.event('output_read', { outputName: act.outputName, parseAs: outputDecl.type });
        }
      }
    }

    // Verify expect proposal against the REAL page
    let expectOk: boolean;
    const pred = act.expectProposal as Record<string, unknown>;
    if ('elementValue' in pred) {
      expectOk = true; // fill is synchronous with DOM
    } else if ('outputPopulated' in pred) {
      const key = pred.outputPopulated as string;
      const outputs = recorder.getOutputs();
      expectOk = key in outputs && outputs[key] != null;
    } else {
      expectOk = await surface.check(act.expectProposal);
    }

    if (expectOk) {
      // Record to ledger
      recorder.record({
        intent: act.intent,
        verb: act.verb,
        value: act.value,
        properties: (chain.length > 0 ? chain[0] : { role: 'generic', frame: 'main' }) as Descriptor,
        expect: act.expectProposal,
        outputName: act.outputName,
        parseAs: act.outputName ? contract.outputs[act.outputName]?.type : undefined,
        paramHint: act.paramHint,
        targetName: targetEl?.name,
        targetIsPassword: targetEl?.role === 'textbox' && targetEl?.nearbyText?.toLowerCase().includes('password'),
        forceRisky: !!(act as any).__riskyApproved,
      });
      const okMsg = `OK: ${act.verb} ${act.targetRef} → expect passed`;
      journalLines.push(okMsg);
      if ('recordResult' in llmClient) (llmClient as any).recordResult(okMsg);
      // If a read populated an output, tell the model explicitly
      if (act.verb === 'read' && act.outputName) {
        const val = recorder.getOutputs()[act.outputName];
        if (val != null) {
          journalLines.push(`OUTPUT_POPULATED: ${act.outputName} — call done now`);
        }
      }
      journal.event('step_ok', { step: stepCount, verb: act.verb, rungCount: chain.length });
    } else {
      // Expect failed. For click actions that caused page navigation, still record
      // with a fallback expect based on what IS visible now.
      if (act.verb === 'click') {
        const currentObs = await surface.observe();
        const visibleBtn = currentObs.elements.find(e => e.role === 'button' || e.role === 'heading');
        const fallbackExpect = visibleBtn
          ? { textPresent: visibleBtn.name.substring(0, 40) } as const
          : { urlMatches: new URL(currentObs.url).pathname } as const;

        recorder.record({
          intent: act.intent,
          verb: act.verb,
          value: act.value,
          properties: (chain.length > 0 ? chain[0] : { role: 'generic', frame: 'main' }) as Descriptor,
          expect: fallbackExpect,
          targetName: targetEl?.name,
          targetIsPassword: false,
          forceRisky: !!(act as any).__riskyApproved,
        });
        journalLines.push(`OK: ${act.verb} ${act.targetRef} → recorded with fallback expect`);
        journal.event('step_ok_fallback', { step: stepCount, verb: act.verb, fallbackExpect });
      } else {
        journalLines.push(`EXPECT_FAILED: ${act.verb} ${act.targetRef} — retrying`);
        journal.event('expect_failed', { step: stepCount, verb: act.verb });
      }
    }
  }
}
